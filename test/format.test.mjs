import assert from "node:assert/strict";
import { test } from "node:test";
import { esc, formatUnits, formatUtc, plainLength, splitMessage } from "../src/format.mjs";

test("amounts are exact, trimmed and grouped", () => {
  assert.equal(formatUnits(1234n * 10n ** 18n + 10n ** 18n / 2n, 18), "1,234.5");
  assert.equal(formatUnits(1n, 18), "0.000000000000000001");
  assert.equal(formatUnits(0n, 6), "0");
  assert.equal(formatUnits(2n ** 128n + 5n, 18), "340,282,366,920,938,463,463.374607431768211461");
  assert.equal(formatUnits(5n, 0), "5");
});

test("times are UTC", () => {
  assert.equal(formatUtc(Date.parse("2026-10-20T00:00:20Z") / 1000), "2026-10-20 00:00:20 UTC");
});

test("outside strings are escaped", () => {
  assert.equal(esc(`<b>"x" & y</b>`), "&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;");
});

test("long replies split at line breaks, each part valid and short", () => {
  const html = `<pre>${Array.from({ length: 400 }, (_, i) => `line ${i} &lt;x&gt;`).join("\n")}</pre>`;
  const parts = splitMessage(html);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(plainLength(p) <= 4096);
    assert.ok(p.startsWith("<pre>") && p.endsWith("</pre>"), p.slice(0, 40));
  }
});

test("one enormous line falls back to escaped plain text", () => {
  const parts = splitMessage(`<b>${"x".repeat(9000)}</b>`);
  assert.ok(parts.every((p) => plainLength(p) <= 4096));
});
