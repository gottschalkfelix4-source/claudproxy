/**
 * Tests for the OpenAI -> Anthropic translation, the part where subtle bugs
 * would otherwise only show up as odd model behaviour.
 *
 *   npm run build && node --test test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { toAnthropicMessages, buildChatRequest, mapStopReason } from "../dist/translate.js";
import { resolveModel, estimateCost } from "../dist/models.js";

const LIMITS = { defaultMaxTokens: 16000, maxTokensLimit: 64000 };

/* ------------------------------------------------------------------ */
/* message translation                                                 */
/* ------------------------------------------------------------------ */

test("hoists system messages into the system prompt", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
  ]);
  assert.equal(system, "Be brief.");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
});

test("joins multiple system and developer messages", () => {
  const { system } = toAnthropicMessages([
    { role: "system", content: "One." },
    { role: "developer", content: "Two." },
    { role: "user", content: "Hi" },
  ]);
  assert.equal(system, "One.\n\nTwo.");
});

test("merges consecutive same-role messages", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c" },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content.length, 2);
});

test("prepends a user turn when the conversation opens with the assistant", () => {
  const { messages } = toAnthropicMessages([{ role: "assistant", content: "Hello" }]);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].role, "assistant");
});

test("never returns an empty message list", () => {
  const { messages } = toAnthropicMessages([{ role: "system", content: "only system" }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
});

test("converts a data: URI into a base64 image block", () => {
  const { messages } = toAnthropicMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
      ],
    },
  ]);
  const image = messages[0].content.find((b) => b.type === "image");
  assert.equal(image.source.type, "base64");
  assert.equal(image.source.media_type, "image/png");
  assert.equal(image.source.data, "AAAB");
});

test("passes a plain image URL through as a url source", () => {
  const { messages } = toAnthropicMessages([
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
    },
  ]);
  assert.equal(messages[0].content[0].source.type, "url");
});

test("turns assistant tool_calls into tool_use blocks", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Berlin"}' } },
      ],
    },
  ]);
  const block = messages[1].content[0];
  assert.equal(block.type, "tool_use");
  assert.equal(block.name, "get_weather");
  assert.deepEqual(block.input, { city: "Berlin" });
});

test("survives malformed tool_call arguments instead of throwing", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "x" },
    {
      role: "assistant",
      tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{not json" } }],
    },
  ]);
  assert.equal(messages[1].content[0].input._raw, "{not json");
});

test("maps a tool result onto a user tool_result block", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "x" },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "22 degrees" },
  ]);
  const last = messages[messages.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content[0].type, "tool_result");
  assert.equal(last.content[0].tool_use_id, "c1");
});

/* ------------------------------------------------------------------ */
/* request building                                                    */
/* ------------------------------------------------------------------ */

test("clamps max_tokens to the configured ceiling", () => {
  const req = buildChatRequest(
    { messages: [{ role: "user", content: "x" }], max_tokens: 999_999 },
    "claude-opus-5",
    LIMITS,
  );
  assert.equal(req.maxTokens, 64000);
});

test("accepts max_completion_tokens as an alias", () => {
  const req = buildChatRequest(
    { messages: [{ role: "user", content: "x" }], max_completion_tokens: 500 },
    "claude-opus-5",
    LIMITS,
  );
  assert.equal(req.maxTokens, 500);
});

test("normalises a string stop value into an array", () => {
  const req = buildChatRequest(
    { messages: [{ role: "user", content: "x" }], stop: "END" },
    "claude-opus-5",
    LIMITS,
  );
  assert.deepEqual(req.stopSequences, ["END"]);
});

test("expresses JSON mode as a system instruction", () => {
  const req = buildChatRequest(
    { messages: [{ role: "user", content: "x" }], response_format: { type: "json_object" } },
    "claude-opus-5",
    LIMITS,
  );
  assert.match(req.system, /valid JSON object/);
});

test("keeps only recognised reasoning_effort values", () => {
  const ok = buildChatRequest(
    { messages: [{ role: "user", content: "x" }], reasoning_effort: "xhigh" },
    "claude-opus-5",
    LIMITS,
  );
  assert.equal(ok.effort, "xhigh");

  const bad = buildChatRequest(
    { messages: [{ role: "user", content: "x" }], reasoning_effort: "turbo" },
    "claude-opus-5",
    LIMITS,
  );
  assert.equal(bad.effort, undefined);
});

test("maps tool_choice variants", () => {
  const build = (tool_choice) =>
    buildChatRequest({ messages: [{ role: "user", content: "x" }], tool_choice }, "claude-opus-5", LIMITS)
      .toolChoice;

  assert.deepEqual(build("auto"), { type: "auto" });
  assert.deepEqual(build("required"), { type: "any" });
  assert.deepEqual(build({ type: "function", function: { name: "f" } }), { type: "tool", name: "f" });
  assert.equal(build("none"), undefined);
});

test("accepts the legacy functions field", () => {
  const req = buildChatRequest(
    {
      messages: [{ role: "user", content: "x" }],
      functions: [{ name: "legacy", parameters: { type: "object", properties: {} } }],
    },
    "claude-opus-5",
    LIMITS,
  );
  assert.equal(req.tools[0].name, "legacy");
});

test("rejects an empty messages array", () => {
  assert.throws(() => buildChatRequest({ messages: [] }, "claude-opus-5", LIMITS), /non-empty/);
});

/* ------------------------------------------------------------------ */
/* model resolution                                                    */
/* ------------------------------------------------------------------ */

test("resolves OpenAI names, aliases, prefixes and dated snapshots", () => {
  assert.equal(resolveModel("gpt-4o"), "claude-opus-5");
  assert.equal(resolveModel("gpt-3.5-turbo"), "claude-haiku-4-5");
  assert.equal(resolveModel("opus"), "claude-opus-5");
  assert.equal(resolveModel("anthropic/claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(resolveModel("claude-code-cli/haiku"), "claude-haiku-4-5");
  assert.equal(resolveModel("CLAUDE-OPUS-5"), "claude-opus-5");
  assert.equal(resolveModel("claude-opus-5-20260101"), "claude-opus-5");
  assert.equal(resolveModel("llama-3-70b"), null);
  assert.equal(resolveModel(""), null);
  assert.equal(resolveModel(undefined), null);
});

test("prices a known model and ignores an unknown one", () => {
  // 1M in + 1M out on Opus 5 = $5 + $25.
  assert.equal(estimateCost("claude-opus-5", 1_000_000, 1_000_000), 30);
  assert.equal(estimateCost("nope", 1000, 1000), 0);
});

/* ------------------------------------------------------------------ */
/* stop reasons                                                        */
/* ------------------------------------------------------------------ */

test("maps Anthropic stop reasons to OpenAI finish reasons", () => {
  assert.equal(mapStopReason("end_turn"), "stop");
  assert.equal(mapStopReason("stop_sequence"), "stop");
  assert.equal(mapStopReason("max_tokens"), "length");
  assert.equal(mapStopReason("tool_use"), "tool_calls");
  assert.equal(mapStopReason("refusal"), "content_filter");
  assert.equal(mapStopReason(null), "stop");
});
