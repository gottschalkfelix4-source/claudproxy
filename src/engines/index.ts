import { config } from "../config.js";
import type { Engine } from "../types.js";
import { EngineError } from "../types.js";
import { AnthropicApiEngine } from "./anthropicApi.js";
import { ClaudeCodeEngine } from "./claudeCode.js";
import { MockEngine } from "./mock.js";

const engines: Record<string, Engine> = {
  "claude-code": new ClaudeCodeEngine(),
  "anthropic-api": new AnthropicApiEngine(),
  mock: new MockEngine(),
};

export function getEngine(name = config.backend): Engine {
  const engine = engines[name];
  if (!engine) {
    throw new EngineError(
      `Unknown backend '${name}'. Use 'claude-code', 'anthropic-api' or 'mock'.`,
      500,
      "engine_not_configured",
    );
  }
  return engine;
}

/** Reports whether the configured backend can actually serve traffic. */
export function engineStatus(): { backend: string; ready: boolean; detail: string } {
  const backend = config.backend;
  try {
    getEngine(backend).assertReady();
    return { backend, ready: true, detail: "ready" };
  } catch (err) {
    return {
      backend,
      ready: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
