/**
 * Engine backed by the Anthropic API with a pay-per-token API key.
 * Supports the full feature set including tool calling and vision.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { estimateCost } from "../models.js";
import { mapStopReason } from "../translate.js";
import type { ChatRequest, ChatResult, Engine, StreamEvent, ToolCall, Usage } from "../types.js";
import { EngineError } from "../types.js";

/**
 * Sampling parameters were removed on the current generation and return a 400.
 * OpenAI clients send temperature almost unconditionally, so drop it rather
 * than fail the request.
 */
const SAMPLING_ALLOWED = new Set(["claude-haiku-4-5"]);

/** Models that accept the server-side refusal fallback parameter. */
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5"]);

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
}

export class AnthropicApiEngine implements Engine {
  readonly name = "anthropic-api";
  private client: Anthropic | null = null;

  assertReady(): void {
    if (!config.anthropicApiKey) {
      throw new EngineError(
        "BACKEND=anthropic-api requires ANTHROPIC_API_KEY to be set.",
        503,
        "engine_not_configured",
      );
    }
  }

  private get anthropic(): Anthropic {
    this.assertReady();
    this.client ??= new Anthropic({
      apiKey: config.anthropicApiKey,
      timeout: config.requestTimeoutMs,
      maxRetries: 2,
    });
    return this.client;
  }

  /** Shared request body for both the streaming and non-streaming paths. */
  private body(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: req.messages,
      thinking: config.exposeThinking
        ? { type: "adaptive", display: "summarized" }
        : { type: "adaptive" },
    };

    if (req.system) body.system = req.system;
    if (req.stopSequences) body.stop_sequences = req.stopSequences;
    if (req.tools) body.tools = req.tools;
    if (req.toolChoice) body.tool_choice = req.toolChoice;

    if (SAMPLING_ALLOWED.has(req.model)) {
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.topP !== undefined) body.top_p = req.topP;
    }

    const effort = req.effort ?? config.defaultEffort;
    if (effort) body.output_config = { effort };

    if (config.refusalFallbacks && FALLBACK_MODELS.has(req.model)) {
      body.betas = [FALLBACK_BETA];
      body.fallbacks = "default";
    }

    return body;
  }

  /** The fallback parameter only exists on the beta namespace. */
  private endpoint(body: Record<string, unknown>) {
    return "fallbacks" in body ? this.anthropic.beta.messages : this.anthropic.messages;
  }

  async complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    const body = this.body(req);

    let msg: Anthropic.Messages.Message;
    try {
      msg = (await (this.endpoint(body) as { create: Function }).create(body, {
        signal,
      })) as Anthropic.Messages.Message;
    } catch (err) {
      throw wrapAnthropicError(err);
    }

    let text = "";
    const toolCalls: ToolCall[] = [];
    let reasoning = "";

    for (const block of msg.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "thinking") {
        reasoning += (block as { thinking?: string }).thinking ?? "";
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          argumentsJson: JSON.stringify(block.input ?? {}),
        });
      }
    }

    const usage: Usage = {
      promptTokens: msg.usage.input_tokens ?? 0,
      completionTokens: msg.usage.output_tokens ?? 0,
      cachedTokens: msg.usage.cache_read_input_tokens ?? 0,
    };

    return {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      finishReason: mapStopReason(msg.stop_reason),
      usage,
      costUsd: estimateCost(req.model, usage.promptTokens, usage.completionTokens),
    };
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent, void, void> {
    const body = { ...this.body(req), stream: true };

    let iterator: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>;
    try {
      iterator = (await (this.endpoint(body) as { create: Function }).create(body, {
        signal,
      })) as AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>;
    } catch (err) {
      throw wrapAnthropicError(err);
    }

    const usage = emptyUsage();
    let stopReason: string | null = null;

    // Anthropic indexes every content block; OpenAI indexes tool calls separately.
    const toolIndexByBlock = new Map<number, number>();
    let nextToolIndex = 0;

    try {
      for await (const event of iterator) {
        switch (event.type) {
          case "message_start": {
            const u = event.message.usage;
            usage.promptTokens = u?.input_tokens ?? 0;
            usage.cachedTokens = u?.cache_read_input_tokens ?? 0;
            break;
          }

          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              const index = nextToolIndex++;
              toolIndexByBlock.set(event.index, index);
              yield { type: "tool_call_start", index, id: block.id, name: block.name };
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              yield { type: "text", text: delta.text };
            } else if (delta.type === "thinking_delta") {
              const thinking = (delta as { thinking?: string }).thinking ?? "";
              if (thinking) yield { type: "reasoning", text: thinking };
            } else if (delta.type === "input_json_delta") {
              const index = toolIndexByBlock.get(event.index);
              if (index !== undefined) {
                yield { type: "tool_call_delta", index, argumentsDelta: delta.partial_json };
              }
            }
            break;
          }

          case "message_delta": {
            stopReason = event.delta.stop_reason ?? stopReason;
            if (event.usage?.output_tokens) usage.completionTokens = event.usage.output_tokens;
            break;
          }
        }
      }
    } catch (err) {
      throw wrapAnthropicError(err);
    }

    yield {
      type: "done",
      finishReason: mapStopReason(stopReason),
      usage,
      costUsd: estimateCost(req.model, usage.promptTokens, usage.completionTokens),
    };
  }
}

function wrapAnthropicError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;

  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 502;
    const code =
      status === 429
        ? "rate_limit_exceeded"
        : status === 401 || status === 403
          ? "authentication_error"
          : status === 400
            ? "invalid_request_error"
            : "upstream_error";
    return new EngineError(err.message, status, code);
  }

  if (err instanceof Error && err.name === "AbortError") {
    return new EngineError("Request aborted", 499, "request_aborted");
  }

  return new EngineError(err instanceof Error ? err.message : String(err), 502, "upstream_error");
}
