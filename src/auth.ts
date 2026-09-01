import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { settings } from "./settings.js";
import {
  type ApiKeyRow,
  countRecentRequests,
  getApiKeyByHash,
  getOrCreateSecret,
  getSetting,
  hashKey,
  setSetting,
  touchApiKey,
} from "./db.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKeyRow;
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function clientIp(req: Request): string {
  if (settings.trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
    if (first) return first.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** OpenAI-shaped error body, so client SDKs surface a sensible message. */
export function sendError(res: Response, status: number, message: string, code: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({
    error: { message, type: code, param: null, code },
  });
}

/* ------------------------------------------------------------------ */
/* API key auth for /v1                                                */
/* ------------------------------------------------------------------ */

function extractKey(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();

  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey) return xApiKey.trim();

  const apiKeyHeader = req.headers["api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader) return apiKeyHeader.trim();

  return null;
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (!settings.requireAuth) return next();

  const raw = extractKey(req);
  if (!raw) {
    return sendError(
      res,
      401,
      "Missing API key. Pass it as 'Authorization: Bearer <key>'.",
      "invalid_api_key",
    );
  }

  const row = getApiKeyByHash(hashKey(raw));
  if (!row) {
    return sendError(res, 401, "Invalid API key.", "invalid_api_key");
  }
  if (!row.enabled) {
    return sendError(res, 403, `API key '${row.name}' is disabled.`, "api_key_disabled");
  }
  if (row.expires_at && row.expires_at < Date.now()) {
    return sendError(res, 403, `API key '${row.name}' expired.`, "api_key_expired");
  }
  if (row.budget_usd != null && row.spent_usd >= row.budget_usd) {
    return sendError(
      res,
      429,
      `API key '${row.name}' reached its budget of $${row.budget_usd.toFixed(2)}.`,
      "budget_exceeded",
    );
  }
  if (row.rate_limit_per_min != null) {
    const used = countRecentRequests(row.id);
    if (used >= row.rate_limit_per_min) {
      res.setHeader("Retry-After", "60");
      return sendError(
        res,
        429,
        `Rate limit of ${row.rate_limit_per_min} requests/min exceeded.`,
        "rate_limit_exceeded",
      );
    }
  }

  req.apiKey = row;
  touchApiKey(row.id);
  next();
}

/** Returns null when allowed, or an error message when the key may not use the model. */
export function checkModelAllowed(row: ApiKeyRow | undefined, model: string): string | null {
  if (!row?.allowed_models) return null;
  try {
    const allowed = JSON.parse(row.allowed_models) as string[];
    if (!allowed.length || allowed.includes(model)) return null;
    return `API key '${row.name}' is not allowed to use model '${model}'. Allowed: ${allowed.join(", ")}.`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* admin session auth for /admin                                       */
/* ------------------------------------------------------------------ */

const ADMIN_COOKIE = "cp_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sessionSecret(): string {
  return config.sessionSecret || getOrCreateSecret("session_secret");
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function issueSession(): string {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = String(expires);
  return `${payload}.${sign(payload)}`;
}

function verifySession(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return false;

  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(payload);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const expires = Number(payload);
  return Number.isFinite(expires) && expires > Date.now();
}

/**
 * Resolves the admin password hash, generating a random password on first boot
 * when ADMIN_PASSWORD is not set. Returns the plaintext only when generated.
 */
export function initAdminPassword(): { generated: string | null } {
  if (config.adminPassword) {
    const envHash = hashKey(config.adminPassword);
    // Adopt the environment password on first boot and whenever the operator
    // changes it — but not on every restart, which would silently undo a
    // password set through the web UI.
    if (getSetting("admin_password_env_hash") !== envHash) {
      setSetting("admin_password_hash", envHash);
      setSetting("admin_password_env_hash", envHash);
    }
    return { generated: null };
  }
  if (getSetting("admin_password_hash")) return { generated: null };

  const password = crypto.randomBytes(12).toString("base64url");
  setSetting("admin_password_hash", hashKey(password));
  return { generated: password };
}

export function checkAdminPassword(password: string): boolean {
  const stored = getSetting("admin_password_hash");
  if (!stored) return false;

  const a = Buffer.from(hashKey(password));
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function setSessionCookie(res: Response): void {
  res.cookie(ADMIN_COOKIE, issueSession(), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(ADMIN_COOKIE, { path: "/" });
}

export function isAuthenticated(req: Request): boolean {
  return verifySession(req.cookies?.[ADMIN_COOKIE]);
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: "Not authenticated" });
}
