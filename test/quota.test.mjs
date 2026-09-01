/**
 * Recognising an exhausted subscription allowance.
 *
 * The API reports it with a 400, which reads to a client as "your request was
 * malformed". It is not — the request is fine, the account's allowance is used
 * up, which OpenAI clients expect as 429 / insufficient_quota.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isQuotaExhausted } from "../dist/engines/claudeCode.js";

test("recognises the message Claude actually sends", () => {
  // Verbatim from a live subscription that ran dry.
  assert.ok(
    isQuotaExhausted(
      "API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
    ),
  );
});

test("recognises the other exhaustion wordings", () => {
  for (const m of [
    "You have reached your usage limit for Claude Opus",
    "Your credit balance is too low to access the API",
    "out of credits",
    "insufficient_quota",
  ]) {
    assert.ok(isQuotaExhausted(m), `should match: ${m}`);
  }
});

test("does not fire on unrelated failures", () => {
  for (const m of [
    "401 OAuth access token is invalid",
    "Rate limit of 4 requests/min exceeded",
    "messages: at least one message is required",
    "Could not start the Claude Code harness",
    "The model produced a usage report",
  ]) {
    assert.equal(isQuotaExhausted(m), false, `should not match: ${m}`);
  }
});
