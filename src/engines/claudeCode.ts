/**
 * Engine backed by the Claude Code harness (Claude Agent SDK).
 *
 * This is the path that uses a Claude Pro/Max subscription instead of
 * pay-per-token API billing: the harness authenticates with the OAuth
 * credentials Claude Code already holds.
 *
 * One structural limitation shapes the code below. The SDK's input channel only
 * accepts *user* messages, so a multi-turn OpenAI conversation cannot be
 * replayed turn by turn. Prior turns are serialised into a transcript block
 * inside the single user message we send; the newest user turn is kept intact
 * so images and text still arrive as real content blocks.
 *
 * Tool calling works by inverting what the SDK expects. The SDK is built to
 * *execute* tools; an OpenAI client wants them handed back so it can execute
 * them itself. So the client's functions are registered as an in-process MCP
 * server whose handlers do not perform anything: they capture the arguments,
 * stop the run, and the call is returned to the client as `tool_calls`. The
 * result the client sends back arrives as a normal message and is replayed in
 * the transcript.
 */

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  McpServerConfig,
  SDKMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import { config } from "../config.js";
import { estimateCost } from "../models.js";
import { mapStopReason } from "../translate.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  ChatRequest,
  ChatResult,
  Engine,
  StreamEvent,
  ToolCall,
  Usage,
} from "../types.js";
import { EngineError } from "../types.js";
import { settings } from "../settings.js";
import { toZodShape } from "../jsonSchemaToZod.js";
import crypto from "node:crypto";

/** Every built-in tool, denied so the proxy behaves like a plain chat endpoint. */
const ALL_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Edit",
  "Write",
  "Read",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TodoWrite",
  "SlashCommand",
  "Skill",
  "ListMcpResources",
  "ReadMcpResource",
];

/** MCP server name the client's functions are registered under. */
const TOOL_SERVER = "openai_tools";

interface ToolBridge {
  /** Filled by a handler when the model decides to call one of the tools. */
  calls: ToolCall[];
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools: string[];
}

function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
}

