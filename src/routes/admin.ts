import { Router, type Request, type Response } from "express";
import {
  adminAuth,
  checkAdminPassword,
  clearSessionCookie,
  clientIp,
  isAuthenticated,
  setSessionCookie,
} from "../auth.js";
import { config } from "../config.js";
import {
  createApiKey,
  db,
  deleteApiKey,
  getApiKeyById,
  listApiKeys,
  resetSpend,
  updateApiKey,
} from "../db.js";
import { engineStatus, getEngine } from "../engines/index.js";
import { MODELS, resolveModel } from "../models.js";
import { buildChatRequest, type OpenAIChatRequest } from "../translate.js";
import {
  applySetting,
  clearSetting,
  describeFields,
  settings,
  SettingsError,
} from "../settings.js";
import * as claudeLogin from "../claudeLogin.js";
import { hashKey, setSetting } from "../db.js";
import os from "node:os";
import { BUILD } from "../version.js";
import { runDiagnostics } from "../diagnostics.js";
import { describeToken, verifyCredentials } from "../tokenInfo.js";

export const adminRouter = Router();

/* ------------------------------------------------------------------ */
/* login                                                               */
/* ------------------------------------------------------------------ */

const loginAttempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 5 * 60 * 1000;

adminRouter.post("/login", (req: Request, res: Response) => {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (entry && entry.until > now && entry.count >= MAX_ATTEMPTS) {
    const seconds = Math.ceil((entry.until - now) / 1000);
    return res
      .status(429)
      .json({ error: `Too many failed attempts. Try again in ${seconds}s.` });
  }

  const password = String((req.body as { password?: string })?.password ?? "");
  if (!checkAdminPassword(password)) {
    const next = entry && entry.until > now ? entry : { count: 0, until: now + LOCKOUT_MS };
    next.count += 1;
    next.until = now + LOCKOUT_MS;
    loginAttempts.set(ip, next);
    return res.status(401).json({ error: "Wrong password." });
  }

  loginAttempts.delete(ip);
  setSessionCookie(res);
  res.json({ ok: true });
});

adminRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

adminRouter.get("/session", (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

/* ------------------------------------------------------------------ */
/* everything below requires a session                                 */
/* ------------------------------------------------------------------ */

adminRouter.use(adminAuth);

adminRouter.get("/status", (_req, res) => {
  const status = engineStatus();
  res.json({
    ...status,
    defaultModel: settings.defaultModel,
    requireAuth: settings.requireAuth,
    maxTokensLimit: settings.maxTokensLimit,
    defaultMaxTokens: settings.defaultMaxTokens,
    exposeThinking: settings.exposeThinking,
    defaultEffort: settings.defaultEffort || "(api default)",
    logRetentionDays: settings.logRetentionDays,
    models: MODELS,
    claudeCredentials: claudeLogin.credentialsPresent(),
    uptimeSeconds: Math.floor(process.uptime()),
    version: BUILD.version,
    commit: BUILD.commit,
    builtAt: BUILD.builtAt,
  });
});

/* ---------------- keys ---------------- */

function publicKey(row: ReturnType<typeof listApiKeys>[number]) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    enabled: row.enabled === 1,
    rateLimitPerMin: row.rate_limit_per_min,
    budgetUsd: row.budget_usd,
    spentUsd: row.spent_usd,
    allowedModels: row.allowed_models ? (JSON.parse(row.allowed_models) as string[]) : null,
    note: row.note,
  };
}

adminRouter.get("/keys", (_req, res) => {
  res.json({ keys: listApiKeys().map(publicKey) });
});

adminRouter.post("/keys", (req, res) => {
  const b = req.body as {
    name?: string;
    expiresAt?: number | null;
    rateLimitPerMin?: number | null;
    budgetUsd?: number | null;
    allowedModels?: string[] | null;
    note?: string | null;
  };

  const name = (b.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "A name is required." });

  const { row, rawKey } = createApiKey({
    name,
    expiresAt: b.expiresAt ?? null,
    rateLimitPerMin: b.rateLimitPerMin ?? null,
    budgetUsd: b.budgetUsd ?? null,
    allowedModels: b.allowedModels ?? null,
    note: b.note ?? null,
  });

  // The only time the secret is ever returned.
  res.json({ key: publicKey(row), secret: rawKey });
});

