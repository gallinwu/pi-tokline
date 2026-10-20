/**
 * Pure-logic tests: metering, rate tracking, formatting and the rendered line.
 *
 * Run: node --test test/*.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  addUsage,
  billableTokens,
  cacheHitRate,
  createTotals,
  estimateTokens,
  formatCount,
  formatMoney,
  RateTracker,
  type Totals,
} from "../src/meter.ts";
import { DEFAULT_LINE, renderBreakdown, renderLine, resolveSurfaces } from "../src/render.ts";

function totalsWith(usage: Parameters<typeof addUsage>[1]): Totals {
  const totals = createTotals();
  addUsage(totals, usage);
  return totals;
}

// ---------------------------------------------------------------------------
// totals
// ---------------------------------------------------------------------------

test("cacheHitRate is null before any usage", () => {
  assert.equal(cacheHitRate(createTotals()), null);
});

test("cacheHitRate is cache reads over the input side", () => {
  const totals = totalsWith({ input: 100, cacheRead: 900 });
  assert.equal(cacheHitRate(totals), 90);
});

test("cacheHitRate ignores output entirely", () => {
  const withOutput = totalsWith({ input: 10, cacheRead: 90, output: 1_000_000 });
  assert.equal(cacheHitRate(withOutput), 90);
});

test("addUsage accumulates every bucket", () => {
  const totals = createTotals();
  addUsage(totals, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5, totalTokens: 100, cost: { total: 0.5 } });
  addUsage(totals, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.25 } });

  assert.deepEqual(
    {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      reasoning: totals.reasoning,
      cost: totals.cost,
      reported: totals.reported,
      requests: totals.requests,
    },
    {
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      reasoning: 5,
      cost: 0.75,
      reported: 100,
      requests: 2,
    },
  );
});

test("addUsage rejects records that carry no usage", () => {
  const totals = createTotals();
  assert.equal(addUsage(totals, undefined), false);
  assert.equal(addUsage(totals, null), false);
  assert.equal(addUsage(totals, "usage"), false);
  assert.equal(addUsage(totals, {}), false);
  assert.equal(addUsage(totals, { unrelated: 1 }), false);
  assert.equal(totals.requests, 0);
});

test("addUsage treats missing and non-numeric fields as zero", () => {
  const totals = totalsWith({ input: 5, cacheRead: undefined, cost: { total: "nope" } });
  assert.equal(totals.input, 5);
  assert.equal(totals.cacheRead, 0);
  assert.equal(totals.cost, 0);
  assert.equal(totals.requests, 1);
});

test("billableTokens counts the whole input side, cache included", () => {
  const totals = totalsWith({ input: 100, output: 200, cacheRead: 600, cacheWrite: 100 });
  assert.equal(billableTokens(totals), 1000);
});

// ---------------------------------------------------------------------------
// estimation and formatting
// ---------------------------------------------------------------------------

test("estimateTokens charges CJK at its own rate", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("x".repeat(400)), 100);
  // 10 CJK chars at ~0.75 tokens each.
  assert.equal(estimateTokens("\u4e2d".repeat(10)), 8);
});

test("formatCount stays readable at every scale", () => {
  assert.equal(formatCount(942), "942");
  assert.equal(formatCount(1000), "1K");
  assert.equal(formatCount(12_345), "12.3K");
  assert.equal(formatCount(1_240_000), "1.24M");
  assert.equal(formatCount(999_000_000), "999M");
});

test("formatMoney keeps small amounts from rounding to nothing", () => {
  assert.equal(formatMoney(0), "$0");
  assert.equal(formatMoney(0.0034), "$0.0034");
  assert.equal(formatMoney(3.4237), "$3.42");
});

// ---------------------------------------------------------------------------
// rate
// ---------------------------------------------------------------------------

test("live rate is measured over the sliding window, not since the start", () => {
  const tracker = new RateTracker(3000, 250);
  tracker.begin(1000);

  // 400 latin chars = 100 tokens per chunk, three chunks over 1.5s.
  tracker.observe("x".repeat(400), 2000);
  tracker.observe("x".repeat(400), 2750);
  tracker.observe("x".repeat(400), 3500);

  // The 3s window keeps all three: 300 tokens over the 1.5s they span.
  assert.equal(tracker.live(3500), 200);
});

test("live rate returns null while there is too little signal", () => {
  const tracker = new RateTracker(3000, 250);
  tracker.begin(1000);
  assert.equal(tracker.live(1100), null);

  tracker.observe("x".repeat(400), 1100);
  // One sample spans 0ms, which is below the floor.
  assert.equal(tracker.live(1100), null);
});

test("samples older than the window are dropped", () => {
  const tracker = new RateTracker(1000, 250);
  tracker.begin(1000);
  tracker.observe("x".repeat(400), 1000);
  tracker.observe("x".repeat(400), 3000);

  // Only the 3s sample survives, and it spans no measurable time.
  assert.equal(tracker.live(3000), null);
});

test("settle prefers the provider's output count over the estimate", () => {
  const tracker = new RateTracker(3000, 250);
  tracker.begin(1000);
  tracker.observe("x".repeat(4000), 2000);
  tracker.observe("x".repeat(4000), 2500);

  const settled = tracker.settle({ output: 1000 }, 3000);
  assert.equal(settled, 500); // 1000 tokens over 2s
  assert.deepEqual(tracker.value(9000), { rate: 500, estimated: false });
});

test("settle keeps the previous number when the provider reports nothing", () => {
  const tracker = new RateTracker(3000, 250);
  tracker.begin(1000);
  assert.equal(tracker.settle({ output: 400 }, 2000), 400);
  assert.equal(tracker.settle({}, 5000), 400);
  assert.equal(tracker.settle(undefined, 6000), 400);
});

test("settle ignores a message too short for the clock to measure", () => {
  const tracker = new RateTracker(3000, 250);
  tracker.begin(1000);
  assert.equal(tracker.settle({ output: 900 }, 1010), null);
  // And it does not overwrite a rate that was measurable.
  tracker.begin(2000);
  assert.equal(tracker.settle({ output: 500 }, 2500), 1000); // 500 tokens over 0.5s
  tracker.begin(3000);
  assert.equal(tracker.settle({ output: 900 }, 3010), 1000);
});

test("a live reading is marked estimated, a settled one is not", () => {
  const tracker = new RateTracker(3000, 250);
  tracker.begin(1000);

  tracker.observe("x".repeat(400), 2000);
  tracker.observe("x".repeat(400), 2500);
  // 200 tokens over the 500ms the window spans.
  assert.deepEqual(tracker.value(2500), { rate: 400, estimated: true });

  // 1250 tokens over the 2.5s the message took.
  tracker.settle({ output: 1250 }, 3500);
  assert.deepEqual(tracker.value(3500), { rate: 500, estimated: false });
});

test("reset clears both the stream state and the settled rate", () => {
  const tracker = new RateTracker(3000, 250);
  tracker.begin(1000);
  tracker.observe("x".repeat(400), 2000);
  tracker.settle({ output: 400 }, 3000);
  tracker.reset();

  assert.equal(tracker.streaming, false);
  assert.deepEqual(tracker.value(9000), { rate: null, estimated: false });
  assert.equal(tracker.estimatedStreamTokens, 0);
});

// ---------------------------------------------------------------------------
// rendered line
// ---------------------------------------------------------------------------

const sampleTotals = totalsWith({ input: 100, output: 5000, cacheRead: 900, cacheWrite: 0, cost: { total: 3.4237 } });

test("the default line is rate, tokens, cache in that order", () => {
  const line = renderLine({
    totals: sampleTotals,
    rate: { rate: 50, estimated: false },
    contextPercent: 12,
    config: DEFAULT_LINE,
  });
  assert.equal(line, "50.0 t/s | 6K tok | cache 90%");
});

test("an estimated rate is marked with a tilde", () => {
  const line = renderLine({
    totals: sampleTotals,
    rate: { rate: 50, estimated: true },
    contextPercent: null,
    config: DEFAULT_LINE,
  });
  assert.equal(line, "~50.0 t/s | 6K tok | cache 90%");
});

test("an unknown rate renders as a placeholder rather than a fake zero", () => {
  const line = renderLine({
    totals: createTotals(),
    rate: { rate: null, estimated: false },
    contextPercent: null,
    config: DEFAULT_LINE,
  });
  assert.equal(line, "-- t/s | 0 tok | cache --");
});

test("every segment can be turned off, and cost and context can be added", () => {
  const line = renderLine({
    totals: sampleTotals,
    rate: { rate: 50, estimated: false },
    contextPercent: 12.4,
    config: { ...DEFAULT_LINE, showRate: false, showCost: true, showContext: true },
  });
  assert.equal(line, "6K tok | cache 90% | $3.42 | ctx 12%");
});

test("the separator and prefix are configurable", () => {
  const line = renderLine({
    totals: sampleTotals,
    rate: { rate: 50, estimated: false },
    contextPercent: null,
    config: { ...DEFAULT_LINE, separator: "\u00b7", prefix: "\u26a1 " },
  });
  assert.equal(line, "\u26a1 50.0 t/s\u00b76K tok\u00b7cache 90%");
});

test("an empty selection renders an empty line, not a stray separator", () => {
  const line = renderLine({
    totals: sampleTotals,
    rate: { rate: 50, estimated: false },
    contextPercent: null,
    config: { ...DEFAULT_LINE, showRate: false, showTokens: false, showCache: false },
  });
  assert.equal(line, "");
});

test("the breakdown explains the summary", () => {
  const lines = renderBreakdown(sampleTotals);
  assert.equal(lines.length, 8);
  assert.ok(lines.some((line) => line.includes("cache hit    90% of input side")));
  assert.ok(lines.some((line) => line.includes("billable     6K tokens")));
  assert.ok(lines.some((line) => line.includes("requests     1")));
});

// ---------------------------------------------------------------------------
// surfaces
// ---------------------------------------------------------------------------

test("auto uses the editor slot only where that slot exists", () => {
  assert.deepEqual(resolveSurfaces("auto", "tui"), ["widget"]);
  assert.deepEqual(resolveSurfaces("auto", "rpc"), ["widget", "status"]);
  assert.deepEqual(resolveSurfaces("auto", "json"), ["widget", "status"]);
  assert.deepEqual(resolveSurfaces("auto", "print"), ["widget", "status"]);
});

test("an explicit surface selection overrides the host", () => {
  assert.deepEqual(resolveSurfaces("widget", "rpc"), ["widget"]);
  assert.deepEqual(resolveSurfaces("status", "tui"), ["status"]);
  assert.deepEqual(resolveSurfaces("both", "tui"), ["widget", "status"]);
});