import assert from "node:assert/strict";
import { test } from "node:test";
import { escape, paginate, plainLength, shortHex, units, utc } from "../src/format.mjs";

test("amounts are exact decimals: grouped, trailing zeros trimmed, no rounding", () => {
  const E18 = 10n ** 18n;
  assert.equal(units(1234n * E18 + E18 / 2n, 18), "1,234.5");
  assert.equal(units(1n, 18), "0.000000000000000001");
  assert.equal(units(2_100_000_001n, 8), "21.00000001");
  assert.equal(units(2n ** 128n + 5n, 18), "340,282,366,920,938,463,463.374607431768211461");
  assert.equal(units(0n, 6), "0");
  assert.equal(units(1_000_000n, 6), "1");
  assert.equal(units(1234567n, 0), "1,234,567");
});

test("outside text is escaped for text and attributes", () => {
  assert.equal(escape(`<b>"x" & y</b>`), "&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;");
});

test("short addresses and UTC times", () => {
  assert.equal(shortHex("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"), "0x0471…938d");
  assert.equal(utc(1792454420), "2026-10-20 00:00:20 UTC");
});

test("a reply fits one message when it can", () => {
  assert.deepEqual(paginate(["<b>a</b>", "", "b &amp; c"]), ["<b>a</b>\n\nb &amp; c"]);
  assert.equal(plainLength("<b>a</b> &lt;b&gt;"), 5);
});

test("a long reply splits at line breaks, each message at most the limit and with balanced quotes", () => {
  const reason = Array.from({ length: 300 }, (_, i) => `line ${i} <x> & more text to fill it up`).join("\n");
  const pages = paginate(["<b>Revert reason</b>", { quote: reason }, "after"], 4096);
  assert.ok(pages.length > 1);
  for (const p of pages) {
    assert.ok(plainLength(p) <= 4096, `a page of ${plainLength(p)}`);
    assert.equal(p.split("<blockquote expandable>").length, p.split("</blockquote>").length);
  }
  const text = pages.join("\n").replace(/<[^>]*>/g, "");
  assert.ok(text.includes("line 299 &lt;x&gt; &amp; more"));
  assert.ok(pages.at(-1).endsWith("after"));
});

test("a line longer than a message is cut, never inside a surrogate pair", () => {
  const pages = paginate([{ quote: "🙂".repeat(5000) }], 4096);
  assert.ok(pages.length >= 3);
  for (const p of pages) assert.doesNotMatch(p.replace(/<[^>]*>/g, ""), /^[\udc00-\udfff]|[\ud800-\udbff]$/);
});
