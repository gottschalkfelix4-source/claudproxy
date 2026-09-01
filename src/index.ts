import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initAdminPassword } from "./auth.js";
import { config } from "./config.js";
import { pruneOldRequests } from "./db.js";
import { engineStatus } from "./engines/index.js";
import { settings } from "./settings.js";
import { BUILD } from "./version.js";
import { adminRouter } from "./routes/admin.js";
import { v1Router } from "./routes/v1.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, "web");

const app = express();

// Always on: the runtime setting decides whether the header is trusted.
app.set("trust proxy", true);
app.disable("x-powered-by");

// Bodies can be large when clients send base64 images.
app.use(express.json({ limit: "32mb" }));
app.use(cookieParser());

// Permissive CORS: the proxy sits on a private network and browser-based
// clients (Open WebUI, LibreChat) need to reach it directly.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-api-key, api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Liveness. Answers 200 whenever the process is serving, and reports backend
 * readiness in the body instead of the status code.
 *
 * This is what the container HEALTHCHECK uses. Returning 503 for a backend that
 * merely lacks credentials marked the container unhealthy in Docker and Unraid
 * while the web UI — the very place you go to enter those credentials — was
 * working fine.
 */
app.get("/health", (_req, res) => {
  const status = engineStatus();
  res.status(200).json({
    status: "ok",
    backendReady: status.ready,
    backend: status.backend,
    detail: status.detail,
    version: BUILD.version,
    commit: BUILD.commit,
    builtAt: BUILD.builtAt,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

/** Readiness, for a load balancer that should skip an unconfigured instance. */
app.get("/ready", (_req, res) => {
  const status = engineStatus();
  res.status(status.ready ? 200 : 503).json({
    status: status.ready ? "ready" : "not_ready",
    backend: status.backend,
    detail: status.detail,
  });
});

app.use("/v1", v1Router);
app.use("/admin/api", adminRouter);

if (config.enableWebUi && fs.existsSync(webRoot)) {
  app.use("/admin", express.static(webRoot));
  app.get("/admin", (_req, res) => res.sendFile(path.join(webRoot, "index.html")));
  app.get("/", (_req, res) => res.redirect("/admin"));
} else {
  app.get("/", (_req, res) => res.json({ service: "claude-openai-proxy", endpoint: "/v1" }));
}

app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `No route for ${req.method} ${req.path}.`,
      type: "not_found",
      code: "not_found",
    },
  });
});

/**
 * Last-resort handler. Without it, a malformed JSON body reaches Express's
 * default handler, which answers with an HTML page containing a stack trace and
 * absolute file paths — neither parseable by an OpenAI client nor safe to
 * expose.
 */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const e = err as { status?: number; statusCode?: number; type?: string; message?: string };
  const status = e?.status ?? e?.statusCode ?? 500;

  const isBadJson = e?.type === "entity.parse.failed" || status === 400;
  const isTooLarge = e?.type === "entity.too.large" || status === 413;

  const message = isBadJson
    ? "Request body is not valid JSON."
    : isTooLarge
      ? "Request body is too large."
      : "Internal server error.";

  if (status >= 500) console.error("[proxy] unhandled error:", err);

  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({
    error: {
      message,
      type: isBadJson ? "invalid_request_error" : isTooLarge ? "payload_too_large" : "server_error",
      param: null,
      code: isBadJson ? "invalid_request_error" : isTooLarge ? "payload_too_large" : "server_error",
    },
  });
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

const { generated } = initAdminPassword();

fs.mkdirSync(config.workDir, { recursive: true });

const prune = () => pruneOldRequests(settings.logRetentionDays);
prune();
setInterval(prune, 6 * 60 * 60 * 1000).unref();

const server = app.listen(config.port, config.host, () => {
  const status = engineStatus();
  const banner = [
    "",
    `  Claude -> OpenAI proxy  ${BUILD.version}${BUILD.commit ? " (" + BUILD.commit + ")" : ""}`,
    `  Endpoint    http://localhost:${config.port}/v1`,
    `  Web UI      http://localhost:${config.port}/admin`,
    `  Backend     ${status.backend} (${status.ready ? "ready" : "NOT READY"})`,
  ];
  if (!status.ready) banner.push(`              ${status.detail}`);
  banner.push(`  Auth        ${settings.requireAuth ? "API key required" : "DISABLED"}`);
  if (generated) {
    banner.push(
      "",
      "  Admin password (generated, shown once):",
      `      ${generated}`,
      "  Set ADMIN_PASSWORD to pin your own.",
    );
  }
  banner.push("");
  console.log(banner.join("\n"));
});

// Streaming replies can outlive the default 5-minute socket timeout.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;
server.setTimeout(config.requestTimeoutMs + 30_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
