import { openStateDb, resolveStateDbPath, type NodeStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';

/**
 * Operator settings persisted by the app itself — key/value strings written
 * from /admin (the first-run Slack-connection wizard stores bot token, signing
 * secret, and bot user id here as 'slack.*' keys). Environment variables take
 * precedence over stored settings at the resolution layer, so a `wrangler
 * secret put` / .env value always wins; this store is the fallback for
 * installs configured entirely through the browser.
 */
export interface SettingsStore {
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  /** Node backend only (closes the SQLite handle); absent on RPC proxies. */
  close?(): void;
}

interface SettingRow {
  value: string;
}

/**
 * Target-neutral settings logic over the StateDb mini-interface — shared by
 * the Node backend and the Cloudflare Durable Object. Methods are synchronous;
 * the async public interface wraps them.
 */
export class SettingsStoreLogic {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
  }

  getSetting(key: string): string | undefined {
    const row = this.db.get('SELECT value FROM app_settings WHERE key = ?', key) as
      | SettingRow
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      this.now(),
    );
  }

  deleteSetting(key: string): void {
    this.db.run('DELETE FROM app_settings WHERE key = ?', key);
  }
}

/** Node backend: the target-neutral logic over `node:sqlite`, async-wrapped. */
export class SqliteSettingsStore implements SettingsStore {
  private readonly db: NodeStateDb;
  private readonly logic: SettingsStoreLogic;

  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    this.db = openStateDb(path);
    this.logic = new SettingsStoreLogic(this.db, now);
  }

  close(): void {
    this.db.close();
  }

  async getSetting(key: string): Promise<string | undefined> {
    return this.logic.getSetting(key);
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.logic.setSetting(key, value);
  }

  async deleteSetting(key: string): Promise<void> {
    this.logic.deleteSetting(key);
  }
}
