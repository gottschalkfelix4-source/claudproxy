/**
 * Drives `claude setup-token` from the web UI.
 *
 * The CLI insists on a terminal — without one it prints nothing and exits — so
 * it runs under script(1), which allocates a PTY. script(1) is part of
 * util-linux and already in the image, which avoids a native node-pty build.
 *
 * The flow it implements:
 *   1. the CLI prints an OAuth URL, wrapped in an OSC-8 hyperlink escape
 *   2. the user signs in there and gets a code back
 *   3. the code goes to the CLI's stdin
 *   4. the CLI stores credentials and prints a long-lived token
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { applySetting } from "./settings.js";

export type LoginState =
  | "idle"
  | "starting"
  | "waiting_for_code"
  | "exchanging"
  | "done"
  | "error";

interface Session {
  state: LoginState;
  url: string | null;
  message: string | null;
  startedAt: number;
  proc: ChildProcessWithoutNullStreams | null;
  output: string;
  timer: NodeJS.Timeout | null;
  /** Output length when the code was submitted, to read only what came after. */
  codeMark: number;
  codeTimer: NodeJS.Timeout | null;
  /** Credential file mtime before the attempt, to detect a successful write. */
  credMtimeBefore: number;
  poll: NodeJS.Timeout | null;
}

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
/** Keep the transcript bounded; the CLI redraws its spinner constantly. */
const MAX_OUTPUT = 256 * 1024;

let session: Session = blank();

function blank(): Session {
  return {
    state: "idle",
    url: null,
    message: null,
    startedAt: 0,
    proc: null,
    output: "",
    timer: null,
    codeMark: 0,
    codeTimer: null,
    credMtimeBefore: 0,
    poll: null,
  };
}

/* ------------------------------------------------------------------ */
/* terminal output parsing                                             */
/* ------------------------------------------------------------------ */

/** Removes CSI/OSC escape sequences so the text can be read and matched. */
export function stripAnsi(input: string): string {
  return input
    // OSC ... BEL or ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI sequences
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // remaining two-character escapes
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "");
}

/**
 * Pulls the authorize URL out of the transcript.
 *
 * The CLI emits it as an OSC-8 hyperlink whose visible label is wrapped across
 * lines, so the escape sequence holds the only intact copy. Falls back to a
 * plain scan for the rare terminal that gets no hyperlink.
 */
