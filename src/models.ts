/**
 * Model registry.
 *
 * Two jobs:
 *  1. Advertise a model list on /v1/models so OpenAI clients can populate a picker.
 *  2. Resolve whatever a client sends into a real Claude model id — including
 *     OpenAI names, so apps hardcoded to "gpt-4o" work without being touched.
 */

export interface ModelInfo {
  /** Canonical Claude model id sent upstream. */
  id: string;
  label: string;
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  contextWindow: number;
  maxOutput: number;
}

export const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    inputPer1M: 5,
    outputPer1M: 25,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    inputPer1M: 10,
    outputPer1M: 50,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    inputPer1M: 5,
    outputPer1M: 25,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    inputPer1M: 2,
    outputPer1M: 10,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    inputPer1M: 1,
    outputPer1M: 5,
    contextWindow: 200_000,
    maxOutput: 64_000,
  },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/**
 * Aliases resolved to a canonical id. Covers Claude short names, the Claude Code
 * CLI aliases, and the OpenAI names apps commonly hardcode.
 */
const ALIASES: Record<string, string> = {
  // Claude short names / CLI aliases
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5",
  "claude-opus": "claude-opus-5",
  "claude-sonnet": "claude-sonnet-5",
  "claude-haiku": "claude-haiku-4-5",
  "claude-3-5-sonnet": "claude-sonnet-5",
  "claude-3-opus": "claude-opus-5",
  "claude-opus-4": "claude-opus-5",
  "claude-sonnet-4": "claude-sonnet-5",
  "claude-haiku-4": "claude-haiku-4-5",

  // OpenAI names, so a client that only speaks GPT still routes somewhere sane
  "gpt-4": "claude-opus-5",
  "gpt-4o": "claude-opus-5",
  "gpt-4.1": "claude-opus-5",
  "gpt-4-turbo": "claude-opus-5",
  "gpt-5": "claude-opus-5",
  o1: "claude-opus-5",
  o3: "claude-opus-5",
  "gpt-4o-mini": "claude-haiku-4-5",
  "gpt-4.1-mini": "claude-haiku-4-5",
  "gpt-3.5-turbo": "claude-haiku-4-5",
  "gpt-5-mini": "claude-sonnet-5",
};

/**
 * Resolves a client-supplied model name to a canonical Claude model id.
 * Returns null when the name is not recognised — the caller decides whether
 * to fall back to the configured default or reject the request.
 */
export function resolveModel(requested: string | undefined | null): string | null {
  if (!requested) return null;

  let name = requested.trim();
  if (!name) return null;

  // Strip prefixes used by routers and gateways: "anthropic/claude-opus-5",
  // "claude-code-cli/opus", "openai/gpt-4o".
  const slash = name.lastIndexOf("/");
  if (slash !== -1) name = name.slice(slash + 1);

  const lower = name.toLowerCase();

  if (BY_ID.has(lower)) return lower;
  if (ALIASES[lower]) return ALIASES[lower];

  // Tolerate dated snapshots the API no longer needs: claude-opus-5-20260101.
  for (const id of BY_ID.keys()) {
    if (lower.startsWith(id + "-")) return id;
  }

  return null;
}

export function getModelInfo(id: string): ModelInfo | undefined {
  return BY_ID.get(id);
}

/** Estimated USD cost. Used for budgets and reporting, not billing. */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const info = BY_ID.get(modelId);
  if (!info) return 0;
  return (
    (promptTokens / 1_000_000) * info.inputPer1M +
    (completionTokens / 1_000_000) * info.outputPer1M
  );
}

/** The /v1/models payload in OpenAI's shape. */
export function openAiModelList() {
  return {
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: 1_700_000_000,
      owned_by: "anthropic",
      // Non-standard extras; OpenAI clients ignore unknown fields.
      context_window: m.contextWindow,
      max_output_tokens: m.maxOutput,
    })),
  };
}