adminRouter.patch("/keys/:id", (req, res) => {
  if (!getApiKeyById(req.params.id)) return res.status(404).json({ error: "Key not found." });
  updateApiKey(req.params.id, req.body as Record<string, never>);
  res.json({ key: publicKey(getApiKeyById(req.params.id)!) });
});

adminRouter.delete("/keys/:id", (req, res) => {
  deleteApiKey(req.params.id);
  res.json({ ok: true });
});

adminRouter.post("/keys/:id/reset-spend", (req, res) => {
  resetSpend(req.params.id);
  res.json({ ok: true });
});

/* ---------------- usage ---------------- */

adminRouter.get("/stats", (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
  const since = Date.now() - days * 86_400_000;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(cost_usd), 0)          AS costUsd,
              COALESCE(AVG(duration_ms), 0)       AS avgDurationMs,
              COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
         FROM requests WHERE ts > ?`,
    )
    .get(since);

  const byDay = db
    .prepare(
      `SELECT date(ts / 1000, 'unixepoch') AS day,
              COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM requests WHERE ts > ?
        GROUP BY day ORDER BY day`,
    )
    .all(since);

  const byModel = db
    .prepare(
      `SELECT resolved_model AS model,
              COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM requests WHERE ts > ?
        GROUP BY resolved_model ORDER BY requests DESC`,
    )
    .all(since);

  const byKey = db
    .prepare(
      `SELECT r.key_id AS keyId,
              COALESCE(k.name, '(deleted)') AS name,
              COUNT(*) AS requests,
              COALESCE(SUM(r.prompt_tokens + r.completion_tokens), 0) AS tokens,
              COALESCE(SUM(r.cost_usd), 0) AS costUsd
         FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
        WHERE r.ts > ?
        GROUP BY r.key_id ORDER BY requests DESC LIMIT 20`,
    )
    .all(since);

  res.json({ days, totals, byDay, byModel, byKey });
});

adminRouter.get("/logs", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const keyId = typeof req.query.keyId === "string" ? req.query.keyId : null;

  const rows = keyId
    ? db
        .prepare(
          `SELECT r.*, COALESCE(k.name, '(deleted)') AS key_name
             FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
            WHERE r.key_id = ? ORDER BY r.ts DESC LIMIT ?`,
        )
        .all(keyId, limit)
    : db
        .prepare(
          `SELECT r.*, COALESCE(k.name, '(deleted)') AS key_name
             FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
            ORDER BY r.ts DESC LIMIT ?`,
        )
        .all(limit);

  res.json({ logs: rows });
});

/* ---------------- playground ---------------- */

adminRouter.post("/test", async (req: Request, res: Response) => {
  const b = req.body as OpenAIChatRequest;
  const model = resolveModel(b.model ?? settings.defaultModel) ?? settings.defaultModel;

  try {
    const chatReq = buildChatRequest({ ...b, stream: false }, model, {
      defaultMaxTokens: Math.min(settings.defaultMaxTokens, 4096),
      maxTokensLimit: settings.maxTokensLimit,
    });

    const started = Date.now();
    const result = await getEngine().complete(chatReq, new AbortController().signal);

    res.json({
      ok: true,
      model,
      text: result.text,
      reasoning: result.reasoning ?? null,
      finishReason: result.finishReason,
      usage: result.usage,
      costUsd: result.costUsd ?? 0,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      model,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

adminRouter.get("/settings", (_req, res) => {
  res.json({ fields: describeFields() });
});

/** Applies a batch of settings; reports the first failure without partial writes. */
adminRouter.put("/settings", (req, res) => {
  const patch = req.body as Record<string, unknown>;
  if (!patch || typeof patch !== "object") {
    return res.status(400).json({ error: "Erwartet ein Objekt aus Schlüssel/Wert-Paaren." });
  }

  const entries = Object.entries(patch);

  // Validate everything first, so a bad value cannot leave half the form applied.
  for (const [key, value] of entries) {
    try {
      const field = describeFields().find((f) => f.key === key);
      if (!field) throw new SettingsError(`Unbekannte Einstellung '${key}'.`);
      // Secrets keep their stored value when the field is submitted empty.
      if (field.type === "secret" && String(value ?? "") === "") continue;
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    for (const [key, value] of entries) {
      const field = describeFields().find((f) => f.key === key);
      if (field?.type === "secret" && String(value ?? "") === "") continue;
      applySetting(key, String(value ?? ""));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(err instanceof SettingsError ? 400 : 500).json({ error: message });
  }

  res.json({ ok: true, fields: describeFields() });
});

/** Drops one override so the environment value applies again. */
adminRouter.post("/settings/reset", (req, res) => {
  const key = String((req.body as { key?: string })?.key ?? "");
  try {
    clearSetting(key);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
  res.json({ ok: true, fields: describeFields() });
});

adminRouter.post("/password", (req, res) => {
  const b = req.body as { current?: string; next?: string };
  if (!checkAdminPassword(String(b?.current ?? ""))) {
    return res.status(401).json({ error: "Aktuelles Passwort stimmt nicht." });
  }
  const next = String(b?.next ?? "");
  if (next.length < 8) {
    return res.status(400).json({ error: "Das neue Passwort braucht mindestens 8 Zeichen." });
  }
  setSetting("admin_password_hash", hashKey(next));
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Claude sign-in                                                      */
/* ------------------------------------------------------------------ */

adminRouter.get("/claude-login/status", (_req, res) => {
  res.json({ ...claudeLogin.status(), credentialsPresent: claudeLogin.credentialsPresent() });
});

adminRouter.post("/claude-login/start", async (_req, res) => {
  try {
    await claudeLogin.start();
    res.json({ ok: true, ...claudeLogin.status() });
  } catch (err) {
    res.status(200).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...claudeLogin.status(),
    });
  }
});

adminRouter.post("/claude-login/code", (req, res) => {
  const code = String((req.body as { code?: string })?.code ?? "");
  try {
    claudeLogin.submitCode(code);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
  res.json({ ok: true, ...claudeLogin.status() });
});

adminRouter.post("/claude-login/cancel", (_req, res) => {
  claudeLogin.cancel();
  res.json({ ok: true, ...claudeLogin.status() });
});

/* ------------------------------------------------------------------ */
/* endpoint discovery                                                  */
/* ------------------------------------------------------------------ */

/** Non-loopback IPv4 addresses of the container, for the "reachable at" list. */
function localAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

adminRouter.get("/endpoints", (req, res) => {
  // Whatever host the admin is currently browsing is the address that
  // demonstrably works, so it leads the list.
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol;
  const host = req.headers.host ?? `localhost:${config.port}`;
  const primary = `${proto}://${host}`;

  res.json({
    primary: {
      baseUrl: `${primary}/v1`,
      chat: `${primary}/v1/chat/completions`,
      models: `${primary}/v1/models`,
      health: `${primary}/health`,
      admin: `${primary}/admin`,
    },
    alternatives: [
      {
        label: "Aus einem anderen Docker-Container im selben Netz",
        baseUrl: `http://claude-proxy:${config.port}/v1`,
        hint: "Container-Name als Hostname; beide müssen im selben Docker-Netz hängen.",
      },
      ...localAddresses().map((ip) => ({
        label: `Über die Container-IP ${ip}`,
        baseUrl: `http://${ip}:${config.port}/v1`,
        hint: "Nur innerhalb des Docker-Netzes erreichbar.",
      })),
    ],
    port: config.port,
    requireAuth: settings.requireAuth,
  });
});

/* ------------------------------------------------------------------ */
/* connectivity diagnostics                                            */
/* ------------------------------------------------------------------ */

adminRouter.get("/diagnostics", async (_req, res) => {
  try {
    res.json(await runDiagnostics());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** What is known about the stored credentials — never the credentials themselves. */
adminRouter.get("/token-info", (_req, res) => {
  res.json(describeToken());
});

/** Sends one real request to establish whether the credentials actually work. */
adminRouter.post("/verify-credentials", async (_req, res) => {
  res.json(await verifyCredentials());
});
