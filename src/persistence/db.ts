import { chmodSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InventoryResult, InventoryStatus } from "../domain/inventory.js";
import type { ProductIdentity } from "../domain/product.js";
import type { RetailerCandidate } from "../discovery/types.js";
import type { AdapterCandidate, AdapterValidationReport } from "../generation/types.js";
import type { RetailerInspection } from "../inspection/types.js";
import type { NotificationPayload, PendingNotification } from "../notifications/types.js";
import type {
  RetailerSearchWatch,
  RetailerSearchWatchResult,
} from "../search-watches/types.js";
import type { InventoryWatch, InventoryWatchTarget } from "../watches/types.js";

export type CreateWatchRecord = {
  id: string;
  productId: string;
  product: ProductIdentity;
  targets: Array<{ id: string; domain: string; url: string; enabled: boolean }>;
  enabled: boolean;
  createdAt: string;
};

type WatchRow = {
  id: string;
  product_id: string;
  identity_json: string;
  created_at: string;
  last_discovery_at: string | null;
  enabled: number;
};

type TargetRow = {
  id: string;
  domain: string;
  url: string;
  enabled: number;
  result_json: string | null;
};

type SearchWatchRow = {
  id: string;
  domain: string;
  query: string;
  cadence_minutes: number;
  enabled: number;
  notify_on_initial_results: number;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  next_check_at: string | null;
};

function hydrateSearchWatch(row: SearchWatchRow): RetailerSearchWatch {
  return {
    id: row.id,
    domain: row.domain,
    query: row.query,
    cadenceMinutes: Number(row.cadence_minutes),
    enabled: row.enabled === 1,
    notifyOnInitialResults: row.notify_on_initial_results === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(row.next_check_at ? { nextCheckAt: row.next_check_at } : {}),
  };
}

export type InventoryDatabaseHealth = {
  schemaVersion: number;
  quickCheck: string[];
  healthy: boolean;
  fileSizeBytes: number | null;
  tableCounts: Record<string, number>;
};

export type AdapterApprovalRecord = {
  adapterId: string;
  domain: string;
  lifecycle: string;
  latestCandidateId?: string;
  latestSourceSha256?: string;
  activeCandidateId?: string;
  validationRuns: number;
  latestValidation?: { valid: boolean; promotable: boolean; validatedAt: string };
  approvalEvents: Array<{
    action: "approved" | "revoked";
    candidateId: string;
    reason?: string;
    occurredAt: string;
  }>;
};

const INVENTORY_TABLES = [
  "products",
  "retailer_candidates",
  "inventory_watches",
  "inventory_targets",
  "inventory_observations",
  "retailer_adapters",
  "adapter_versions",
  "adapter_validation_runs",
  "notifications",
  "monitor_runs",
  "slow_inspections",
  "adapter_approval_events",
  "search_watches",
  "search_watch_results",
] as const;

export class InventoryDatabase {
  readonly #database: DatabaseSync;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        const destination = lstatSync(path);
        if (destination.isSymbolicLink() || !destination.isFile()) {
          throw new Error("Inventory database path must be a regular file, not a symlink or device.");
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    this.#database = new DatabaseSync(path);
    if (path !== ":memory:") {
      const destination = lstatSync(path);
      if (destination.isSymbolicLink() || !destination.isFile()) {
        this.#database.close();
        throw new Error("Inventory database path must be a regular file, not a symlink or device.");
      }
      try { chmodSync(path, 0o600); } catch { /* Best effort on non-POSIX filesystems. */ }
    }
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close(): void {
    this.#database.close();
  }

  schemaVersion(): number {
    const row = this.#database.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  healthStatus(): InventoryDatabaseHealth {
    const quickCheck = (this.#database.prepare("PRAGMA quick_check").all() as Array<{
      quick_check: string;
    }>).map(({ quick_check }) => quick_check);
    const tableCounts = Object.fromEntries(
      INVENTORY_TABLES.map((table) => {
        const row = this.#database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        };
        return [table, Number(row.count)];
      }),
    );
    return {
      schemaVersion: this.schemaVersion(),
      quickCheck,
      healthy: quickCheck.length === 1 && quickCheck[0] === "ok",
      fileSizeBytes: this.#path === ":memory:" ? null : statSync(this.#path).size,
      tableCounts,
    };
  }

