import { DurableObject, type DurableObjectState, type DurableObjectStorage } from 'cloudflare:workers';

import {
  AgentExistsError,
  AgentStillAssignedError,
  UnknownAgentError,
} from './config/errors.ts';
import type { AssignmentLookupOptions } from './config/resolver.ts';
import { SettingsStoreLogic } from './config/settings-store.ts';
import { SnapshotStoreLogic } from './config/snapshot-store.ts';
import type { StateRpcResult, TagStateRpc } from './config/state-rpc.ts';
import { ConfigStoreLogic, type ConfigAgentPatch } from './config/store.ts';
import type { AgentSnapshot, ChannelAssignment, CustomAgentConfig } from './config/types.ts';
import { SlackStateLogic } from './slack/claim-store.ts';
import type { SqlParam, StateDb } from './state/state-db.ts';

/**
 * Cloudflare entrypoint. Named exports of this file become top-level Worker
 * exports on the CF target (the node target never imports it), so this is the
 * ONE module allowed to import 'cloudflare:workers'.
 *
 * TagStateStore is the app-owned state Durable Object: a single named instance
 * (state-rpc.ts TAG_STATE_INSTANCE) hosts all four store domains — config
 * agents/assignments, thread snapshots, Slack claims + thread registry, and
 * operator settings — by running the SAME target-neutral store logic classes
 * the node backend runs, over DO SQLite instead of node:sqlite. Binding and
 * migration live in wrangler.jsonc (TAG_STATE / migrations v2).
 */

/**
 * StateDb over a Durable Object's synchronous SQL storage.
 *
 * `changes` is derived from `SELECT changes()` — NOT the cursor's
 * `rowsWritten`, which counts index writes too (a single INSERT into a table
 * with a PRIMARY KEY reports rowsWritten=2; measured on workerd 2026-07-06).
 * The store logic's write-once semantics (claims, snapshot putIfAbsent,
 * createAgent) depend on exact SQLite changes semantics, which changes()
 * returns (1/0) both standalone and inside transactionSync.
 */
