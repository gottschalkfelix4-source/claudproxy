/** Shared request/response shapes. Anthropic's format is the internal one. */

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** A normalised chat request, after OpenAI -> Anthropic translation. */
export interface ChatRequest {
  /** Canonical Claude model id. */
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  tools?: AnthropicToolDef[];
  toolChoice?: { type: "auto" | "any" | "tool"; name?: string };
  /** Maps from OpenAI's reasoning_effort. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  stream: boolean;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/** Non-streaming engine result. */
export interface ChatResult {
  text: string;
  /** Summarised thinking, only when EXPOSE_THINKING is on. */
  reasoning?: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  /** Reported by the engine when it knows the real number; else derived from token counts. */
  costUsd?: number;
}

/** Streaming engine events, already normalised away from provider specifics. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  | { type: "done"; finishReason: FinishReason; usage: Usage; costUsd?: number };

export interface Engine {
  readonly name: string;
  /** Throws EngineError when misconfigured. */
  assertReady(): void;
  complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent, void, void>;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code = "engine_error",
  ) {
    super(message);
    this.name = "EngineError";
  }
}