  migrate(): void {
    const version = this.#database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version.user_version > 5) {
      throw new Error(`InventoryBot database schema ${version.user_version} is newer than supported schema 5.`);
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        identity_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retailer_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        domain TEXT NOT NULL,
        url TEXT NOT NULL,
        confidence REAL NOT NULL,
        matched_by TEXT NOT NULL,
        seller_type TEXT,
        discovered_at TEXT NOT NULL,
        UNIQUE(product_id, url)
      );
      CREATE TABLE IF NOT EXISTS inventory_watches (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        last_discovery_at TEXT,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS inventory_targets (
        id TEXT PRIMARY KEY,
        watch_id TEXT NOT NULL REFERENCES inventory_watches(id) ON DELETE CASCADE,
        domain TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        UNIQUE(watch_id, url)
      );
      CREATE TABLE IF NOT EXISTS inventory_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id TEXT NOT NULL REFERENCES inventory_watches(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES inventory_targets(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        method TEXT NOT NULL,
        price REAL,
        currency TEXT,
        checked_at TEXT NOT NULL,
        adapter_id TEXT,
        adapter_version TEXT,
        duration_ms INTEGER NOT NULL,
        previous_status TEXT,
        transition_changed INTEGER NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inventory_observations_target_latest
        ON inventory_observations(target_id, id DESC);
      CREATE TABLE IF NOT EXISTS retailer_adapters (
        adapter_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        current_candidate_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adapter_versions (
        candidate_id TEXT PRIMARY KEY,
        adapter_id TEXT NOT NULL REFERENCES retailer_adapters(adapter_id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adapter_validation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL REFERENCES adapter_versions(candidate_id) ON DELETE CASCADE,
        valid INTEGER NOT NULL,
        promotable INTEGER NOT NULL,
        report_json TEXT NOT NULL,
        validated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id TEXT NOT NULL REFERENCES inventory_watches(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES inventory_targets(id) ON DELETE CASCADE,
        observation_id INTEGER REFERENCES inventory_observations(id) ON DELETE SET NULL,
        channel TEXT NOT NULL,
        transition TEXT NOT NULL,
        sent_at TEXT,
        payload_json TEXT NOT NULL
      );
    `);
    if (version.user_version < 1) this.#database.exec("PRAGMA user_version = 1;");
    if (version.user_version < 2) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE notifications ADD COLUMN fingerprint TEXT;
        ALTER TABLE notifications ADD COLUMN target TEXT;
        ALTER TABLE notifications ADD COLUMN account_id TEXT;
        ALTER TABLE notifications ADD COLUMN thread_id TEXT;
        ALTER TABLE notifications ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
        ALTER TABLE notifications ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE notifications ADD COLUMN next_attempt_at TEXT;
        ALTER TABLE notifications ADD COLUMN lease_until TEXT;
        ALTER TABLE notifications ADD COLUMN last_error TEXT;
        ALTER TABLE notifications ADD COLUMN provider_message_id TEXT;
        ALTER TABLE notifications ADD COLUMN created_at TEXT;
        ALTER TABLE notifications ADD COLUMN updated_at TEXT;
        CREATE UNIQUE INDEX notifications_fingerprint ON notifications(fingerprint);
        CREATE INDEX notifications_pending ON notifications(status, next_attempt_at, id);
        CREATE TABLE monitor_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL,
          summary_json TEXT,
          error TEXT
        );
        CREATE TABLE slow_inspections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          watch_id TEXT NOT NULL REFERENCES inventory_watches(id) ON DELETE CASCADE,
          target_id TEXT NOT NULL REFERENCES inventory_targets(id) ON DELETE CASCADE,
          inspected_at TEXT NOT NULL,
          result_json TEXT NOT NULL
        );
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
    if (version.user_version < 3) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE notifications ADD COLUMN delivery_intent_id TEXT;
        CREATE INDEX notifications_delivery_intent ON notifications(delivery_intent_id);
        PRAGMA user_version = 3;
        COMMIT;
      `);
    }
    if (version.user_version < 4) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE retailer_adapters ADD COLUMN active_candidate_id TEXT
          REFERENCES adapter_versions(candidate_id) ON DELETE SET NULL;
        CREATE TABLE adapter_approval_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          adapter_id TEXT NOT NULL REFERENCES retailer_adapters(adapter_id) ON DELETE CASCADE,
          candidate_id TEXT NOT NULL REFERENCES adapter_versions(candidate_id) ON DELETE CASCADE,
          action TEXT NOT NULL CHECK(action IN ('approved', 'revoked')),
          reason TEXT,
          occurred_at TEXT NOT NULL
        );
        CREATE INDEX adapter_approval_events_adapter
          ON adapter_approval_events(adapter_id, id DESC);
        PRAGMA user_version = 4;
        COMMIT;
      `);
    }
    if (version.user_version < 5) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE search_watches (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          query TEXT NOT NULL,
          cadence_minutes INTEGER NOT NULL CHECK(cadence_minutes >= 5),
          enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
          notify_on_initial_results INTEGER NOT NULL CHECK(notify_on_initial_results IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_checked_at TEXT,
          next_check_at TEXT
        );
        CREATE INDEX search_watches_due ON search_watches(enabled, next_check_at);
        CREATE TABLE search_watch_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          watch_id TEXT NOT NULL REFERENCES search_watches(id) ON DELETE CASCADE,
          url TEXT NOT NULL,
          title TEXT,
          snippet TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          UNIQUE(watch_id, url)
        );
        CREATE INDEX search_watch_results_recent
          ON search_watch_results(watch_id, first_seen_at DESC);
        CREATE TABLE notifications_v5 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          watch_id TEXT,
          target_id TEXT,
          observation_id INTEGER,
          channel TEXT NOT NULL,
          transition TEXT NOT NULL,
          sent_at TEXT,
          payload_json TEXT NOT NULL,
          fingerprint TEXT,
          target TEXT,
          account_id TEXT,
          thread_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          lease_until TEXT,
          last_error TEXT,
          provider_message_id TEXT,
          created_at TEXT,
          updated_at TEXT,
          delivery_intent_id TEXT,
          source_kind TEXT,
          source_id TEXT
        );
        INSERT INTO notifications_v5(
          id, watch_id, target_id, observation_id, channel, transition, sent_at,
          payload_json, fingerprint, target, account_id, thread_id, status,
          attempt_count, next_attempt_at, lease_until, last_error,
          provider_message_id, created_at, updated_at, delivery_intent_id,
          source_kind, source_id
        )
        SELECT id, watch_id, target_id, observation_id, channel, transition, sent_at,
          payload_json, fingerprint, target, account_id, thread_id, status,
          attempt_count, next_attempt_at, lease_until, last_error,
          provider_message_id, created_at, updated_at, delivery_intent_id,
          'inventory_watch', watch_id
        FROM notifications;
        DROP TABLE notifications;
        ALTER TABLE notifications_v5 RENAME TO notifications;
        CREATE UNIQUE INDEX notifications_fingerprint ON notifications(fingerprint);
        CREATE INDEX notifications_pending ON notifications(status, next_attempt_at, id);
        CREATE INDEX notifications_delivery_intent ON notifications(delivery_intent_id);
        CREATE INDEX notifications_source ON notifications(source_kind, source_id);
        PRAGMA user_version = 5;
        COMMIT;
      `);
    }
  }

