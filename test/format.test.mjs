import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_MESSAGE, escapeHtml, formatTime, formatUnits, htmlToText, pack, preBlocks } from "../src/format.mjs";

test("amounts are exact, trimmed and grouped", () => {
  const E18 = 10n ** 18n;
  assert.equal(formatUnits(1234n * E18 + E18 / 2n, 18), "1,234.5");
  assert.equal(formatUnits(1n, 18), "0.000000000000000001");
  assert.equal(formatUnits(2n ** 128n + 5n, 18), "340,282,366,920,938,463,463.374607431768211461");
  assert.equal(formatUnits(2_100_000_001n, 8), "21.00000001");
  assert.equal(formatUnits(0n, 6), "0");
  assert.equal(formatUnits(42n, 0), "42");
});

test("times are UTC, to the second", () => {
  assert.equal(formatTime(Date.parse("2026-10-20T00:00:20Z") / 1000), "2026-10-20 00:00:20 UTC");
});

test("outside text is escaped, and the plain-text fallback undoes it", () => {
  const s = `<b>&lt;x&gt;</b> & "q"`;
  assert.equal(escapeHtml(s), "&lt;b&gt;&amp;lt;x&amp;gt;&lt;/b&gt; &amp; \"q\"");
  assert.equal(htmlToText(`<pre>${escapeHtml(s)}</pre>`), s);
});

test("long replies split at line breaks into messages of at most 4096 characters", () => {
  const reason = Array.from({ length: 140 }, (_, i) => `#${i} assert(a < b) & <felt ${i}> ${"x".repeat(80)}`).join("\n");
  const messages = pack(["❌ <b>Reverted</b>", "", ...preBlocks(reason)]);
  assert.ok(messages.length > 1);
  for (const m of messages) {
    assert.ok(m.length <= MAX_MESSAGE, `${m.length} characters`);
    assert.equal((m.match(/<pre>/g) ?? []).length, (m.match(/<\/pre>/g) ?? []).length, "balanced <pre>");
  }
  const text = messages.map(htmlToText).join("\n");
  for (let i = 0; i < 140; i++) assert.ok(text.includes(`#${i} assert(a < b) & <felt ${i}>`), `line ${i} kept`);
});

test("a single line longer than a message is split between characters", () => {
  const blocks = preBlocks("é<".repeat(5000), 3000);
  assert.ok(blocks.length > 1);
  for (const b of blocks) assert.ok(b.length <= 3000 + "<pre></pre>".length);
  assert.equal(blocks.map(htmlToText).join(""), "é<".repeat(5000));
});
