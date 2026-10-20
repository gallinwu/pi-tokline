/**
 * tokline — the rendered line.
 *
 * One line, under the editor, in the order the eye wants it: how fast, how
 * much, how cached. Every segment can be turned off; nothing is padded or
 * colored here so the string stays testable and the terminal stays the one
 * deciding widths.
 */

import {
  billableTokens,
  cacheHitRate,
  formatCount,
  formatMoney,
  type RateReading,
  type Totals,
} from "./meter.ts";

export interface LineConfig {
  showRate: boolean;
  showTokens: boolean;
  showCache: boolean;
  showCost: boolean;
  showContext: boolean;
  /** Joins segments. */
  separator: string;
  /** Leading marker. Keep it short; it is redrawn on every paint. */
  prefix: string;
}

export const DEFAULT_LINE: LineConfig = {
  showRate: true,
  showTokens: true,
  showCache: true,
  showCost: false,
  showContext: false,
  separator: " | ",
  prefix: "",
};

export interface LineInput {
  totals: Totals;
  rate: RateReading;
  contextPercent: number | null;
  config: LineConfig;
}

/** A channel the line can be pushed through. */
export type Surface = "widget" | "status";

export type SurfaceConfig = "auto" | "widget" | "status" | "both";

/**
 * Which channels to use on this host.
 *
 * The terminal TUI has a dedicated slot between the editor and the footer, so
 * the widget alone is right there and a second copy in the footer would be
 * noise. Every other host (an RPC client, a desktop app) only receives
 * `extension_ui_request` messages and decides for itself what to draw, so "auto"
 * asks for both channels and lets the client render whichever it has.
 */
export function resolveSurfaces(config: SurfaceConfig, mode: string): Surface[] {
  if (config === "widget") return ["widget"];
  if (config === "status") return ["status"];
  if (config === "both") return ["widget", "status"];
  return mode === "tui" ? ["widget"] : ["widget", "status"];
}

function rateSegment(rate: RateReading): string {
  if (rate.rate === null) return "-- t/s";
  const value = rate.rate.toFixed(1);
  return (rate.estimated ? "~" : "") + value + " t/s";
}

function cacheSegment(totals: Totals): string {
  const hit = cacheHitRate(totals);
  return "cache " + (hit === null ? "--" : hit + "%");
}

export function renderLine(input: LineInput): string {
  const { totals, rate, contextPercent, config } = input;
  const segments: string[] = [];

  if (config.showRate) segments.push(rateSegment(rate));
  if (config.showTokens) segments.push(formatCount(billableTokens(totals)) + " tok");
  if (config.showCache) segments.push(cacheSegment(totals));
  if (config.showCost) segments.push(formatMoney(totals.cost));
  if (config.showContext && contextPercent !== null) {
    segments.push("ctx " + contextPercent.toFixed(0) + "%");
  }

  return config.prefix + segments.join(config.separator);
}

/** The breakdown behind the one-line summary, for `/tokline status`. */
export function renderBreakdown(totals: Totals): string[] {
  const hit = cacheHitRate(totals);
  return [
    "input        " + formatCount(totals.input) + " tokens",
    "output       " + formatCount(totals.output) + " tokens" +
      (totals.reasoning > 0 ? " (reasoning " + formatCount(totals.reasoning) + ")" : ""),
    "cache read   " + formatCount(totals.cacheRead) + " tokens",
    "cache write  " + formatCount(totals.cacheWrite) + " tokens",
    "billable     " + formatCount(billableTokens(totals)) + " tokens",
    "cache hit    " + (hit === null ? "n/a" : hit + "%") + " of input side",
    "cost         " + formatMoney(totals.cost),
    "requests     " + totals.requests +
      (totals.reported > 0 ? " (provider-reported total " + formatCount(totals.reported) + ")" : ""),
  ];
}