class DoSqlStateDb implements StateDb {
  constructor(private readonly storage: DurableObjectStorage) {}

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    // Drain the write cursor before reading changes(): cursors execute
    // incrementally, and changes() must observe the completed statement.
    this.storage.sql.exec(sql, ...params).toArray();
    const row = this.storage.sql.exec('SELECT changes() AS changes').one();
    return { changes: Number(row.changes) };
  }

  get(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined {
    return this.storage.sql.exec(sql, ...params).toArray()[0];
  }

  all(sql: string, ...params: SqlParam[]): Record<string, unknown>[] {
    return this.storage.sql.exec(sql, ...params).toArray();
  }

  exec(sql: string): void {
    // Single statements only (the StateDb contract) — DO SQLite rejects
    // multi-statement strings, which is exactly why the contract exists.
    this.storage.sql.exec(sql).toArray();
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

interface TagStateStores {
  config: ConfigStoreLogic;
  snapshots: SnapshotStoreLogic;
  slack: SlackStateLogic;
  settings: SettingsStoreLogic;
}

export class TagStateStore extends DurableObject implements TagStateRpc {
  private stores: TagStateStores | undefined;
  /**
   * Constructor failures are latched instead of thrown: a throwing DO
   * constructor makes EVERY subsequent RPC fail with an opaque platform 500.
   * Latching turns that into a clear `{ok:false}` envelope per call (and a
   * fresh construction attempt on the next isolate) that the proxies surface
   * as a normal store error.
   */
  private initError: string | undefined;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    try {
      const db = new DoSqlStateDb(ctx.storage);
      // Same construction order as the node backend: each logic class creates
      // its own tables (and the config store runs migrations + seedOnce), so a
      // fresh DO is fully seeded before it answers its first RPC.
      this.stores = {
        config: new ConfigStoreLogic(db),
        snapshots: new SnapshotStoreLogic(db),
        slack: new SlackStateLogic(db),
        settings: new SettingsStoreLogic(db),
      };
    } catch (err) {
      this.initError = err instanceof Error ? err.message : String(err);
      console.error('[tag-team] TagStateStore init failed:', this.initError);
    }
  }

  // ── config: agents ───────────────────────────────────────────────────────

  async configListAgents(): Promise<StateRpcResult<CustomAgentConfig[]>> {
    return this.call((stores) => stores.config.listAgents());
  }

  async configGetAgent(agentId: string): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.getAgent(agentId));
  }

  async configCreateAgent(agent: CustomAgentConfig): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.createAgent(agent));
  }

  async configUpdateAgent(
    agentId: string,
    patch: ConfigAgentPatch,
  ): Promise<StateRpcResult<CustomAgentConfig>> {
    return this.call((stores) => stores.config.updateAgent(agentId, patch));
  }

  async configDeleteAgent(agentId: string): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.deleteAgent(agentId));
  }

  // ── config: assignments ──────────────────────────────────────────────────

  async configListAssignments(): Promise<StateRpcResult<ChannelAssignment[]>> {
    return this.call((stores) => stores.config.listAssignments());
  }

  async configGetAssignment(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<ChannelAssignment | null>> {
    return this.call((stores) => stores.config.getAssignment(workspaceId, channelId) ?? null);
  }

  async configListAssignmentsForAgent(
    agentId: string,
  ): Promise<StateRpcResult<ChannelAssignment[]>> {
    return this.call((stores) => stores.config.listAssignmentsForAgent(agentId));
  }

  async configPutAssignment(
    assignment: ChannelAssignment,
  ): Promise<StateRpcResult<ChannelAssignment>> {
    return this.call((stores) => stores.config.putAssignment(assignment));
  }

  async configDeleteAssignment(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.config.deleteAssignment(workspaceId, channelId));
  }

  async configFind(
    workspaceId: string,
    channelId: string,
    options?: AssignmentLookupOptions,
  ): Promise<StateRpcResult<ChannelAssignment | null>> {
    return this.call((stores) => stores.config.find(workspaceId, channelId, options) ?? null);
  }

  // ── agent snapshots ──────────────────────────────────────────────────────

  async snapshotGet(threadKey: string): Promise<StateRpcResult<AgentSnapshot | null>> {
    return this.call((stores) => stores.snapshots.get(threadKey) ?? null);
  }

  async snapshotPutIfAbsent(
    threadKey: string,
    snapshot: AgentSnapshot,
  ): Promise<StateRpcResult<AgentSnapshot>> {
    return this.call((stores) => stores.snapshots.putIfAbsent(threadKey, snapshot));
  }

  // ── slack claims + thread registry ───────────────────────────────────────

  async claim(key: string): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.slack.claim(key));
  }

  async release(key: string): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.slack.release(key);
      return null;
    });
  }

  async threadStart(key: string): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.slack.start(key);
      return null;
    });
  }

  async threadHas(key: string): Promise<StateRpcResult<boolean>> {
    return this.call((stores) => stores.slack.has(key));
  }

  // ── operator settings ────────────────────────────────────────────────────

  async settingGet(key: string): Promise<StateRpcResult<string | null>> {
    return this.call((stores) => stores.settings.getSetting(key) ?? null);
  }

  async settingSet(key: string, value: string): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.settings.setSetting(key, value);
      return null;
    });
  }

  async settingDelete(key: string): Promise<StateRpcResult<null>> {
    return this.call((stores) => {
      stores.settings.deleteSetting(key);
      return null;
    });
  }

  /**
   * Run one store operation and map the outcome onto the RPC envelope. Typed
   * domain errors become stable codes with their constructor args so the
   * proxies (cf-state-proxies.ts) re-throw the SAME instanceof-able errors the
   * node backend throws; anything else is an internal failure with the message
   * preserved for server-side logs.
   */
  private call<T>(fn: (stores: TagStateStores) => T): StateRpcResult<T> {
    if (!this.stores) {
      return {
        ok: false,
        error: {
          code: 'internal',
          message: `state store unavailable: init failed (${this.initError ?? 'unknown'})`,
        },
      };
    }
    try {
      return { ok: true, value: fn(this.stores) };
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return rpcError('unknown_agent', err.message, { agentId: err.agentId });
      }
      if (err instanceof AgentExistsError) {
        return rpcError('agent_exists', err.message, { agentId: err.agentId });
      }
      if (err instanceof AgentStillAssignedError) {
        return rpcError('agent_still_assigned', err.message, {
          agentId: err.agentId,
          keys: err.keys,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[tag-team] TagStateStore RPC failure:', message);
      return rpcError('internal', message);
    }
  }
}

function rpcError(
  code: 'unknown_agent' | 'agent_exists' | 'agent_still_assigned' | 'internal',
  message: string,
  details?: Record<string, string>,
): { ok: false; error: { code: typeof code; message: string; details?: Record<string, string> } } {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}
