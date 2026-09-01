/** OpenAI <-> Anthropic translation, both directions. */

import crypto from "node:crypto";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicToolDef,
  ChatRequest,
  ChatResult,
  FinishReason,
  ToolCall,
  Usage,
} from "./types.js";
import { EngineError } from "./types.js";

/* ------------------------------------------------------------------ */
/* incoming OpenAI shapes                                              */
/* ------------------------------------------------------------------ */

export interface OpenAIContentPart {
  type: "text" | "image_url" | "input_text" | "input_image";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool" | "function";
  content?: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIChatRequest {
  model?: string;
  messages?: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: { type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
  functions?: { name: string; description?: string; parameters?: Record<string, unknown> }[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: unknown };
  reasoning_effort?: string;
  n?: number;
  user?: string;
}

/* ------------------------------------------------------------------ */
/* OpenAI -> Anthropic                                                 */
/* ------------------------------------------------------------------ */

function partsToText(parts: OpenAIContentPart[]): string {
  return parts
    .filter((p) => p.type === "text" || p.type === "input_text")
    .map((p) => p.text ?? "")
    .join("");
}

/** Accepts a `data:` URI or a plain https URL and produces an Anthropic image block. */
function imageBlock(url: string): AnthropicContentBlock {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) {
    return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  }
  return { type: "image", source: { type: "url", url } };
}

function contentToBlocks(content: string | OpenAIContentPart[] | null | undefined): AnthropicContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text" || part.type === "input_text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if ((part.type === "image_url" || part.type === "input_image") && part.image_url?.url) {
      blocks.push(imageBlock(part.image_url.url));
    }
  }
  return blocks;
}

/**
 * Converts an OpenAI message array into an Anthropic system prompt plus messages.
 *
 * Notable rules:
 *  - system/developer messages are hoisted into the top-level system prompt
 *  - role "tool" becomes a user message holding a tool_result block
 *  - assistant tool_calls become tool_use blocks
 *  - consecutive same-role messages are merged, since Anthropic wants them alternating
 *  - the conversation must open with a user turn
 */
export function toAnthropicMessages(msgs: OpenAIMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  const push = (role: "user" | "assistant", blocks: AnthropicContentBlock[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      (last.content as AnthropicContentBlock[]).push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  };

  for (const m of msgs) {
    switch (m.role) {
      case "system":
      case "developer": {
        const text = typeof m.content === "string" ? m.content : partsToText(m.content ?? []);
        if (text) systemParts.push(text);
        break;
      }

      case "user":
        push("user", contentToBlocks(m.content));
        break;

      case "assistant": {
        const blocks = contentToBlocks(m.content);
        for (const tc of m.tool_calls ?? []) {
          let input: unknown = {};
          try {
            input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            input = { _raw: tc.function.arguments };
          }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
        push("assistant", blocks);
        break;
      }

      case "tool":
      case "function": {
        const text = typeof m.content === "string" ? m.content : partsToText(m.content ?? []);
        push("user", [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? m.name ?? "unknown",
            content: text,
          },
        ]);
        break;
      }
    }
  }

  // Anthropic requires the first turn to be from the user.
  if (out.length === 0) {
    out.push({ role: "user", content: [{ type: "text", text: "" }] });
  } else if (out[0].role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  }

  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

function toAnthropicTools(body: OpenAIChatRequest): AnthropicToolDef[] | undefined {
  const defs: AnthropicToolDef[] = [];

  for (const t of body.tools ?? []) {
    if (t.type !== "function") continue;
    defs.push({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    });
  }
  // Legacy `functions` field.
  for (const f of body.functions ?? []) {
    defs.push({
      name: f.name,
      description: f.description,
      input_schema: (f.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
    });
  }

  return defs.length ? defs : undefined;
}

function toAnthropicToolChoice(
  choice: OpenAIChatRequest["tool_choice"],
): ChatRequest["toolChoice"] {
  if (!choice || choice === "none") return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.function?.name) {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Builds the internal request. `model` must already be resolved to a Claude id. */
export function buildChatRequest(
  body: OpenAIChatRequest,
  model: string,
  limits: { defaultMaxTokens: number; maxTokensLimit: number },
): ChatRequest {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new EngineError("'messages' must be a non-empty array", 400, "invalid_request_error");
  }

  const { system, messages } = toAnthropicMessages(body.messages);

  const requested = body.max_completion_tokens ?? body.max_tokens ?? limits.defaultMaxTokens;
  const maxTokens = Math.max(1, Math.min(requested, limits.maxTokensLimit));

  let stopSequences: string[] | undefined;
  if (typeof body.stop === "string") stopSequences = [body.stop];
  else if (Array.isArray(body.stop)) stopSequences = body.stop.filter((s) => typeof s === "string");

  let systemPrompt = system;
  // OpenAI's JSON mode has no Anthropic equivalent; the closest honest mapping is
  // a system instruction.
  if (body.response_format?.type === "json_object") {
    systemPrompt = [systemPrompt, "Respond with a single valid JSON object and nothing else."]
      .filter(Boolean)
      .join("\n\n");
  } else if (body.response_format?.type === "json_schema") {
    systemPrompt = [
      systemPrompt,
      "Respond with a single valid JSON object matching this JSON Schema and nothing else:\n" +
        JSON.stringify(body.response_format.json_schema),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const effort =
    body.reasoning_effort && EFFORTS.has(body.reasoning_effort)
      ? (body.reasoning_effort as ChatRequest["effort"])
      : undefined;

  return {
    model,
    system: systemPrompt,
    messages,
    maxTokens,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    topP: typeof body.top_p === "number" ? body.top_p : undefined,
    stopSequences: stopSequences?.length ? stopSequences : undefined,
    tools: toAnthropicTools(body),
    toolChoice: toAnthropicToolChoice(body.tool_choice),
    effort,
    stream: body.stream === true,
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic -> OpenAI                                                 */
/* ------------------------------------------------------------------ */

export function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

export function newCompletionId(): string {
  return "chatcmpl-" + crypto.randomBytes(12).toString("hex");
}

function usageBlock(usage: Usage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedTokens },
  };
}

export function toOpenAICompletion(id: string, model: string, result: ChatResult) {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.text || null,
  };
  if (result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.argumentsJson },
    }));
  }

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: result.finishReason }],
    usage: usageBlock(result.usage),
  };
}

type Delta = Record<string, unknown>;

export function streamChunk(
  id: string,
  model: string,
  created: number,
  delta: Delta,
  finishReason: FinishReason | null = null,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
}

/** Terminal chunk carrying usage, sent when the client asked for stream_options.include_usage. */
export function usageChunk(id: string, model: string, created: number, usage: Usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage: usageBlock(usage),
  };
}

export function toolCallDeltaChunk(
  id: string,
  model: string,
  created: number,
  index: number,
  fields: { id?: string; name?: string; argumentsDelta?: string },
) {
  const fn: Record<string, unknown> = {};
  if (fields.name !== undefined) fn.name = fields.name;
  if (fields.argumentsDelta !== undefined) fn.arguments = fields.argumentsDelta;

  const call: Record<string, unknown> = { index, function: fn };
  if (fields.id !== undefined) {
    call.id = fields.id;
    call.type = "function";
  }

  return streamChunk(id, model, created, { tool_calls: [call] });
}

export function emptyToolCalls(): ToolCall[] {
  return [];
}
