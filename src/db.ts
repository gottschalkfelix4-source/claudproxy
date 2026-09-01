import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, "proxy.db"));

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS api_keys (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  key_hash           TEXT NOT NULL UNIQUE,
  key_prefix         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  expires_at         INTEGER,
  enabled            INTEGER NOT NULL DEFAULT 1,
  rate_limit_per_min INTEGER,
  budget_usd         REAL,
  spent_usd          REAL NOT NULL DEFAULT 0,
  allowed_models     TEXT,
  note               TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id            TEXT,
  ts                INTEGER NOT NULL,
  model             TEXT,
  resolved_model    TEXT,
  engine            TEXT,
  status            INTEGER,
  streamed          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  ip                TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_ts     ON requests (ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_key_ts ON requests (key_id, ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as unknown as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Reads a setting, generating and persisting a random value on first use. */
export function getOrCreateSecret(key: string): string {
  const existing = getSetting(key);
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString("hex");
  setSetting(key, secret);
  return secret;
}

/* ------------------------------------------------------------------ */
/* api keys                                                            */
/* ------------------------------------------------------------------ */

export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  enabled: number;
  rate_limit_per_min: number | null;
  budget_usd: number | null;
  spent_usd: number;
  allowed_models: string | null;
  note: string | null;
}

export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
}

export interface CreateKeyInput {
  name: string;
  expiresAt?: number | null;
  rateLimitPerMin?: number | null;
  budgetUsd?: number | null;
  allowedModels?: string[] | null;
  note?: string | null;
}

/** Creates a key and returns the raw secret, which is never stored and never shown again. */
export function createApiKey(input: CreateKeyInput): { row: ApiKeyRow; rawKey: string } {
  const id = crypto.randomUUID();
  const rawKey = "sk-cp-" + crypto.randomBytes(24).toString("base64url");
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  db.prepare(
    `INSERT INTO api_keys
       (id, name, key_hash, key_prefix, created_at, expires_at, enabled,
        rate_limit_per_min, budget_usd, allowed_models, note)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    keyHash,
    keyPrefix,
    Date.now(),
    input.expiresAt ?? null,
    input.rateLimitPerMin ?? null,
    input.budgetUsd ?? null,
    input.allowedModels && input.allowedModels.length ? JSON.stringify(input.allowedModels) : null,
    input.note ?? null,
  );

  return { row: getApiKeyById(id)!, rawKey };
}

export function getApiKeyById(id: string): ApiKeyRow | undefined {
  return db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as unknown as
    | ApiKeyRow
    | undefined;
}

export function getApiKeyByHash(keyHash: string): ApiKeyRow | undefined {
  return db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash) as unknown as
    | ApiKeyRow
    | undefined;
}

export function listApiKeys(): ApiKeyRow[] {
  return db
    .prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
    .all() as unknown as ApiKeyRow[];
}

export function deleteApiKey(id: string): void {
  db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
}

export function updateApiKey(
  id: string,
  patch: Partial<CreateKeyInput & { enabled: boolean }>,
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    sets.push("name = ?");
    values.push(patch.name);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.expiresAt !== undefined) {
    sets.push("expires_at = ?");
    values.push(patch.expiresAt);
  }
  if (patch.rateLimitPerMin !== undefined) {
    sets.push("rate_limit_per_min = ?");
    values.push(patch.rateLimitPerMin);
  }
  if (patch.budgetUsd !== undefined) {
    sets.push("budget_usd = ?");
    values.push(patch.budgetUsd);
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    values.push(patch.note);
  }
  if (patch.allowedModels !== undefined) {
    sets.push("allowed_models = ?");
    values.push(
      patch.allowedModels && patch.allowedModels.length
        ? JSON.stringify(patch.allowedModels)
        : null,
    );
  }
  if (!sets.length) return;

  values.push(id);
  db.prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function touchApiKey(id: string): void {
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
}

export function addSpend(id: string, costUsd: number): void {
  if (!costUsd) return;
  db.prepare("UPDATE api_keys SET spent_usd = spent_usd + ? WHERE id = ?").run(costUsd, id);
}

export function resetSpend(id: string): void {
  db.prepare("UPDATE api_keys SET spent_usd = 0 WHERE id = ?").run(id);
}

/* ------------------------------------------------------------------ */
/* request log                                                         */
/* ------------------------------------------------------------------ */

export interface LogEntry {
  keyId: string | null;
  model: string | null;
  resolvedModel: string | null;
  engine: string | null;
  status: number;
  streamed: boolean;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number;
  error?: string | null;
  ip?: string | null;
}

export function logRequest(e: LogEntry): void {
  db.prepare(
    `INSERT INTO requests
       (key_id, ts, model, resolved_model, engine, status, streamed,
        prompt_tokens, completion_tokens, cost_usd, duration_ms, error, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.keyId,
    Date.now(),
    e.model,
    e.resolvedModel,
    e.engine,
    e.status,
    e.streamed ? 1 : 0,
    e.promptTokens,
    e.completionTokens,
    e.costUsd,
    e.durationMs,
    e.error ?? null,
    e.ip ?? null,
  );
}

/** Number of requests a key made in the trailing window. */
export function countRecentRequests(keyId: string, windowMs = 60_000): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE key_id = ? AND ts > ?")
    .get(keyId, Date.now() - windowMs) as unknown as { n: number };
  return row.n;
}

/** Takes the retention as an argument: settings.ts imports this module. */
export function pruneOldRequests(retentionDays: number): void {
  if (retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  db.prepare("DELETE FROM requests WHERE ts < ?").run(cutoff);
}