  createWatch(record: CreateWatchRecord): InventoryWatch {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.prepare(
        "INSERT INTO products(id, identity_json, created_at) VALUES (?, ?, ?)",
      ).run(record.productId, JSON.stringify(record.product), record.createdAt);
      this.#database.prepare(
        "INSERT INTO inventory_watches(id, product_id, created_at, enabled) VALUES (?, ?, ?, ?)",
      ).run(record.id, record.productId, record.createdAt, record.enabled ? 1 : 0);
      const insertTarget = this.#database.prepare(
        "INSERT INTO inventory_targets(id, watch_id, domain, url, enabled) VALUES (?, ?, ?, ?, ?)",
      );
      for (const target of record.targets) {
        insertTarget.run(target.id, record.id, target.domain, target.url, target.enabled ? 1 : 0);
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return this.getWatch(record.id)!;
  }

  getWatch(id: string): InventoryWatch | undefined {
    const row = this.#database.prepare(`
      SELECT w.id, w.product_id, p.identity_json, w.created_at, w.last_discovery_at, w.enabled
      FROM inventory_watches w
      JOIN products p ON p.id = w.product_id
      WHERE w.id = ?
    `).get(id) as WatchRow | undefined;
    return row ? this.hydrateWatch(row) : undefined;
  }

  listWatches(): InventoryWatch[] {
    const rows = this.#database.prepare(`
      SELECT w.id, w.product_id, p.identity_json, w.created_at, w.last_discovery_at, w.enabled
      FROM inventory_watches w
      JOIN products p ON p.id = w.product_id
      ORDER BY w.created_at ASC
    `).all() as unknown as WatchRow[];
    return rows.map((row) => this.hydrateWatch(row));
  }

  disableWatch(id: string): boolean {
    const result = this.#database.prepare(
      "UPDATE inventory_watches SET enabled = 0 WHERE id = ? AND enabled = 1",
    ).run(id);
    return result.changes > 0;
  }

  removeWatch(id: string): boolean {
    const row = this.#database.prepare(
      "SELECT product_id FROM inventory_watches WHERE id = ?",
    ).get(id) as { product_id: string } | undefined;
    if (!row) return false;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.prepare("DELETE FROM inventory_watches WHERE id = ?").run(id);
      this.#database.prepare("DELETE FROM products WHERE id = ?").run(row.product_id);
      this.#database.exec("COMMIT;");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  createSearchWatch(watch: RetailerSearchWatch): RetailerSearchWatch {
    this.#database.prepare(`
      INSERT INTO search_watches(
        id, domain, query, cadence_minutes, enabled, notify_on_initial_results,
        created_at, updated_at, last_checked_at, next_check_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      watch.id,
      watch.domain,
      watch.query,
      watch.cadenceMinutes,
      watch.enabled ? 1 : 0,
      watch.notifyOnInitialResults ? 1 : 0,
      watch.createdAt,
      watch.updatedAt,
      watch.lastCheckedAt ?? null,
      watch.nextCheckAt ?? null,
    );
    return this.getSearchWatch(watch.id)!;
  }

  getSearchWatch(id: string): RetailerSearchWatch | undefined {
    const row = this.#database.prepare(`
      SELECT id, domain, query, cadence_minutes, enabled, notify_on_initial_results,
             created_at, updated_at, last_checked_at, next_check_at
      FROM search_watches WHERE id = ?
    `).get(id) as SearchWatchRow | undefined;
    return row ? hydrateSearchWatch(row) : undefined;
  }

  listSearchWatches(): RetailerSearchWatch[] {
    const rows = this.#database.prepare(`
      SELECT id, domain, query, cadence_minutes, enabled, notify_on_initial_results,
             created_at, updated_at, last_checked_at, next_check_at
      FROM search_watches ORDER BY created_at ASC
    `).all() as unknown as SearchWatchRow[];
    return rows.map(hydrateSearchWatch);
  }

  updateSearchWatch(
    id: string,
    changes: {
      domain?: string;
      query?: string;
      cadenceMinutes?: number;
      enabled?: boolean;
      notifyOnInitialResults?: boolean;
      updatedAt: string;
      resetBaseline?: boolean;
    },
  ): RetailerSearchWatch | undefined {
    const current = this.getSearchWatch(id);
    if (!current) return undefined;
    const resetBaseline = changes.resetBaseline === true;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.prepare(`
        UPDATE search_watches SET
          domain = ?, query = ?, cadence_minutes = ?, enabled = ?,
          notify_on_initial_results = ?, updated_at = ?,
          last_checked_at = ?, next_check_at = ?
        WHERE id = ?
      `).run(
        changes.domain ?? current.domain,
        changes.query ?? current.query,
        changes.cadenceMinutes ?? current.cadenceMinutes,
        (changes.enabled ?? current.enabled) ? 1 : 0,
        (changes.notifyOnInitialResults ?? current.notifyOnInitialResults) ? 1 : 0,
        changes.updatedAt,
        resetBaseline ? null : current.lastCheckedAt ?? null,
        resetBaseline ? null : current.nextCheckAt ?? null,
        id,
      );
      if (resetBaseline) {
        this.#database.prepare("DELETE FROM search_watch_results WHERE watch_id = ?").run(id);
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return this.getSearchWatch(id);
  }

  disableSearchWatch(id: string, updatedAt: string): boolean {
    const result = this.#database.prepare(`
      UPDATE search_watches SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1
    `).run(updatedAt, id);
    return result.changes > 0;
  }

  removeSearchWatch(id: string): boolean {
    return this.#database.prepare("DELETE FROM search_watches WHERE id = ?").run(id).changes > 0;
  }

  listSearchWatchResults(watchId: string, limit = 50): RetailerSearchWatchResult[] {
    const rows = this.#database.prepare(`
      SELECT url, title, snippet, first_seen_at, last_seen_at
      FROM search_watch_results WHERE watch_id = ?
      ORDER BY first_seen_at DESC LIMIT ?
    `).all(watchId, limit) as unknown as Array<{
      url: string;
      title: string | null;
      snippet: string | null;
      first_seen_at: string;
      last_seen_at: string;
    }>;
    return rows.map((row) => ({
      url: row.url,
      ...(row.title ? { title: row.title } : {}),
      ...(row.snippet ? { snippet: row.snippet } : {}),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  recordSearchWatchResults(input: {
    watchId: string;
    results: Array<{ url: string; title?: string; snippet?: string }>;
    checkedAt: string;
    nextCheckAt: string;
  }): RetailerSearchWatchResult[] {
    const existing = this.#database.prepare(
      "SELECT 1 AS found FROM search_watch_results WHERE watch_id = ? AND url = ?",
    );
    const upsert = this.#database.prepare(`
      INSERT INTO search_watch_results(watch_id, url, title, snippet, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(watch_id, url) DO UPDATE SET
        title = excluded.title,
        snippet = excluded.snippet,
        last_seen_at = excluded.last_seen_at
    `);
    const added: RetailerSearchWatchResult[] = [];
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const result of input.results) {
        const isNew = !existing.get(input.watchId, result.url);
        upsert.run(
          input.watchId,
          result.url,
          result.title ?? null,
          result.snippet ?? null,
          input.checkedAt,
          input.checkedAt,
        );
        if (isNew) {
          added.push({
            ...result,
            firstSeenAt: input.checkedAt,
            lastSeenAt: input.checkedAt,
          });
        }
      }
      this.#database.prepare(`
        UPDATE search_watches SET last_checked_at = ?, next_check_at = ?, updated_at = ?
        WHERE id = ?
      `).run(input.checkedAt, input.nextCheckAt, input.checkedAt, input.watchId);
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return added;
  }

  enqueueNotification(input: {
    sourceKind: string;
    sourceId: string;
    fingerprint: string;
    channel: string;
    target: string;
    accountId?: string;
    threadId?: string;
    transition: string;
    payload: NotificationPayload;
    createdAt: string;
  }): boolean {
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO notifications(
        watch_id, target_id, observation_id, channel, transition, sent_at,
        payload_json, fingerprint, target, account_id, thread_id, status,
        attempt_count, next_attempt_at, created_at, updated_at, source_kind, source_id
      ) VALUES (NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
    `).run(
      input.channel,
      input.transition,
      JSON.stringify(input.payload),
      input.fingerprint,
      input.target,
      input.accountId ?? null,
      input.threadId ?? null,
      input.createdAt,
      input.createdAt,
      input.createdAt,
      input.sourceKind,
      input.sourceId,
    );
    return result.changes > 0;
  }

  latestStatus(targetId: string): InventoryStatus | undefined {
    const row = this.#database.prepare(
      "SELECT status FROM inventory_observations WHERE target_id = ? ORDER BY id DESC LIMIT 1",
    ).get(targetId) as { status: InventoryStatus } | undefined;
    return row?.status;
  }

  recordObservation(input: {
    watchId: string;
    productId: string;
    targetId: string;
    result: InventoryResult;
    adapterId?: string;
    adapterVersion?: string;
    durationMs: number;
    previousStatus?: InventoryStatus;
    transitionChanged: boolean;
    notification?: {
      channel: string;
      target: string;
      accountId?: string;
      threadId?: string;
      payload: NotificationPayload;
    };
  }): number {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const inserted = this.#database.prepare(`
        INSERT INTO inventory_observations(
          watch_id, product_id, target_id, status, confidence, method, price, currency,
          checked_at, adapter_id, adapter_version, duration_ms, previous_status,
          transition_changed, result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.watchId,
        input.productId,
        input.targetId,
        input.result.status,
        input.result.confidence,
        input.result.method,
        input.result.price ?? null,
        input.result.currency ?? null,
        input.result.checkedAt,
        input.adapterId ?? null,
        input.adapterVersion ?? null,
        input.durationMs,
        input.previousStatus ?? null,
        input.transitionChanged ? 1 : 0,
        JSON.stringify(input.result),
      );
      const observationId = Number(inserted.lastInsertRowid);
      if (input.notification) {
        const createdAt = input.result.checkedAt;
        this.#database.prepare(`
          INSERT OR IGNORE INTO notifications(
            watch_id, target_id, observation_id, channel, transition, sent_at,
            payload_json, fingerprint, target, account_id, thread_id, status,
            attempt_count, next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        `).run(
          input.watchId,
          input.targetId,
          observationId,
          input.notification.channel,
          `${input.previousStatus ?? "unobserved"}->${input.result.status}`,
          JSON.stringify(input.notification.payload),
          `${input.watchId}:${input.targetId}:${observationId}`,
          input.notification.target,
          input.notification.accountId ?? null,
          input.notification.threadId ?? null,
          createdAt,
          createdAt,
          createdAt,
        );
      }
      this.#database.exec("COMMIT;");
      return observationId;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  claimNotifications(input: { now: string; limit: number; leaseMs: number }): PendingNotification[] {
    const leaseUntil = new Date(new Date(input.now).getTime() + input.leaseMs).toISOString();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const rows = this.#database.prepare(`
        SELECT id, fingerprint, channel, target, account_id, thread_id, payload_json, attempt_count
        FROM notifications
        WHERE fingerprint IS NOT NULL AND target IS NOT NULL AND (
          (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR
          (status = 'processing' AND lease_until <= ?)
        )
        ORDER BY id ASC
        LIMIT ?
      `).all(input.now, input.now, input.limit) as unknown as Array<{
        id: number;
        fingerprint: string;
        channel: string;
        target: string;
        account_id: string | null;
        thread_id: string | null;
        payload_json: string;
        attempt_count: number;
      }>;
      const claim = this.#database.prepare(`
        UPDATE notifications
        SET status = 'processing', attempt_count = attempt_count + 1,
            lease_until = ?, updated_at = ?
        WHERE id = ?
      `);
      for (const row of rows) claim.run(leaseUntil, input.now, row.id);
      this.#database.exec("COMMIT;");
      return rows.map((row) => ({
        id: row.id,
        fingerprint: row.fingerprint,
        channel: row.channel,
        target: row.target,
        ...(row.account_id ? { accountId: row.account_id } : {}),
        ...(row.thread_id ? { threadId: row.thread_id } : {}),
        payload: JSON.parse(row.payload_json) as NotificationPayload,
        attemptCount: row.attempt_count + 1,
      }));
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  markNotificationSent(
    id: number,
    providerMessageId: string,
    sentAt: string,
    deliveryIntentId?: string,
  ): void {
    this.#database.prepare(`
      UPDATE notifications
      SET status = 'sent', sent_at = ?, provider_message_id = ?, delivery_intent_id = ?,
          lease_until = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(sentAt, providerMessageId, deliveryIntentId ?? null, sentAt, id);
  }

  markNotificationHandedOff(id: number, input: {
    deliveryIntentId: string;
    error?: string;
    updatedAt: string;
  }): void {
    this.#database.prepare(`
      UPDATE notifications
      SET status = 'handed_off', delivery_intent_id = ?, lease_until = NULL,
          next_attempt_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(
      input.deliveryIntentId,
      input.error?.slice(0, 2_000) ?? null,
      input.updatedAt,
      id,
    );
  }

  markNotificationSuppressed(id: number, input: {
    deliveryIntentId?: string;
    reason: string;
    updatedAt: string;
  }): void {
    this.#database.prepare(`
      UPDATE notifications
      SET status = 'suppressed', delivery_intent_id = ?, lease_until = NULL,
          next_attempt_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(
      input.deliveryIntentId ?? null,
      input.reason.slice(0, 2_000),
      input.updatedAt,
      id,
    );
  }

  markNotificationFailed(id: number, input: {
    error: string;
    terminal: boolean;
    nextAttemptAt: string;
    updatedAt: string;
  }): void {
    this.#database.prepare(`
      UPDATE notifications
      SET status = ?, next_attempt_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(
      input.terminal ? "failed" : "pending",
      input.nextAttemptAt,
      input.error.slice(0, 2_000),
      input.updatedAt,
      id,
    );
  }

  notificationStatus(): {
    pending: number;
    processing: number;
    handedOff: number;
    sent: number;
    suppressed: number;
    failed: number;
  } {
    const rows = this.#database.prepare(`
      SELECT status, COUNT(*) AS count FROM notifications GROUP BY status
    `).all() as unknown as Array<{ status: string; count: number }>;
    const counts = {
      pending: 0,
      processing: 0,
      handedOff: 0,
      sent: 0,
      suppressed: 0,
      failed: 0,
    };
    for (const row of rows) {
      const key = row.status === "handed_off" ? "handedOff" : row.status;
      if (key in counts) counts[key as keyof typeof counts] = Number(row.count);
    }
    return counts;
  }

  startMonitorRun(kind: "fast" | "slow" | "search", startedAt: string): number {
    const result = this.#database.prepare(`
      INSERT INTO monitor_runs(kind, started_at, status) VALUES (?, ?, 'running')
    `).run(kind, startedAt);
    return Number(result.lastInsertRowid);
  }

  completeMonitorRun(
    id: number,
    input: { completedAt: string; summary?: unknown; error?: string },
  ): void {
    this.#database.prepare(`
      UPDATE monitor_runs
      SET completed_at = ?, status = ?, summary_json = ?, error = ?
      WHERE id = ?
    `).run(
      input.completedAt,
      input.error ? "error" : "completed",
      input.summary === undefined ? null : JSON.stringify(input.summary),
      input.error?.slice(0, 4_000) ?? null,
      id,
    );
  }

  monitorStatus(): Array<{
    kind: string;
    startedAt: string;
    completedAt?: string;
    status: string;
    summary?: unknown;
    error?: string;
  }> {
    const rows = this.#database.prepare(`
      SELECT r.kind, r.started_at, r.completed_at, r.status, r.summary_json, r.error
      FROM monitor_runs r
      JOIN (SELECT kind, MAX(id) AS id FROM monitor_runs GROUP BY kind) latest
        ON latest.id = r.id
      ORDER BY r.kind
    `).all() as unknown as Array<{
      kind: string;
      started_at: string;
      completed_at: string | null;
      status: string;
      summary_json: string | null;
      error: string | null;
    }>;
    return rows.map((row) => ({
      kind: row.kind,
      startedAt: row.started_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      status: row.status,
      ...(row.summary_json ? { summary: JSON.parse(row.summary_json) as unknown } : {}),
      ...(row.error ? { error: row.error } : {}),
    }));
  }

  saveRetailerCandidates(productId: string, candidates: RetailerCandidate[], discoveredAt: string): void {
    const insert = this.#database.prepare(`
      INSERT INTO retailer_candidates(
        product_id, domain, url, confidence, matched_by, seller_type, discovered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id, url) DO UPDATE SET
        confidence = excluded.confidence,
        matched_by = excluded.matched_by,
        seller_type = excluded.seller_type,
        discovered_at = excluded.discovered_at
    `);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const candidate of candidates) {
        insert.run(
          productId,
          candidate.domain,
          candidate.url,
          candidate.confidence,
          candidate.matchedBy,
          candidate.sellerType ?? null,
          discoveredAt,
        );
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  markWatchDiscovered(watchId: string, discoveredAt: string): void {
    this.#database.prepare(`
      UPDATE inventory_watches SET last_discovery_at = ? WHERE id = ?
    `).run(discoveredAt, watchId);
  }

  recentStatuses(targetId: string, limit: number): InventoryStatus[] {
    const rows = this.#database.prepare(`
      SELECT status FROM inventory_observations
      WHERE target_id = ? ORDER BY id DESC LIMIT ?
    `).all(targetId, limit) as unknown as Array<{ status: InventoryStatus }>;
    return rows.map(({ status }) => status);
  }

  recordSlowInspection(watchId: string, targetId: string, inspection: RetailerInspection): void {
    this.#database.prepare(`
      INSERT INTO slow_inspections(watch_id, target_id, inspected_at, result_json)
      VALUES (?, ?, ?, ?)
    `).run(watchId, targetId, inspection.inventory.checkedAt, JSON.stringify(inspection));
  }

  saveAdapterCandidate(candidate: AdapterCandidate): void {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.prepare(`
        INSERT INTO retailer_adapters(adapter_id, domain, lifecycle, current_candidate_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(adapter_id) DO UPDATE SET
          domain = excluded.domain,
          lifecycle = CASE
            WHEN retailer_adapters.active_candidate_id IS NULL THEN excluded.lifecycle
            ELSE 'active'
          END,
          current_candidate_id = excluded.current_candidate_id,
          updated_at = excluded.updated_at
      `).run(
        candidate.spec.adapterId,
        candidate.spec.domain,
        candidate.lifecycle,
        candidate.candidateId,
        candidate.generatedAt,
      );
      this.#database.prepare(`
        INSERT INTO adapter_versions(
          candidate_id, adapter_id, version, source_sha256, source, candidate_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(candidate_id) DO NOTHING
      `).run(
        candidate.candidateId,
        candidate.spec.adapterId,
        candidate.spec.version,
        candidate.sourceSha256,
        candidate.source,
        JSON.stringify(candidate),
        candidate.generatedAt,
      );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  getAdapterAudit(adapterId: string): {
    lifecycle: string;
    candidateId?: string;
    validationRuns: number;
  } | undefined {
    const row = this.#database.prepare(`
      SELECT lifecycle, current_candidate_id FROM retailer_adapters WHERE adapter_id = ?
    `).get(adapterId) as { lifecycle: string; current_candidate_id: string | null } | undefined;
    if (!row) return undefined;
    const count = this.#database.prepare(`
      SELECT COUNT(*) AS count
      FROM adapter_validation_runs r
      JOIN adapter_versions v ON v.candidate_id = r.candidate_id
      WHERE v.adapter_id = ?
    `).get(adapterId) as { count: number };
    return {
      lifecycle: row.lifecycle,
      ...(row.current_candidate_id ? { candidateId: row.current_candidate_id } : {}),
      validationRuns: Number(count.count),
    };
  }

  saveValidation(candidate: AdapterCandidate, report: AdapterValidationReport): void {
    this.saveAdapterCandidate(candidate);
    this.#database.prepare(`
      INSERT INTO adapter_validation_runs(
        candidate_id, valid, promotable, report_json, validated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      candidate.candidateId,
      report.valid ? 1 : 0,
      report.promotable ? 1 : 0,
      JSON.stringify(report),
      report.validatedAt,
    );
    this.#database.prepare(`
      UPDATE retailer_adapters SET
        lifecycle = CASE WHEN active_candidate_id IS NULL THEN ? ELSE 'active' END,
        updated_at = ?
      WHERE adapter_id = ?
    `).run(report.lifecycle, report.validatedAt, candidate.spec.adapterId);
  }

  getAdapterCandidate(candidateId: string): AdapterCandidate | undefined {
    const row = this.#database.prepare(`
      SELECT candidate_json FROM adapter_versions WHERE candidate_id = ?
    `).get(candidateId) as { candidate_json: string } | undefined;
    return row ? JSON.parse(row.candidate_json) as AdapterCandidate : undefined;
  }

  listActiveAdapterCandidates(): AdapterCandidate[] {
    const rows = this.#database.prepare(`
      SELECT v.candidate_json
      FROM retailer_adapters a
      JOIN adapter_versions v ON v.candidate_id = a.active_candidate_id
      WHERE a.lifecycle = 'active'
      ORDER BY a.adapter_id ASC
    `).all() as unknown as Array<{ candidate_json: string }>;
    return rows.map(({ candidate_json }) => JSON.parse(candidate_json) as AdapterCandidate);
  }

  listAdapterApprovals(adapterId?: string): AdapterApprovalRecord[] {
    const rows = this.#database.prepare(`
      SELECT a.adapter_id, a.domain, a.lifecycle, a.current_candidate_id,
             a.active_candidate_id,
             (SELECT source_sha256 FROM adapter_versions v
              WHERE v.candidate_id = a.current_candidate_id) AS latest_source_sha256,
             (SELECT COUNT(*) FROM adapter_validation_runs r
              JOIN adapter_versions v ON v.candidate_id = r.candidate_id
              WHERE v.adapter_id = a.adapter_id) AS validation_runs
      FROM retailer_adapters a
      WHERE (? IS NULL OR a.adapter_id = ?)
      ORDER BY a.adapter_id ASC
    `).all(adapterId ?? null, adapterId ?? null) as unknown as Array<{
      adapter_id: string;
      domain: string;
      lifecycle: string;
      current_candidate_id: string | null;
      active_candidate_id: string | null;
      latest_source_sha256: string | null;
      validation_runs: number;
    }>;
    return rows.map((row) => {
      const validation = row.current_candidate_id
        ? this.#database.prepare(`
            SELECT valid, promotable, validated_at
            FROM adapter_validation_runs WHERE candidate_id = ? ORDER BY id DESC LIMIT 1
          `).get(row.current_candidate_id) as {
            valid: number;
            promotable: number;
            validated_at: string;
          } | undefined
        : undefined;
      const events = this.#database.prepare(`
        SELECT action, candidate_id, reason, occurred_at
        FROM adapter_approval_events WHERE adapter_id = ? ORDER BY id DESC
      `).all(row.adapter_id) as unknown as Array<{
        action: "approved" | "revoked";
        candidate_id: string;
        reason: string | null;
        occurred_at: string;
      }>;
      return {
        adapterId: row.adapter_id,
        domain: row.domain,
        lifecycle: row.lifecycle,
        ...(row.current_candidate_id ? { latestCandidateId: row.current_candidate_id } : {}),
        ...(row.latest_source_sha256 ? { latestSourceSha256: row.latest_source_sha256 } : {}),
        ...(row.active_candidate_id ? { activeCandidateId: row.active_candidate_id } : {}),
        validationRuns: Number(row.validation_runs),
        ...(validation ? {
          latestValidation: {
            valid: validation.valid === 1,
            promotable: validation.promotable === 1,
            validatedAt: validation.validated_at,
          },
        } : {}),
        approvalEvents: events.map((event) => ({
          action: event.action,
          candidateId: event.candidate_id,
          ...(event.reason ? { reason: event.reason } : {}),
          occurredAt: event.occurred_at,
        })),
      };
    });
  }

  approveAdapterCandidate(input: {
    candidateId: string;
    sourceSha256: string;
    approvedAt: string;
    reason?: string;
  }): AdapterCandidate {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.#database.prepare(`
        SELECT v.adapter_id, v.source_sha256, v.candidate_json,
               (SELECT valid FROM adapter_validation_runs r
                WHERE r.candidate_id = v.candidate_id ORDER BY r.id DESC LIMIT 1) AS valid,
               (SELECT promotable FROM adapter_validation_runs r
                WHERE r.candidate_id = v.candidate_id ORDER BY r.id DESC LIMIT 1) AS promotable
        FROM adapter_versions v WHERE v.candidate_id = ?
      `).get(input.candidateId) as {
        adapter_id: string;
        source_sha256: string;
        candidate_json: string;
        valid: number | null;
        promotable: number | null;
      } | undefined;
      if (!row) throw new Error("ADAPTER_CANDIDATE_NOT_FOUND");
      if (row.source_sha256 !== input.sourceSha256) throw new Error("ADAPTER_SOURCE_HASH_MISMATCH");
      if (row.valid !== 1 || row.promotable !== 1) throw new Error("ADAPTER_NOT_PROMOTABLE");
      this.#database.prepare(`
        UPDATE retailer_adapters
        SET lifecycle = 'active', active_candidate_id = ?, updated_at = ?
        WHERE adapter_id = ?
      `).run(input.candidateId, input.approvedAt, row.adapter_id);
      this.#database.prepare(`
        INSERT INTO adapter_approval_events(adapter_id, candidate_id, action, reason, occurred_at)
        VALUES (?, ?, 'approved', ?, ?)
      `).run(row.adapter_id, input.candidateId, input.reason ?? null, input.approvedAt);
      this.#database.exec("COMMIT;");
      return JSON.parse(row.candidate_json) as AdapterCandidate;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  revokeAdapterCandidate(input: {
    adapterId: string;
    candidateId: string;
    revokedAt: string;
    reason?: string;
  }): void {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.#database.prepare(`
        SELECT active_candidate_id FROM retailer_adapters WHERE adapter_id = ?
      `).get(input.adapterId) as { active_candidate_id: string | null } | undefined;
      if (!row) throw new Error("ADAPTER_NOT_FOUND");
      if (row.active_candidate_id !== input.candidateId) throw new Error("ADAPTER_ACTIVE_VERSION_MISMATCH");
      this.#database.prepare(`
        UPDATE retailer_adapters
        SET lifecycle = 'disabled', active_candidate_id = NULL, updated_at = ?
        WHERE adapter_id = ?
      `).run(input.revokedAt, input.adapterId);
      this.#database.prepare(`
        INSERT INTO adapter_approval_events(adapter_id, candidate_id, action, reason, occurred_at)
        VALUES (?, ?, 'revoked', ?, ?)
      `).run(input.adapterId, input.candidateId, input.reason ?? null, input.revokedAt);
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  private hydrateWatch(row: WatchRow): InventoryWatch {
    const targetRows = this.#database.prepare(`
      SELECT t.id, t.domain, t.url, t.enabled,
        (SELECT result_json FROM inventory_observations o
         WHERE o.target_id = t.id ORDER BY o.id DESC LIMIT 1) AS result_json
      FROM inventory_targets t
      WHERE t.watch_id = ?
      ORDER BY t.id ASC
    `).all(row.id) as unknown as TargetRow[];
    const retailers: InventoryWatchTarget[] = targetRows.map((target) => ({
      id: target.id,
      domain: target.domain,
      url: target.url,
      enabled: target.enabled === 1,
      ...(target.result_json ? { latestResult: JSON.parse(target.result_json) as InventoryResult } : {}),
    }));
    return {
      id: row.id,
      productId: row.product_id,
      product: JSON.parse(row.identity_json) as ProductIdentity,
      retailers,
      createdAt: row.created_at,
      ...(row.last_discovery_at ? { lastDiscoveryAt: row.last_discovery_at } : {}),
      enabled: row.enabled === 1,
    };
  }
}
