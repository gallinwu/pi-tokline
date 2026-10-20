/**
 * tokline — metering.
 *
 * Three numbers the provider already told us, kept separately because they
 * answer three different questions:
 *
 *   - rate  : how fast output is arriving right now
 *   - tokens: how much this session has moved through the provider
 *   - cache : how much of the input the provider served from its prompt cache
 *
 * The rate has two definitions on purpose. While a message streams, the only
 * evidence available is the delta stream, so the rate is an estimate over a
 * sliding window. When the message ends, the provider reports exact output
 * tokens, so the rate becomes output / wall time. The line marks the estimate
 * with a "~" so a number that can move is never mistaken for a settled one.
 */

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
  /** Provider-reported totals, summed. Absent for providers that omit them. */
  reported: number;
  requests: number;
}

export function createTotals(): Totals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    reported: 0,
    requests: 0,
  };
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasUsageFields(usage: UsageLike): boolean {
  return (
    usage.input !== undefined ||
    usage.output !== undefined ||
    usage.cacheRead !== undefined ||
    usage.cacheWrite !== undefined ||
    usage.totalTokens !== undefined ||
    usage.cost !== undefined
  );
}

/**
 * Fold one assistant message's usage into the totals.
 *
 * Returns false for anything that is not a usage record, so a provider that
 * omits usage does not silently inflate the request count.
 */
export function addUsage(totals: Totals, usage: unknown): boolean {
  if (!usage || typeof usage !== "object") return false;
  const record = usage as UsageLike;
  if (!hasUsageFields(record)) return false;

  totals.input += num(record.input);
  totals.output += num(record.output);
  totals.cacheRead += num(record.cacheRead);
  totals.cacheWrite += num(record.cacheWrite);
  totals.reasoning += num(record.reasoning);
  totals.cost += num(record.cost?.total);
  totals.reported += num(record.totalTokens);
  totals.requests += 1;
  return true;
}

/**
 * Everything the provider processed this session.
 *
 * Cache reads are included: they are real tokens the model consumed, just
 * billed at the cached rate. Hiding them makes a session look smaller than the
 * context it actually carried.
 */
export function billableTokens(totals: Totals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

/**
 * Cache hit rate: cache reads as a share of all input-side tokens.
 *
 * `input` here means uncached input, so `input + cacheRead` is the whole input
 * side and a session with no cache traffic reports null rather than 0%.
 * Same definition as pi-tokenforge's meter, so the two tools never disagree.
 */
export function cacheHitRate(totals: Totals): number | null {
  const denominator = totals.input + totals.cacheRead;
  if (denominator <= 0) return null;
  return Math.round((totals.cacheRead / denominator) * 1000) / 10;
}

/**
 * Rough token count for a streamed chunk.
 *
 * CJK runs are charged at the rate providers actually use (~0.75 tokens per
 * char, i.e. ~1.33 chars per token); everything else at ~4 chars per token.
 * Astral characters count once. Good enough to watch a rate move; never used
 * to bill anyone, and never shown without the "~" when it is the live number.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      cjk++;
      i++;
    } else if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.round(cjk * 0.75 + other / 4);
}

/** Compact counter: 942 / 12.3K / 1.24M. */
export function formatCount(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) return trimZero((value / 1000).toFixed(1)) + "K";
  return trimZero((value / 1_000_000).toFixed(2)) + "M";
}

function trimZero(text: string): string {
  return text.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Money with enough digits to stay truthful on cheap models. */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.01) return "$" + value.toFixed(4);
  return "$" + value.toFixed(2);
}

export interface RateSample {
  at: number;
  tokens: number;
}

export interface RateReading {
  rate: number | null;
  /** True when the number comes from streamed deltas, not from provider usage. */
  estimated: boolean;
}

/**
 * Output rate tracker.
 *
 * Live rate is a sliding window over streamed deltas, because a cumulative
 * average would keep reporting the slow start of a long message forever. The
 * settled rate replaces it with the provider's own output count once the
 * message ends.
 */
export class RateTracker {
  private window: RateSample[] = [];
  private startedAt: number | null = null;
  private settled: number | null = null;
  private streamTokens = 0;
  private finishedAt: number | null = null;
  private readonly windowMs: number;
  private readonly minMs: number;
  /**
   * Floor for a settled reading. Much lower than the live floor: the window
   * needs several samples before an average means anything, while a finished
   * message has an exact output count and a measured duration. Only a message
   * shorter than a few frames of wall clock is too coarse to report.
   */
  private readonly minSettleMs: number;

  // Declared and assigned one by one: Node's strip-only TypeScript mode rejects
  // constructor parameter properties, and a host may load this file that way.
  constructor(windowMs = 3000, minMs = 250, minSettleMs = 50) {
    this.windowMs = windowMs;
    this.minMs = minMs;
    this.minSettleMs = minSettleMs;
  }

  /** A new assistant message started streaming. */
  begin(at: number): void {
    this.window = [];
    this.startedAt = at;
    this.streamTokens = 0;
  }

  get streaming(): boolean {
    return this.startedAt !== null;
  }

  get lastFinishedAt(): number | null {
    return this.finishedAt;
  }

  get estimatedStreamTokens(): number {
    return this.streamTokens;
  }

  /** Feed one streamed chunk. Ignored unless a message is streaming. */
  observe(text: string, at: number): void {
    if (this.startedAt === null) return;
    const tokens = estimateTokens(text);
    if (tokens <= 0) return;
    this.streamTokens += tokens;
    this.window.push({ at, tokens });
    const cutoff = at - this.windowMs;
    while (this.window.length > 0 && this.window[0]!.at < cutoff) this.window.shift();
  }

  /** Estimated tokens/sec over the window, or null while there is too little signal. */
  live(now: number): number | null {
    if (this.startedAt === null || this.window.length === 0) return null;
    const first = this.window[0]!.at;
    const span = now - Math.max(first, this.startedAt);
    if (span < this.minMs) return null;
    let tokens = 0;
    for (const sample of this.window) tokens += sample.tokens;
    return tokens / (span / 1000);
  }

  /** Close the message: prefer the provider's exact output count for the rate. */
  settle(usage: UsageLike | undefined, at: number): number | null {
    const startedAt = this.startedAt;
    this.startedAt = null;
    this.finishedAt = at;
    this.window = [];

    const output = num(usage?.output);
    if (startedAt === null || output <= 0) return this.settled;
    const elapsed = at - startedAt;
    if (elapsed < this.minSettleMs) return this.settled;

    this.settled = output / (elapsed / 1000);
    return this.settled;
  }

  /**
   * What to display right now.
   *
   * While streaming: the live window, or the last settled number marked
   * estimated when the window is still too short to be meaningful.
   */
  value(now: number): RateReading {
    if (this.startedAt !== null) {
      const live = this.live(now);
      if (live !== null) return { rate: live, estimated: true };
      return { rate: this.settled, estimated: true };
    }
    return { rate: this.settled, estimated: false };
  }

  reset(): void {
    this.window = [];
    this.startedAt = null;
    this.settled = null;
    this.streamTokens = 0;
    this.finishedAt = null;
  }
}