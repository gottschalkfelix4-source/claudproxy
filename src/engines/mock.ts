/**
 * Offline echo engine (BACKEND=mock).
 *
 * Serves the full request path — translation, streaming, usage accounting, key
 * enforcement — without any credentials, so a client integration can be verified
 * before the real backend is wired up.
 */

import crypto from "node:crypto";
import { estimateCost } from "../models.js";
import type { ChatRequest, ChatResult, Engine, StreamEvent, ToolCall, Usage } from "../types.js";

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

/**
 * Calls the first offered tool once, so a client's function-calling round trip
 * can be exercised end to end without any credentials. Returns no call once a
 * result has come back, otherwise the conversation would never terminate.
 */
function mockToolCall(req: ChatRequest): ToolCall[] {
  if (!req.tools?.length) return [];

  const alreadyAnswered = req.messages.some(
    (m) =>
      Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
  );
  if (alreadyAnswered) return [];

  const first = req.tools[0];
  const props = (first.input_schema?.properties ?? {}) as Record<
    string,
    { type?: string; enum?: unknown[] }
  >;

  // Plausible arguments so the client's own parsing is exercised too.
  const args: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(props)) {
    if (Array.isArray(spec?.enum) && spec.enum.length) args[name] = spec.enum[0];
    else if (spec?.type === "number" || spec?.type === "integer") args[name] = 1;
    else if (spec?.type === "boolean") args[name] = true;
    else if (spec?.type === "array") args[name] = [];
    else if (spec?.type === "object") args[name] = {};
    else args[name] = "mock";
  }

  return [
    {
      id: "call_" + crypto.randomBytes(12).toString("hex"),
      name: first.name,
      argumentsJson: JSON.stringify(args),
    },
  ];
}

export class MockEngine implements Engine {
  readonly name = "mock";

  assertReady(): void {}

  async complete(req: ChatRequest): Promise<ChatResult> {
    const toolCalls = mockToolCall(req);
    if (toolCalls.length) {
      const usage = fakeUsage(req, "");
      return {
        text: "",
        toolCalls,
        finishReason: "tool_calls",
        usage,
        costUsd: estimateCost(req.model, usage.promptTokens, usage.completionTokens),
      };
    }

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
    const toolCalls = mockToolCall(req);
    if (toolCalls.length) {
      const usage = fakeUsage(req, "");
      for (const [index, call] of toolCalls.entries()) {
        yield { type: "tool_call_start", index, id: call.id, name: call.name };
        yield { type: "tool_call_delta", index, argumentsDelta: call.argumentsJson };
      }
      yield {
        type: "done",
        finishReason: "tool_calls",
        usage,
        costUsd: estimateCost(req.model, usage.promptTokens, usage.completionTokens),
      };
      return;
    }

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
