import path from "node:path";

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : def;
}

export type Backend = "claude-code" | "anthropic-api" | "mock";

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST ?? "0.0.0.0",

  /** Where the SQLite file lives. Mount this path as a volume in Docker. */
  dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), "data"),

  /** Password for the web UI. Generated on first boot if unset. */
  adminPassword: process.env.ADMIN_PASSWORD ?? "",

  /** Secret used to sign admin session cookies. Generated on first boot if unset. */
  sessionSecret: process.env.SESSION_SECRET ?? "",

  /**
   * claude-code   -> routes through the Claude Code engine (Pro/Max subscription, OAuth)
   * anthropic-api -> routes through the Anthropic API with a pay-per-token API key
   * mock          -> offline echo backend for verifying a client integration
   */
  backend: (process.env.BACKEND ?? "claude-code") as Backend,

  /** Used only by the anthropic-api backend. */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",

  /** Used only by the claude-code backend. Falls back to a mounted ~/.claude. */
  claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",

  /** Where the Claude Code harness looks for its credentials. */
  claudeConfigDir:
    process.env.CLAUDE_CONFIG_DIR ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/root", ".claude"),

  defaultModel: process.env.DEFAULT_MODEL ?? "claude-opus-5",

  /** Working directory handed to the Claude Code engine. Kept empty and isolated. */
  workDir: process.env.WORK_DIR ?? "/tmp/claude-proxy-work",

  /** Hard ceiling on max_tokens a client can request. */
  maxTokensLimit: int(process.env.MAX_TOKENS_LIMIT, 64000),

  /** Default max_tokens when the client does not send one. */
  defaultMaxTokens: int(process.env.DEFAULT_MAX_TOKENS, 16000),

  /** Wall-clock ceiling for a single upstream request. */
  requestTimeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 600_000),

  /** Serve the admin UI at /admin. */
  enableWebUi: bool(process.env.ENABLE_WEB_UI, true),

  /** Keep request rows for this many days. 0 disables pruning. */
  logRetentionDays: int(process.env.LOG_RETENTION_DAYS, 30),

  /** Require an API key on /v1/*. Turn off only on a trusted private network. */
  requireAuth: bool(process.env.REQUIRE_AUTH, true),

  /** Trust X-Forwarded-For (set to true behind a reverse proxy). */
  trustProxy: bool(process.env.TRUST_PROXY, false),

  /**
   * Surface Claude's summarised thinking as `reasoning_content` on the response.
   * Off by default: plain OpenAI clients ignore the field, but it costs extra
   * output tokens to have the summary generated.
   */
  exposeThinking: bool(process.env.EXPOSE_THINKING, false),

  /**
   * Default reasoning effort. Empty means the API default (high). Clients can
   * override per request with OpenAI's `reasoning_effort`.
   */
  defaultEffort: (process.env.DEFAULT_EFFORT ?? "") as
    | ""
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max",

  /**
   * Enable server-side refusal fallbacks on Opus 5 / Fable 5, so a safety
   * refusal is answered by another model instead of surfacing as an empty reply.
   */
  refusalFallbacks: bool(process.env.REFUSAL_FALLBACKS, true),
};

export type Config = typeof config;
