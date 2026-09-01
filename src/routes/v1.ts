import { Router, type Request, type Response } from "express";
import { apiKeyAuth, checkModelAllowed, clientIp, sendError } from "../auth.js";
import { config } from "../config.js";
import { addSpend, logRequest } from "../db.js";
import { getEngine } from "../engines/index.js";
import { openAiModelList, resolveModel, getModelInfo } from "../models.js";
import {
  buildChatRequest,
  newCompletionId,
  type OpenAIChatRequest,
  streamChunk,
  toolCallDeltaChunk,
  toOpenAICompletion,
  usageChunk,
} from "../translate.js";
import type { ChatRequest, FinishReason, Usage } from "../types.js";
import { EngineError } from "../types.js";
import { settings } from "../settings.js";

export const v1Router = Router();

/* ------------------------------------------------------------------ */
/* models                                                              */
/* ------------------------------------------------------------------ */

v1Router.get("/models", apiKeyAuth, (_req, res) => {
  res.json(openAiModelList());
});

v1Router.get("/models/:model", apiKeyAuth, (req, res) => {
  const requested = String(req.params.model ?? "");
  const id = resolveModel(requested);
  const info = id ? getModelInfo(id) : undefined;
  if (!info) {
    return sendError(res, 404, `Model '${requested}' not found.`, "model_not_found");
  }
  res.json({
    id: info.id,
    object: "model",
    created: 1_700_000_000,
    owned_by: "anthropic",
    context_window: info.contextWindow,
    max_output_tokens: info.maxOutput,
  });
});

/* ------------------------------------------------------------------ */
/* chat completions                                                    */
/* ------------------------------------------------------------------ */

interface Prepared {
  chatReq: ChatRequest;
  model: string;
  requestedModel: string;
}

/** Validates the request and resolves the model, or sends the error itself. */
function prepare(req: Request, res: Response): Prepared | null {
  const body = req.body as OpenAIChatRequest;

  if (!body || typeof body !== "object") {
    sendError(res, 400, "Request body must be a JSON object.", "invalid_request_error");
    return null;
  }

  const requestedModel = body.model ?? settings.defaultModel;
  const model = resolveModel(requestedModel) ?? resolveModel(settings.defaultModel);

  if (!model) {
    sendError(
      res,
      404,
      `Model '${requestedModel}' is not available on this proxy.`,
      "model_not_found",
    );
    return null;
  }

  const denied = checkModelAllowed(req.apiKey, model);
  if (denied) {
    sendError(res, 403, denied, "model_not_allowed");
    return null;
  }

  try {
    const chatReq = buildChatRequest(body, model, {
      defaultMaxTokens: settings.defaultMaxTokens,
      maxTokensLimit: settings.maxTokensLimit,
    });
    return { chatReq, model, requestedModel };
  } catch (err) {
    const e = err instanceof EngineError ? err : null;
    sendError(
      res,
      e?.status ?? 400,
      err instanceof Error ? err.message : String(err),
      e?.code ?? "invalid_request_error",
    );
    return null;
  }
}

/**
 * Retries once on a different model when the subscription allowance for the
 * requested one is used up. Claude subscriptions meter the model tiers
 * separately, so Opus running dry does not mean Sonnet has.
 */
function quotaFallbackFor(req: ChatRequest): string | null {
  const fallback = settings.quotaFallbackModel;
  if (!fallback || fallback === req.model) return null;
  return fallback;
}

function isQuota(err: unknown): boolean {
  return err instanceof EngineError && err.code === "insufficient_quota";
}

function record(
  req: Request,
  prep: Prepared,
  status: number,
  usage: Usage,
  costUsd: number,
  startedAt: number,
  streamed: boolean,
  error?: string,
): void {
  const keyId = req.apiKey?.id ?? null;
  logRequest({
    keyId,
    model: prep.requestedModel,
    resolvedModel: prep.model,
    engine: settings.backend,
    status,
    streamed,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costUsd,
    durationMs: Date.now() - startedAt,
    error: error ?? null,
    ip: clientIp(req),
  });
  if (keyId && costUsd) addSpend(keyId, costUsd);
}

