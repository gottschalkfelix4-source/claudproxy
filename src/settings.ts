/**
 * Runtime settings.
 *
 * Environment variables provide the initial value of every field; the admin UI
 * writes overrides into the database, and a stored override wins. Clearing a
 * field in the UI deletes the row, so the environment value applies again.
 *
 * The schema below is the single source of truth: it drives validation, the
 * admin API and the form rendered in the browser.
 */

import { config } from "./config.js";
import { db, getSetting, setSetting } from "./db.js";
import { MODELS } from "./models.js";

export type FieldType = "string" | "secret" | "boolean" | "number" | "select";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** Value used when nothing is stored — comes from the environment. */
  fallback: () => string;
  description: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  group: "backend" | "model" | "access" | "maintenance";
  /** Marks fields whose change only takes effect after a restart. */
  restartRequired?: boolean;
}

const bool = (v: boolean) => (v ? "true" : "false");

export const FIELDS: FieldDef[] = [
  {
    key: "BACKEND",
    label: "Backend",
    type: "select",
    fallback: () => config.backend,
    group: "backend",
    description:
      "claude-code nutzt ein Claude Pro/Max-Abo ohne Abrechnung pro Token. " +
      "anthropic-api rechnet pro Token ab und kann Function Calling. " +
      "mock antwortet offline mit Echo-Antworten zum Testen.",
    options: [
      { value: "claude-code", label: "Claude-Abo (Pro/Max)" },
      { value: "anthropic-api", label: "Anthropic API-Key" },
      { value: "mock", label: "Mock (Test ohne Zugangsdaten)" },
    ],
  },
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API-Key",
    type: "secret",
    fallback: () => config.anthropicApiKey,
    group: "backend",
    description: "Nur für das Backend „Anthropic API-Key“. Aus der Anthropic Console.",
  },
  {
    key: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude OAuth-Token",
    type: "secret",
    fallback: () => config.claudeCodeOAuthToken,
    group: "backend",
    description:
      "Nur für das Backend „Claude-Abo“. Wird von der Anmeldung unten automatisch " +
      "gesetzt — hier nur nötig, wenn du einen Token von anderswo einträgst.",
  },

  {
    key: "DEFAULT_MODEL",
    label: "Standardmodell",
    type: "select",
    fallback: () => config.defaultModel,
    group: "model",
    description:
      "Gilt für Requests ohne Modellangabe und für Modellnamen, die sich nicht zuordnen lassen.",
    options: MODELS.map((m) => ({ value: m.id, label: `${m.label} (${m.id})` })),
  },
  {
    key: "QUOTA_FALLBACK_MODEL",
    label: "Ausweichmodell bei erschöpftem Kontingent",
    type: "select",
    fallback: () => process.env.QUOTA_FALLBACK_MODEL ?? "",
    group: "model",
    description:
      "Ist das Kontingent des Abos für das angeforderte Modell aufgebraucht, wird der " +
      "Request einmalig mit diesem Modell wiederholt. Opus zehrt am schnellsten am " +
      "Kontingent, Sonnet und Haiku halten deutlich länger. Leer = kein Ausweichen.",
    options: [
      { value: "", label: "Aus — Fehler durchreichen" },
      ...MODELS.map((m) => ({ value: m.id, label: `${m.label} (${m.id})` })),
    ],
  },
  {
    key: "DEFAULT_EFFORT",
    label: "Reasoning Effort",
    type: "select",
    fallback: () => config.defaultEffort,
    group: "model",
    description:
      "Wie gründlich Claude nachdenkt. Niedriger heißt schneller und sparsamer. " +
      "Clients können das pro Request mit reasoning_effort überschreiben.",
    options: [
      { value: "", label: "API-Standard" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" },
      { value: "max", label: "max" },
    ],
  },
  {
    key: "DEFAULT_MAX_TOKENS",
    label: "Standard max_tokens",
    type: "number",
    fallback: () => String(config.defaultMaxTokens),
    group: "model",
    min: 1,
    max: 200_000,
    description: "Wird verwendet, wenn der Client kein max_tokens sendet.",
  },
  {
    key: "MAX_TOKENS_LIMIT",
    label: "Obergrenze max_tokens",
    type: "number",
    fallback: () => String(config.maxTokensLimit),
    group: "model",
    min: 1,
    max: 200_000,
    description: "Höhere Werte aus Client-Requests werden hierauf gekappt.",
  },
  {
    key: "EXPOSE_THINKING",
    label: "Gedankengang mitliefern",
    type: "boolean",
    fallback: () => bool(config.exposeThinking),
    group: "model",
    description:
      "Liefert Claudes zusammengefassten Gedankengang als Feld reasoning_content. " +
      "Kostet zusätzliche Output-Tokens; die meisten OpenAI-Clients ignorieren das Feld.",
  },
  {
    key: "REFUSAL_FALLBACKS",
    label: "Refusal-Fallback",
    type: "boolean",
    fallback: () => bool(config.refusalFallbacks),
    group: "model",
    description:
      "Lehnt ein Sicherheitsfilter eine Anfrage ab, beantwortet sie serverseitig ein " +
      "anderes Modell, statt dass der Client eine leere Antwort bekommt. " +
      "Betrifft nur Opus 5 und Fable 5 im API-Backend.",
  },

  {
    key: "REQUIRE_AUTH",
    label: "API-Key erforderlich",
    type: "boolean",
    fallback: () => bool(config.requireAuth),
    group: "access",
    description:
      "Abschalten gibt /v1 ohne Key frei. Nur in einem vertrauenswürdigen Netz sinnvoll.",
  },
  {
    key: "TRUST_PROXY",
    label: "Hinter Reverse Proxy",
    type: "boolean",
    fallback: () => bool(config.trustProxy),
    group: "access",
    description:
      "Wertet X-Forwarded-For aus, damit im Log die echte Client-IP steht statt der des Proxys.",
  },

  {
    key: "LOG_RETENTION_DAYS",
    label: "Logs aufbewahren (Tage)",
    type: "number",
    fallback: () => String(config.logRetentionDays),
    group: "maintenance",
    min: 0,
    max: 3650,
    description: "0 behält alles. Ältere Einträge werden alle sechs Stunden gelöscht.",
  },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

const PREFIX = "setting:";

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

/** The stored override, or null when the environment value applies. */
export function getOverride(key: string): string | null {
  return getSetting(PREFIX + key);
}

/** Effective value: stored override if present, else the environment value. */
export function raw(key: string): string {
  const field = BY_KEY.get(key);
  if (!field) return "";
  const stored = getOverride(key);
  return stored !== null ? stored : field.fallback();
}

function asBool(key: string): boolean {
  return ["1", "true", "yes", "on"].includes(raw(key).toLowerCase());
}

function asInt(key: string, fallback: number): number {
  const n = Number.parseInt(raw(key), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Effective runtime configuration, re-read on every access. */
export const settings = {
  get backend(): string {
    return raw("BACKEND") || "claude-code";
  },
  get anthropicApiKey(): string {
    return raw("ANTHROPIC_API_KEY");
  },
  get claudeCodeOAuthToken(): string {
    return raw("CLAUDE_CODE_OAUTH_TOKEN");
  },
  get defaultModel(): string {
    return raw("DEFAULT_MODEL") || "claude-opus-5";
  },
  get defaultEffort(): string {
    return raw("DEFAULT_EFFORT");
  },
  get quotaFallbackModel(): string {
    return raw("QUOTA_FALLBACK_MODEL");
  },
  get defaultMaxTokens(): number {
    return asInt("DEFAULT_MAX_TOKENS", 16000);
  },
  get maxTokensLimit(): number {
    return asInt("MAX_TOKENS_LIMIT", 64000);
  },
  get exposeThinking(): boolean {
    return asBool("EXPOSE_THINKING");
  },
  get refusalFallbacks(): boolean {
    return asBool("REFUSAL_FALLBACKS");
  },
  get requireAuth(): boolean {
    return asBool("REQUIRE_AUTH");
  },
  get trustProxy(): boolean {
    return asBool("TRUST_PROXY");
  },
  get logRetentionDays(): number {
    return asInt("LOG_RETENTION_DAYS", 30);
  },
};

/* ------------------------------------------------------------------ */
/* writing                                                             */
/* ------------------------------------------------------------------ */

export class SettingsError extends Error {}

/** Validates and stores one override. An empty secret clears it instead. */
export function applySetting(key: string, value: string): void {
  const field = BY_KEY.get(key);
  if (!field) throw new SettingsError(`Unbekannte Einstellung '${key}'.`);

  const v = String(value ?? "").trim();

  switch (field.type) {
    case "boolean": {
      if (!["true", "false"].includes(v)) {
        throw new SettingsError(`${field.label}: erwartet true oder false.`);
      }
      break;
    }
    case "number": {
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new SettingsError(`${field.label}: erwartet eine ganze Zahl.`);
      }
      if (field.min !== undefined && n < field.min) {
        throw new SettingsError(`${field.label}: mindestens ${field.min}.`);
      }
      if (field.max !== undefined && n > field.max) {
        throw new SettingsError(`${field.label}: höchstens ${field.max}.`);
      }
      break;
    }
    case "select": {
      const allowed = (field.options ?? []).map((o) => o.value);
      if (!allowed.includes(v)) {
        throw new SettingsError(`${field.label}: '${v}' ist keine gültige Auswahl.`);
      }
      break;
    }
    case "secret":
    case "string":
      break;
  }

  // An empty value means "use the environment value again".
  if (v === "") clearSetting(key);
  else setSetting(PREFIX + key, v);

  onChange(key);
}

export function clearSetting(key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(PREFIX + key);
  onChange(key);
}

type Listener = (key: string) => void;
const listeners: Listener[] = [];

/** Lets modules drop cached state (e.g. an SDK client bound to an API key). */
export function onSettingChange(fn: Listener): void {
  listeners.push(fn);
}

function onChange(key: string): void {
  for (const fn of listeners) fn(key);
}

/* ------------------------------------------------------------------ */
/* presentation                                                        */
/* ------------------------------------------------------------------ */

/** Field list for the admin UI. Secrets report whether they are set, never their value. */
export function describeFields() {
  return FIELDS.map((f) => {
    const stored = getOverride(f.key);
    const envValue = f.fallback();
    const effective = stored !== null ? stored : envValue;
    // Distinguish a real environment variable from the built-in default:
    // config.ts turns an unset boolean into "false", which is not the same as
    // the operator having chosen it.
    const fromEnv = (process.env[f.key] ?? "") !== "";

    return {
      key: f.key,
      label: f.label,
      type: f.type,
      group: f.group,
      description: f.description,
      options: f.options,
      min: f.min,
      max: f.max,
      /** Secrets never travel to the browser. */
      value: f.type === "secret" ? "" : effective,
      isSet: f.type === "secret" ? effective.length > 0 : undefined,
      /** True when a stored override is masking the environment value. */
      overridden: stored !== null,
      envValue: f.type === "secret" ? undefined : envValue,
      envPresent: fromEnv,
    };
  });
}
