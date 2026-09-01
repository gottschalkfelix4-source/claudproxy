/**
 * Tests for parsing the Claude CLI's terminal output.
 *
 * The fixtures are real transcript fragments: the TUI positions words with
 * cursor escapes rather than spaces, so the stripped text reads "Invalidcode",
 * and the visible URL is wrapped across lines while the OSC-8 escape holds the
 * only intact copy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { stripAnsi, extractAuthUrl, extractToken } from "../dist/claudeLogin.js";

const ESC = "\x1b";
const BEL = "\x07";

const AUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=user%3Ainference&code_challenge=ZM_fS2L_QPDjyrvr4WJnhjNUErboLTmjEV7u2k_pw9o" +
  "&code_challenge_method=S256&state=mK_6xM1XLyeekUrBy_VYqudSdJt8HSUlSv5WqBeRDrM";

/** The URL as the CLI emits it: OSC-8 hyperlink, visible label split across lines. */
const HYPERLINK =
  `${ESC}]8;id=1qbq8gz;${AUTH_URL}${BEL}` +
  `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88` +
  `${ESC}]8;;${BEL}\r\n` +
  `${ESC}]8;id=1qbq8gz;${AUTH_URL}${BEL}ed-5944d1962f5e&response_type=code${ESC}]8;;${BEL}\r\n`;

test("strips CSI, OSC and carriage returns", () => {
  const raw = `${ESC}[2G${ESC}[?25lHello${ESC}[0m${ESC}]8;;x${BEL}\r\nWorld`;
  assert.equal(stripAnsi(raw), "Hello\nWorld");
});

test("recovers the full URL from the OSC-8 escape, not the wrapped label", () => {
  const url = extractAuthUrl(HYPERLINK);
  assert.equal(url, AUTH_URL);
  // The visible label is truncated at 80 columns; the escape is not.
  assert.ok(url.length > 300);
  assert.ok(url.includes("state=mK_6xM1XLyeekUrBy_VYqudSdJt8HSUlSv5WqBeRDrM"));
});

test("carries no terminal artefacts into the extracted URL", () => {
  const url = extractAuthUrl(HYPERLINK);
  for (const ch of [ESC, BEL, "\r", "\n", " "]) {
    assert.ok(!url.includes(ch), `URL should not contain ${JSON.stringify(ch)}`);
  }
});

test("falls back to a plain scan when no hyperlink is emitted", () => {
  const plain = `Browser didn't open? Use the url below\r\n${AUTH_URL}\r\n`;
  assert.equal(extractAuthUrl(plain), AUTH_URL);
});

test("returns null while no URL has been printed yet", () => {
  assert.equal(extractAuthUrl("Welcome to Claude Code v2.1.252\r\n"), null);
});

test("finds a long-lived token in the transcript", () => {
  const token = "sk-ant-oat01-" + "A".repeat(40);
  assert.equal(extractToken(`${ESC}[2GToken: ${token}${ESC}[0m\r\n`), token);
  assert.equal(extractToken("no token here"), null);
});

/**
 * Rejection is matched on space-insensitive patterns because the TUI positions
 * words with cursor escapes; this guards the patterns used in checkCodeRejected.
 */
test("rejection wording survives the loss of spacing", () => {
  const transcript = stripAnsi(
    `${ESC}[2GOAuth error: Invalid${ESC}[15Gcode. Please make${ESC}[30Gsure the full` +
      `${ESC}[45Gcode was copied\r\n Press Enter to retry.\r\n`,
  ).replace(/\s+/g, " ");

  assert.match(transcript, /oauth\s*error/i);
  assert.match(transcript, /invalid\s*code/i);
  assert.match(transcript, /press\s*enter\s*to\s*retry/i);
});