export function extractAuthUrl(output: string): string | null {
  const osc8 = /\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  while ((match = osc8.exec(output)) !== null) {
    if (match[1].includes("/oauth/authorize")) return match[1];
  }

  const plain = stripAnsi(output).replace(/\n/g, "");
  const direct = /https:\/\/[^\s"']*\/oauth\/authorize\?[^\s"']+/.exec(plain);
  return direct ? direct[0] : null;
}

/** Long-lived tokens produced by `claude setup-token`. */
export function extractToken(output: string): string | null {
  const m = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/.exec(stripAnsi(output));
  return m ? m[0] : null;
}

function credentialsPath(): string {
  return path.join(config.claudeConfigDir, ".credentials.json");
}

function credentialsMtime(): number {
  try {
    return fs.statSync(credentialsPath()).mtimeMs;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* session control                                                     */
/* ------------------------------------------------------------------ */

export function status() {
  return {
    state: session.state,
    url: session.url,
    message: session.message,
    /** Last few readable lines, for diagnosing a failed attempt. */
    tail: session.state === "error" ? tail(session.output) : undefined,
  };
}

function tail(output: string): string {
  const lines = stripAnsi(output)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-8).join("\n");
}

function finish(state: LoginState, message: string): void {
  session.state = state;
  session.message = message;
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  if (session.codeTimer) clearTimeout(session.codeTimer);
  session.codeTimer = null;
  if (session.poll) clearInterval(session.poll);
  session.poll = null;
  if (session.proc && !session.proc.killed) session.proc.kill("SIGKILL");
  session.proc = null;
}

export function cancel(): void {
  if (session.state === "idle") return;
  finish("idle", "Abgebrochen.");
  session = blank();
}

/**
 * Launches the CLI and resolves once the authorize URL appears, so the caller
 * can hand it straight to the browser.
 */
export function start(): Promise<{ url: string }> {
  if (session.state === "starting" || session.state === "waiting_for_code") {
    if (session.url) return Promise.resolve({ url: session.url });
  }

  cancel();
  session = blank();
  session.state = "starting";
  session.startedAt = Date.now();

  const mtimeBefore = credentialsMtime();
  session.credMtimeBefore = mtimeBefore;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_CONFIG_DIR: config.claudeConfigDir,
    HOME: path.dirname(config.claudeConfigDir),
    // Force the interactive flow rather than an existing credential.
    TERM: "xterm-256color",
  };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;

  let proc: ChildProcessWithoutNullStreams;
  try {
    fs.mkdirSync(config.workDir, { recursive: true });
    proc = spawn("script", ["-qfec", "claude setup-token", "/dev/null"], {
      env,
      cwd: config.workDir,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    finish("error", `Konnte die Claude-CLI nicht starten: ${String(err)}`);
    return Promise.reject(new Error(session.message ?? "start failed"));
  }

  session.proc = proc;

  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      finish("error", msg);
      reject(new Error(msg));
    };

    const absorb = (chunk: Buffer) => {
      session.output = (session.output + chunk.toString("utf8")).slice(-MAX_OUTPUT);

      if (!session.url) {
        const url = extractAuthUrl(session.output);
        if (url) {
          session.url = url;
          session.state = "waiting_for_code";
          if (!settled) {
            settled = true;
            resolve({ url });
          }
        }
      }

      // The token can arrive without us seeing the process exit first.
      const token = extractToken(session.output);
      if (token && session.state !== "done") {
        persist(token);
        return;
      }

      // The credential file is the ground truth: the CLI may store it without
      // ever printing a token we can recognise.
      if (session.state === "exchanging" && credentialsMtime() > mtimeBefore) {
        finish("done", "Anmeldung erfolgreich. Die Zugangsdaten sind gespeichert.");
        adoptStoredToken();
        return;
      }

      if (session.state === "exchanging") checkCodeRejected();
    };

    proc.stdout.on("data", absorb);
    proc.stderr.on("data", absorb);

    proc.on("error", (err) => fail(`Konnte die Claude-CLI nicht starten: ${err.message}`));

    proc.on("close", (code) => {
      if (session.state === "done") return;

      const token = extractToken(session.output);
      if (token) {
        persist(token);
        return;
      }

      // No token in the transcript, but the CLI may still have written the
      // credential file — that alone is enough for the engine to work.
      if (credentialsMtime() > mtimeBefore) {
        session.state = "done";
        session.message =
          "Anmeldung erfolgreich. Die Zugangsdaten liegen jetzt im Container.";
        if (!settled) {
          settled = true;
          reject(new Error("Angemeldet, aber es wurde keine URL angezeigt."));
        }
        return;
      }

      fail(
        code === 0
          ? "Die Anmeldung wurde beendet, ohne einen Token zu liefern."
          : `Die Claude-CLI endete mit Code ${code}.`,
      );
    });

    session.timer = setTimeout(() => {
      if (session.state !== "done") {
        fail("Zeitüberschreitung — die Anmeldung wurde nach 10 Minuten abgebrochen.");
      }
    }, SESSION_TIMEOUT_MS);
    session.timer.unref?.();

    // Nothing usable within 60s means the CLI is not going to produce a URL.
    setTimeout(() => {
      if (!session.url && session.state === "starting") {
        fail(
          "Die Claude-CLI hat keine Anmelde-URL geliefert. Details stehen unten im Protokoll.",
        );
      }
    }, 60_000).unref?.();
  });
}

