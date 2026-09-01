/**
 * What is known about the stored Claude credentials, without revealing them.
 *
 * A rejected token looks the same from the outside whatever is wrong with it —
 * truncated, expired, revoked, or belonging to another account. These checks
 * name the difference so diagnosing it does not require shell access to the
 * host, which is exactly what made the truncation bug so hard to pin down.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getOverride, settings } from "./settings.js";

/** Long-lived tokens run about 108 characters; well below that is suspicious. */
const PLAUSIBLE_MIN_LENGTH = 100;
const PREFIX = "sk-ant-oat01-";

export interface TokenInfo {
  /** Whether anything at all is configured. */
  present: boolean;
  /** Character count — never the value itself. */
  length: number;
  /** First and last few characters, enough to compare two tokens by eye. */
  fingerprint: string;
  hasExpectedPrefix: boolean;
  /** True when the length is in the range a real token occupies. */
  looksComplete: boolean;
  source: "settings" | "environment" | "none";
  credentialsFile: {
    exists: boolean;
    path: string;
    matchesSetting: boolean;
    /** Set when the file records one. */
    expiresAt: string | null;
    expired: boolean | null;
  };
  /** Plain-language verdict and what to do about it. */
  verdict: string;
  advice: string[];
}

function fingerprint(token: string): string {
  if (!token) return "";
  if (token.length <= 20) return token.slice(0, 6) + "…";
  return `${token.slice(0, 16)}…${token.slice(-6)}`;
}

function credentialsPath(): string {
  return path.join(config.claudeConfigDir, ".credentials.json");
}

function readCredentials(): { token: string | null; expiresAt: number | null } {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(), "utf8")) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const oauth = parsed?.claudeAiOauth ?? (parsed as Record<string, unknown>);
    const token = [oauth?.accessToken, oauth?.access_token].find(
      (v) => typeof v === "string" && (v as string).startsWith("sk-ant-"),
    );
    const exp = oauth?.expiresAt ?? oauth?.expires_at;
    return {
      token: (token as string) ?? null,
      expiresAt: typeof exp === "number" ? exp : null,
    };
  } catch {
    return { token: null, expiresAt: null };
  }
}

export function describeToken(): TokenInfo {
  const token = settings.claudeCodeOAuthToken;
  const stored = getOverride("CLAUDE_CODE_OAUTH_TOKEN");
  const creds = readCredentials();
  const credsExist = creds.token !== null;

  const hasExpectedPrefix = token.startsWith(PREFIX);
  const looksComplete = token.length >= PLAUSIBLE_MIN_LENGTH;
  const expired =
    creds.expiresAt !== null ? creds.expiresAt < Date.now() : null;

  const info: TokenInfo = {
    present: token.length > 0,
    length: token.length,
    fingerprint: fingerprint(token),
    hasExpectedPrefix,
    looksComplete,
    source: !token ? "none" : stored !== null ? "settings" : "environment",
    credentialsFile: {
      exists: credsExist,
      path: credentialsPath(),
      matchesSetting: credsExist && creds.token === token,
      expiresAt: creds.expiresAt ? new Date(creds.expiresAt).toISOString() : null,
      expired,
    },
    verdict: "",
    advice: [],
  };

  /* ---- verdict ---- */

  if (!info.present && !credsExist) {
    info.verdict = "Es sind keine Claude-Zugangsdaten hinterlegt.";
    info.advice.push("Oben auf „Bei Claude anmelden“ klicken.");
    return info;
  }

  if (!info.present && credsExist) {
    info.verdict =
      "Kein Token in den Einstellungen, aber im Container liegen Zugangsdaten — " +
      "die werden verwendet.";
    return info;
  }

  if (info.present && !hasExpectedPrefix) {
    info.verdict =
      `Der hinterlegte Wert beginnt nicht mit „${PREFIX}“ und ist vermutlich kein ` +
      "Anmelde-Token.";
    info.advice.push("Feld unter Einstellungen leeren und neu anmelden.");
    return info;
  }

  if (info.present && !looksComplete) {
    info.verdict =
      `Der Token ist mit ${info.length} Zeichen zu kurz — vollständig sind es rund 108. ` +
      "Er wurde vermutlich beim Speichern abgeschnitten und wird deshalb abgelehnt.";
    info.advice.push(
      credsExist
        ? "Beim Feld „Claude OAuth-Token“ auf „Zurücksetzen“ klicken: dann greifen die " +
            "vollständigen Zugangsdaten aus dem Container."
        : "Neu anmelden — dabei wird der Token jetzt vollständig gespeichert.",
    );
    info.advice.push(
      "Alternativ den Token an einem Rechner mit installiertem Claude Code über " +
        "`claude setup-token` erzeugen und hier von Hand eintragen.",
    );
    return info;
  }

  if (expired === true) {
    info.verdict = "Die Zugangsdaten im Container sind abgelaufen.";
    info.advice.push("Neu anmelden.");
    return info;
  }

  if (credsExist && !info.credentialsFile.matchesSetting) {
    info.verdict =
      "Der Token in den Einstellungen unterscheidet sich von den Zugangsdaten im " +
      "Container. Der Token aus den Einstellungen hat Vorrang.";
    info.advice.push(
      "Wird er abgelehnt, das Feld zurücksetzen — dann gelten die Zugangsdaten aus " +
        "der Anmeldung.",
    );
    return info;
  }

  info.verdict = `Der Token sieht vollständig aus (${info.length} Zeichen).`;
  info.advice.push(
    "Wird er trotzdem abgelehnt, ist er abgelaufen oder widerrufen — dann neu anmelden.",
  );
  return info;
}

/**
 * Actually asks Claude whether the credentials work.
 *
 * Truncated, expired, revoked and wrong-account all produce the same message,
 * and length alone cannot tell them apart — so send one real, minimal request
 * and report what comes back.
 */
export async function verifyCredentials(): Promise<{
  ok: boolean;
  message: string;
  detail?: string;
  durationMs: number;
}> {
  const started = Date.now();
  const { getEngine } = await import("./engines/index.js");

  try {
    const engine = getEngine("claude-code");
    engine.assertReady();

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 90_000);

    try {
      await engine.complete(
        {
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          maxTokens: 1,
          stream: false,
        },
        abort.signal,
      );
    } finally {
      clearTimeout(timer);
    }

    return {
      ok: true,
      message: "Die Zugangsdaten funktionieren — Claude hat geantwortet.",
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const info = describeToken();

    let message: string;
    if (/invalid|unauthorized|401/i.test(raw)) {
      message = info.looksComplete
        ? "Der Token wird abgelehnt. Er ist vollständig, also vermutlich abgelaufen " +
          "oder widerrufen — bitte neu anmelden."
        : "Der Token wird abgelehnt und ist zu kurz, um vollständig zu sein — " +
          "bitte neu anmelden.";
    } else if (/rate.?limit|429/i.test(raw)) {
      message =
        "Die Zugangsdaten sind gültig, aber das Limit deines Abos ist gerade erreicht.";
      return { ok: true, message, detail: raw, durationMs: Date.now() - started };
    } else {
      message = "Der Test ist fehlgeschlagen.";
    }

    return { ok: false, message, detail: raw, durationMs: Date.now() - started };
  }
}
