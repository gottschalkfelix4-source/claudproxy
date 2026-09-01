/**
 * Offline echo engine (BACKEND=mock).
 *
 * Serves the full request path — translation, streaming, usage accounting, key
 * enforcement — without any credentials, so a client integration can be verified
 * before the real backend is wired up.
 */

import { estimateCost } from "../models.js";
import type { ChatRequest, ChatResult, Engine, StreamEvent, Usage } from "../types.js";

function summarise(req: ChatRequest): string {
  const last = req.messages[req.messages.length - 1];
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content
          .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
          .join(" ");

  return (
    `Mock-Antwort von ${req.model}. Der Proxy funktioniert.\n\n` +
    `Empfangen: ${req.messages.length} Nachricht(en)` +
    (req.system ? `, System-Prompt (${req.system.length} Zeichen)` : "") +
    (req.tools?.length ? `, ${req.tools.length} Tool(s)` : "") +
    `.\nLetzte Nachricht: ${text.slice(0, 200)}`
  );
}

/** Rough 4-chars-per-token estimate; good enough to exercise the accounting path. */
function fakeUsage(req: ChatRequest, output: string): Usage {
  const inputChars = JSON.stringify(req.messages).length + (req.system?.length ?? 0);
  return {
    promptTokens: Math.ceil(inputChars / 4),
    completionTokens: Math.ceil(output.length / 4),
    cachedTokens: 0,
  };
}

export class MockEngine implements Engine {
  readonly name = "mock";

  assertReady(): void {}

  async complete(req: ChatRequest): Promise<ChatResult> {
    const text = summarise(req);
    const usage = fakeUsage(req, text);
    return {
      text,
      toolCalls: [],
      finishReason: "stop",
      usage,
      costUsd: estimateCost(req.model, usage.promptTokens, usage.completionTokens),
    };
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent, void, void> {
    const text = summarise(req);
    const usage = fakeUsage(req, text);

    for (const word of text.split(/(?<=\s)/)) {
      if (signal.aborted) break;
      yield { type: "text", text: word };
      await new Promise((r) => setTimeout(r, 8));
    }

    yield {
      type: "done",
      finishReason: "stop",
      usage,
      costUsd: estimateCost(req.model, usage.promptTokens, usage.completionTokens),
    };
  }
}