function blocksToText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "image") return "[image]";
      // Tool traffic is replayed as readable text: the SDK's input channel
      // cannot carry real tool_use/tool_result blocks, so the model has to be
      // able to follow the exchange from the transcript alone.
      if (b.type === "tool_use") {
        return `[called tool "${b.name}" with arguments ${JSON.stringify(b.input ?? {})}]`;
      }
      if (b.type === "tool_result") {
        return `[result of that tool call]
${b.content}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Splits the conversation into a serialised transcript of the earlier turns and
 * the content blocks of the final user turn.
 */
function buildPrompt(messages: AnthropicMessage[]): AnthropicContentBlock[] {
  const last = messages[messages.length - 1];
  const history = messages.slice(0, -1);

  const lastBlocks: AnthropicContentBlock[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : [...last.content];

  if (!history.length) return lastBlocks;

  const transcript = history
    .map((m) => `<turn role="${m.role}">\n${blocksToText(m.content)}\n</turn>`)
    .join("\n");

  const preamble: AnthropicContentBlock = {
    type: "text",
    text:
      "Here is the conversation so far. Continue it naturally as the assistant, " +
      "answering only the final user message. Do not repeat or summarise the transcript.\n\n" +
      `<transcript>\n${transcript}\n</transcript>\n\n` +
      "Final user message follows.",
  };

  // A trailing assistant turn means the client wants a continuation, so the
  // final "user turn" is the transcript itself.
  if (last.role === "assistant") {
    return [
      {
        type: "text",
        text:
          preamble.type === "text"
            ? preamble.text.replace("Final user message follows.", "Continue from here.")
            : "",
      },
      ...lastBlocks,
    ];
  }

  return [preamble, ...lastBlocks];
}

export class ClaudeCodeEngine implements Engine {
  readonly name = "claude-code";

  assertReady(): void {
    const hasToken = Boolean(settings.claudeCodeOAuthToken);
    const hasCredentialsFile = (() => {
      try {
        return fs.existsSync(config.claudeConfigDir + "/.credentials.json");
      } catch {
        return false;
      }
    })();

    if (!hasToken && !hasCredentialsFile) {
      throw new EngineError(
        "Für das Backend „Claude-Abo“ fehlen die Zugangsdaten. " +
          "Melde dich im Web-Interface unter Einstellungen → Bei Claude anmelden an.",
        503,
        "engine_not_configured",
      );
    }
  }

  private options(req: ChatRequest, abort: AbortController, bridge: ToolBridge) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLAUDE_CONFIG_DIR: config.claudeConfigDir,
    };
    if (settings.claudeCodeOAuthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = settings.claudeCodeOAuthToken;
    }
    // An API key in the environment would shadow the subscription OAuth token.
    delete env.ANTHROPIC_API_KEY;

    return {
      model: req.model,
      systemPrompt: req.system,
      maxTurns: 1,
      // Only the client's own functions are allowed; the built-ins stay denied
      // so the proxy never touches the host on a chat request.
      allowedTools: bridge.allowedTools,
      disallowedTools: ALL_TOOLS,
      ...(bridge.mcpServers ? { mcpServers: bridge.mcpServers } : {}),
      settingSources: [] as [],
      permissionMode: "bypassPermissions" as const,
      persistSession: false,
      cwd: config.workDir,
      env,
      abortController: abort,
    };
  }

  private userMessage(blocks: AnthropicContentBlock[]): SDKUserMessage {
    return {
      type: "user",
      message: { role: "user", content: blocks as never },
      parent_tool_use_id: null,
      session_id: "",
    } as SDKUserMessage;
  }

  /** Single-message input stream; the SDK closes the turn when it ends. */
  private async *promptStream(blocks: AnthropicContentBlock[]) {
    yield this.userMessage(blocks);
  }

  /**
   * Registers the client's functions as an in-process MCP server whose handlers
   * capture instead of execute, and stops the run on the first call so the
   * client gets it back rather than the model continuing without it.
   */
  private bridgeTools(req: ChatRequest, abort: AbortController): ToolBridge {
    const calls: ToolCall[] = [];

    if (!req.tools?.length) {
      return { calls, mcpServers: undefined, allowedTools: [] };
    }

    const defs = req.tools.map((t) =>
      tool(
        t.name,
        t.description ?? "",
        toZodShape(t.input_schema as never),
        async (args: unknown) => {
          calls.push({
            id: "call_" + crypto.randomBytes(12).toString("hex"),
            name: t.name,
            argumentsJson: JSON.stringify(args ?? {}),
          });

          // Let the SDK finish emitting this tool_use before the run is torn
          // down, then stop: executing it is the client's job.
          setTimeout(() => abort.abort(), 0);

          return {
            content: [
              { type: "text" as const, text: "Result will be provided by the caller." },
            ],
          };
        },
      ),
    );

    return {
      calls,
      mcpServers: {
        [TOOL_SERVER]: createSdkMcpServer({ name: TOOL_SERVER, tools: defs, alwaysLoad: true }),
      },
      // Server-level specs plus the explicit names. The wildcard forms cover a
      // tool whose name gets normalised (anything outside [a-zA-Z0-9_-] becomes
      // an underscore), the explicit ones cover a harness that only honours
      // fully-qualified entries.
      allowedTools: [
        `mcp__${TOOL_SERVER}`,
        `mcp__${TOOL_SERVER}__*`,
        ...req.tools.map((t) => `mcp__${TOOL_SERVER}__${t.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`),
      ],
    };
  }

  async complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    this.assertReady();

    const abort = new AbortController();
    signal.addEventListener("abort", () => abort.abort(), { once: true });
    const bridge = this.bridgeTools(req, abort);

    let text = "";
    let usage = emptyUsage();
    let costUsd: number | undefined;
    let stopReason: string | null = null;

    try {
      for await (const msg of query({
        prompt: this.promptStream(buildPrompt(req.messages)),
        options: this.options(req, abort, bridge),
      }) as AsyncIterable<SDKMessage>) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") text += block.text;
          }
          stopReason = msg.message.stop_reason ?? stopReason;
        } else if (msg.type === "result") {
          assertResultOk(msg);
          // The result carries the authoritative final text.
          if (msg.result) text = msg.result;
          usage = readUsage(msg);
          costUsd = msg.total_cost_usd;
          stopReason = msg.stop_reason ?? stopReason;
          break;
        }
      }
    } catch (err) {
      // Stopping the run is how a captured tool call ends; that is a success.
      if (!bridge.calls.length || !isAbort(err)) throw wrapSdkError(err);
    } finally {
      abort.abort();
    }

    // The harness reports its own estimate; fall back to list pricing when it
    // does not, so budgets still have something to count.
    costUsd ??= estimateCost(req.model, usage.promptTokens, usage.completionTokens);

    return {
      text,
      toolCalls: bridge.calls,
      finishReason: bridge.calls.length ? "tool_calls" : mapStopReason(stopReason),
      usage,
      costUsd,
    };
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent, void, void> {
    this.assertReady();

    const abort = new AbortController();
    signal.addEventListener("abort", () => abort.abort(), { once: true });
    const bridge = this.bridgeTools(req, abort);

    let usage = emptyUsage();
    let costUsd: number | undefined;
    let stopReason: string | null = null;
    let streamedChars = 0;
    let fallbackText = "";

    try {
      for await (const msg of query({
        prompt: this.promptStream(buildPrompt(req.messages)),
        options: { ...this.options(req, abort, bridge), includePartialMessages: true },
      }) as AsyncIterable<SDKMessage>) {
        if (msg.type === "stream_event") {
          const event = msg.event;
          if (event.type === "content_block_delta") {
            const delta = event.delta as { type: string; text?: string; thinking?: string };
            if (delta.type === "text_delta" && delta.text) {
              streamedChars += delta.text.length;
              yield { type: "text", text: delta.text };
            } else if (delta.type === "thinking_delta" && settings.exposeThinking && delta.thinking) {
              yield { type: "reasoning", text: delta.thinking };
            }
          } else if (event.type === "message_delta") {
            stopReason = event.delta?.stop_reason ?? stopReason;
          }
        } else if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") fallbackText += block.text;
          }
          stopReason = msg.message.stop_reason ?? stopReason;
        } else if (msg.type === "result") {
          assertResultOk(msg);
          usage = readUsage(msg);
          costUsd = msg.total_cost_usd;
          stopReason = msg.stop_reason ?? stopReason;

          // No partial events arrived (older harness, or a non-streaming turn):
          // emit the whole answer at once so the client still gets its text.
          if (streamedChars === 0 && !bridge.calls.length) {
            const text = msg.result || fallbackText;
            if (text) yield { type: "text", text };
          }
          break;
        }
      }
    } catch (err) {
      // Stopping the run is how a captured tool call ends; that is a success.
      if (!bridge.calls.length || !isAbort(err)) throw wrapSdkError(err);
    } finally {
      abort.abort();
    }

    // Tool calls are emitted whole: the arguments come from the handler already
    // parsed, which is more reliable than reassembling partial JSON deltas.
    for (const [index, call] of bridge.calls.entries()) {
      yield { type: "tool_call_start", index, id: call.id, name: call.name };
      yield { type: "tool_call_delta", index, argumentsDelta: call.argumentsJson };
    }

    yield {
      type: "done",
      finishReason: bridge.calls.length ? "tool_calls" : mapStopReason(stopReason),
      usage,
      costUsd: costUsd ?? estimateCost(req.model, usage.promptTokens, usage.completionTokens),
    };
  }
}

/** An abort we triggered ourselves after capturing a tool call. */
function isAbort(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    return /abort/i.test(err.message);
  }
  return false;
}

/**
 * Turns a failed result into an EngineError.
 *
 * The harness reports upstream failures — an expired token, a subscription rate
 * limit — as `subtype: "success"` with `is_error: true` and the message in
 * `result`. Checking only the subtype would hand the client an auth error
 * dressed up as a normal model reply.
 */
function assertResultOk(msg: SDKResultMessage): asserts msg is SDKResultSuccess {
  if (msg.subtype === "success" && !msg.is_error) return;

  const detail =
    ("result" in msg && msg.result) || `Claude Code returned ${msg.subtype}`;
  const status = ("api_error_status" in msg && msg.api_error_status) || 502;

  const code =
    status === 401 || status === 403
      ? "authentication_error"
      : status === 429
        ? "rate_limit_exceeded"
        : status === 400
          ? "invalid_request_error"
          : "upstream_error";

  const hint =
    code === "authentication_error"
      ? " — run `claude setup-token` and update CLAUDE_CODE_OAUTH_TOKEN."
      : code === "rate_limit_exceeded"
        ? " — this is your Claude subscription limit, not a proxy limit."
        : "";

  throw new EngineError(detail + hint, status, code);
}

/** Prefers modelUsage, which covers the whole query pipeline, over the main-loop usage. */
function readUsage(msg: {
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, Record<string, unknown>>;
}): Usage {
  const out = emptyUsage();

  const models = msg.modelUsage ? Object.values(msg.modelUsage) : [];
  if (models.length) {
    for (const m of models) {
      out.promptTokens += Number(m.inputTokens ?? m.input_tokens ?? 0);
      out.completionTokens += Number(m.outputTokens ?? m.output_tokens ?? 0);
      out.cachedTokens += Number(m.cacheReadInputTokens ?? m.cache_read_input_tokens ?? 0);
    }
    if (out.promptTokens || out.completionTokens) return out;
  }

  const u = msg.usage ?? {};
  out.promptTokens = Number(u.input_tokens ?? 0);
  out.completionTokens = Number(u.output_tokens ?? 0);
  out.cachedTokens = Number(u.cache_read_input_tokens ?? 0);
  return out;
}

function wrapSdkError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;

  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(message))) {
    return new EngineError("Request aborted", 499, "request_aborted");
  }
  if (/rate.?limit|usage limit|429/i.test(message)) {
    return new EngineError(message, 429, "rate_limit_exceeded");
  }
  if (/unauthorized|authentication|401|403|not logged in|credentials/i.test(message)) {
    return new EngineError(
      message + " — run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN.",
      401,
      "authentication_error",
    );
  }
  if (/ENOENT|not found|spawn/i.test(message)) {
    return new EngineError(
      "Could not start the Claude Code harness: " + message,
      503,
      "engine_not_configured",
    );
  }

  return new EngineError(message, 502, "upstream_error");
}