/** Feeds the code from the browser into the waiting CLI. */
export function submitCode(code: string): void {
  if (session.state !== "waiting_for_code" || !session.proc) {
    throw new Error("Es läuft gerade keine Anmeldung, die auf einen Code wartet.");
  }
  const clean = code.trim();
  if (!clean) throw new Error("Kein Code eingegeben.");

  session.codeMark = session.output.length;
  session.message = null;
  session.state = "exchanging";

  // Carriage return, not newline. The CLI puts the PTY in raw mode and only
  // treats CR as Enter — a bare LF is swallowed and the code is never
  // submitted, which looks exactly like the server never answering.
  session.proc.stdin.write(clean + "\r");

  // The CLI says nothing while it talks to the OAuth server, so cap the wait
  // and hand control back instead of leaving the UI on "checking…" forever.
  if (session.codeTimer) clearTimeout(session.codeTimer);
  session.codeTimer = setTimeout(() => {
    if (session.state === "exchanging") {
      backToCodeEntry(
        "Auf den Code kam keine Antwort. Prüfe, ob du ihn vollständig eingefügt hast, " +
          "und versuche es erneut.",
      );
    }
  }, 90_000);
  session.codeTimer.unref?.();

  // Watch the credential file directly: a successful exchange may write it
  // without the CLI printing anything further.
  if (session.poll) clearInterval(session.poll);
  session.poll = setInterval(() => {
    if (session.state !== "exchanging") return;
    if (credentialsMtime() > session.credMtimeBefore) {
      finish("done", "Anmeldung erfolgreich. Die Zugangsdaten sind gespeichert.");
      adoptStoredToken();
    }
  }, 2000);
  session.poll.unref?.();
}

/**
 * Detects a rejected code.
 *
 * On failure the CLI prints "OAuth error: Invalid code..." followed by
 * "Press Enter to retry" and then blocks on that prompt. Matching is done
 * without relying on spaces: the TUI positions words with cursor escapes, so
 * the stripped transcript reads "Invalidcode" and "makesure".
 */
function checkCodeRejected(): void {
  const after = stripAnsi(session.output.slice(session.codeMark)).replace(/\s+/g, " ");

  const failed =
    /oauth\s*error/i.test(after) ||
    /invalid\s*code/i.test(after) ||
    /expired/i.test(after) ||
    /unauthorized|not\s*authorized/i.test(after);

  if (!failed) return;

  // Answer the retry prompt so the CLI returns to the code question; otherwise
  // it sits there and the next attempt has nowhere to go.
  if (/press\s*enter\s*to\s*retry/i.test(after) && session.proc) {
    session.proc.stdin.write("\r");
    session.codeMark = session.output.length;
  }

  backToCodeEntry(
    /invalid\s*code/i.test(after)
      ? "Der Code wurde abgelehnt. Achte darauf, den vollständigen Code zu kopieren — " +
          "er ist länger, als das Feld auf der Claude-Seite zeigt."
      : "Die Anmeldung wurde abgelehnt. Öffne den Link erneut und versuche es noch einmal.",
  );
}

/** Reads the token the CLI stored, so the settings field matches the login. */
function adoptStoredToken(): void {
  try {
    const raw = fs.readFileSync(credentialsPath(), "utf8");
    const token = extractToken(raw) ?? /"access_?[Tt]oken"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
    if (token) applySetting("CLAUDE_CODE_OAUTH_TOKEN", token);
    applySetting("BACKEND", "claude-code");
  } catch {
    // The credential file alone is enough for the engine; the setting is a convenience.
  }
}

/** Returns to step 2 so the user can retry without restarting the whole flow. */
function backToCodeEntry(message: string): void {
  if (session.codeTimer) clearTimeout(session.codeTimer);
  session.codeTimer = null;
  session.state = "waiting_for_code";
  session.message = message;
}

function persist(token: string): void {
  try {
    applySetting("CLAUDE_CODE_OAUTH_TOKEN", token);
    applySetting("BACKEND", "claude-code");
    finish("done", "Anmeldung erfolgreich. Der Token ist gespeichert.");
  } catch (err) {
    finish("error", `Token erhalten, aber Speichern schlug fehl: ${String(err)}`);
  }
}

/** Whether credentials exist at all, regardless of how they got there. */
export function credentialsPresent(): boolean {
  return credentialsMtime() > 0;
}