v1Router.post("/chat/completions", apiKeyAuth, async (req: Request, res: Response) => {
  // Reassigned when a quota fallback switches models mid-flight.
  let prep = prepare(req, res);
  if (!prep) return;

  const startedAt = Date.now();
  const engine = getEngine();
  const abort = new AbortController();
  const zeroUsage: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  /* ---------------- non-streaming ---------------- */
  if (!prep.chatReq.stream) {
    try {
      let usedModel = prep.model;
      let result;
      try {
        result = await engine.complete(prep.chatReq, abort.signal);
      } catch (err) {
        const fallback = isQuota(err) ? quotaFallbackFor(prep.chatReq) : null;
        if (!fallback) throw err;
        usedModel = fallback;
        result = await engine.complete({ ...prep.chatReq, model: fallback }, abort.signal);
      }
      const payload = toOpenAICompletion(newCompletionId(), usedModel, result);
      record(req, { ...prep, model: usedModel }, 200, result.usage, result.costUsd ?? 0, startedAt, false);
      res.json(payload);
    } catch (err) {
      const e = toEngineError(err);
      record(req, prep, e.status, zeroUsage, 0, startedAt, false, e.message);
      sendError(res, e.status, e.message, e.code);
    }
    return;
  }

  /* ---------------- streaming ---------------- */
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const includeUsage = (req.body as OpenAIChatRequest).stream_options?.include_usage === true;

  const send = (obj: unknown) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  let finalUsage: Usage = zeroUsage;
  let finalCost = 0;
  let finishReason: FinishReason = "stop";
  let opened = false;

  try {
    // Resolve the first event before committing to a 200, so an immediate
    // upstream failure can still be reported as a normal JSON error — and so a
    // quota fallback can still switch models before anything has been sent.
    let iterator = engine.stream(prep.chatReq, abort.signal)[Symbol.asyncIterator]();
    let step;
    try {
      step = await iterator.next();
    } catch (err) {
      const fallback = isQuota(err) ? quotaFallbackFor(prep.chatReq) : null;
      if (!fallback) throw err;
      prep = { ...prep, model: fallback };
      iterator = engine
        .stream({ ...prep.chatReq, model: fallback }, abort.signal)
        [Symbol.asyncIterator]();
      step = await iterator.next();
    }

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    opened = true;

    send(streamChunk(id, prep.model, created, { role: "assistant", content: "" }));

    while (!step.done) {
      const event = step.value;
      switch (event.type) {
        case "text":
          send(streamChunk(id, prep.model, created, { content: event.text }));
          break;
        case "reasoning":
          send(streamChunk(id, prep.model, created, { reasoning_content: event.text }));
          break;
        case "tool_call_start":
          send(
            toolCallDeltaChunk(id, prep.model, created, event.index, {
              id: event.id,
              name: event.name,
              argumentsDelta: "",
            }),
          );
          break;
        case "tool_call_delta":
          send(
            toolCallDeltaChunk(id, prep.model, created, event.index, {
              argumentsDelta: event.argumentsDelta,
            }),
          );
          break;
        case "done":
          finishReason = event.finishReason;
          finalUsage = event.usage;
          finalCost = event.costUsd ?? 0;
          break;
      }
      step = await iterator.next();
    }

    send(streamChunk(id, prep.model, created, {}, finishReason));
    if (includeUsage) send(usageChunk(id, prep.model, created, finalUsage));
    res.write("data: [DONE]\n\n");
    res.end();

    record(req, prep, 200, finalUsage, finalCost, startedAt, true);
  } catch (err) {
    const e = toEngineError(err);
    record(req, prep, e.status, finalUsage, finalCost, startedAt, true, e.message);

    if (!opened) {
      sendError(res, e.status, e.message, e.code);
      return;
    }
    // Mid-stream: the status line is already sent, so report the failure as a
    // final SSE frame rather than a dead connection.
    send({ error: { message: e.message, type: e.code, code: e.code } });
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

/* ------------------------------------------------------------------ */
/* legacy completions                                                  */
/* ------------------------------------------------------------------ */

v1Router.post("/completions", apiKeyAuth, async (req: Request, res: Response) => {
  const body = req.body as { prompt?: string | string[]; model?: string; stream?: boolean };
  const prompt = Array.isArray(body?.prompt) ? body.prompt.join("\n") : (body?.prompt ?? "");

  if (!prompt) {
    return sendError(res, 400, "'prompt' is required.", "invalid_request_error");
  }
  if (body.stream) {
    return sendError(
      res,
      400,
      "Streaming is not supported on the legacy /v1/completions endpoint. Use /v1/chat/completions.",
      "unsupported_parameter",
    );
  }

  // Reuse the chat path by rewriting the body in place.
  req.body = { ...body, messages: [{ role: "user", content: prompt }], stream: false };

  const prep = prepare(req, res);
  if (!prep) return;

  const startedAt = Date.now();
  const abort = new AbortController();

  try {
    const result = await getEngine().complete(prep.chatReq, abort.signal);
    record(req, prep, 200, result.usage, result.costUsd ?? 0, startedAt, false);
    res.json({
      id: "cmpl-" + newCompletionId().slice(9),
      object: "text_completion",
      created: Math.floor(Date.now() / 1000),
      model: prep.model,
      choices: [
        { text: result.text, index: 0, logprobs: null, finish_reason: result.finishReason },
      ],
      usage: {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.promptTokens + result.usage.completionTokens,
      },
    });
  } catch (err) {
    const e = toEngineError(err);
    record(
      req,
      prep,
      e.status,
      { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      0,
      startedAt,
      false,
      e.message,
    );
    sendError(res, e.status, e.message, e.code);
  }
});

v1Router.post("/embeddings", apiKeyAuth, (_req, res) => {
  sendError(
    res,
    501,
    "Anthropic does not provide an embeddings API. Point your embedding client at a " +
      "dedicated provider (e.g. Voyage AI or a local model).",
    "not_implemented",
  );
});

function toEngineError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  return new EngineError(err instanceof Error ? err.message : String(err), 500, "internal_error");
}
