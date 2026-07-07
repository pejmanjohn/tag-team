/**
 * Minimal ambient declaration for 'cloudflare:workers', scoped to exactly the
 * surface src/cloudflare.ts uses. The alternative — @cloudflare/workers-types —
 * injects a full global DOM-overlapping type universe into the NODE tsc run
 * (this repo typechecks both lanes in one pass), so we declare the handful of
 * shapes we touch instead. The real module exists only on the Cloudflare
 * target; the node build never imports src/cloudflare.ts at runtime.
 *
 * Shapes follow the Workers runtime API (verified against the DO-store spike
 * and the SELECT changes()/rowsWritten probe, 2026-07-06).
 */
declare module 'cloudflare:workers' {
  /** One row from `SqlStorage.exec` — column name to SQLite value. */
  type SqlRow = Record<string, string | number | ArrayBuffer | null>;

  interface SqlStorageCursor {
    toArray(): SqlRow[];
    /** Exactly one row or it throws — use only for queries that guarantee it. */
    one(): SqlRow;
    /**
     * Rows written so far by this statement. NOT SQLite `changes()`: it counts
     * index writes too (a single INSERT into a table with a PRIMARY KEY
     * reports 2) — measured, which is why the StateDb adapter derives
     * `changes` from `SELECT changes()` instead.
     */
    rowsWritten: number;
    rowsRead: number;
  }

  interface SqlStorage {
    /** Synchronous inside a DO; bindings use `?` placeholders. */
    exec(query: string, ...bindings: unknown[]): SqlStorageCursor;
  }

  interface DurableObjectStorage {
    sql: SqlStorage;
    /** Synchronous transaction; rolls back when `fn` throws. */
    transactionSync<T>(fn: () => T): T;
  }

  interface DurableObjectState {
    storage: DurableObjectStorage;
    id: { toString(): string };
  }

  abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
