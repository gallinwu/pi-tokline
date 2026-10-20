/**
 * tokline — a usage line under the pi editor.
 *
 * Shows what a long run actually costs, while it runs:
 *
 *   42.3 t/s | 1.24M tok | cache 87.4%
 *
 * Three sources, no guessing:
 *   - the rate comes from the streamed deltas (marked "~") and is replaced by
 *     the provider's own output count once the message ends
 *   - the token count is the session's billable total from assistant usage
 *   - the cache hit rate is cache reads over the whole input side
 *
 * Hosts differ, so the line is pushed through every channel the host offers:
 *
 *   - `setWidget(key, lines, { placement: "belowEditor" })` — the terminal TUI
 *     renders this in its own slot between the editor and the footer, which is
 *     exactly the line we want
 *   - `setStatus(key, text)` — the footer's extension-status line, and the one
 *     channel every pi front end forwards
 *
 * A host is never assumed: each channel is attempted, its result recorded, and
 * `/tokline status` reports what actually happened. RPC clients receive both as
 * `extension_ui_request` messages and may render either, so nothing here is
 * gated on the host being the terminal.
 *
 * Nothing here touches the transcript, the prompt, or the cache: an extension
 * that changes what the model sees would invalidate the prefix it is measuring.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
  addUsage,
  createTotals,
  formatCount,
  RateTracker,
  type UsageLike,
} from "./src/meter.ts";
import {
  DEFAULT_LINE,
  renderBreakdown,
  renderLine,
  resolveSurfaces,
  type LineConfig,
  type Surface,
  type SurfaceConfig,
} from "./src/render.ts";

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

export interface ToklineConfig {
  enabled: boolean;
  placement: "belowEditor" | "aboveEditor";
  /** Which channels to push the line through. "auto" adapts to the host. */
  surface: SurfaceConfig;
  /** Minimum gap between repaints while streaming, in milliseconds. */
  throttleMs: number;
  /** How often the line is reconsidered while nothing is streaming. */
  heartbeatMs: number;
  /**
   * Re-push an unchanged line after this long. A host that silently drops a
   * widget (session reload, compaction, a client that re-mounts its UI) gets it
   * back without the line having to change first.
   */
  reassertMs: number;
  /** Sliding window used for the live rate, in milliseconds. */
  windowMs: number;
  /** Thinking tokens count toward the live rate. */
  countThinking: boolean;
  line: LineConfig;
}

export const DEFAULT_CONFIG: ToklineConfig = {
  enabled: true,
  placement: "belowEditor",
  surface: "auto",
  throttleMs: 120,
  heartbeatMs: 1000,
  reassertMs: 15000,
  windowMs: 3000,
  countThinking: false,
  line: { ...DEFAULT_LINE },
};

const WIDGET_KEY = "tokline";
const STATUS_KEY = "tokline";

// ---------------------------------------------------------------------------
// paths — honour PI_CODING_AGENT_DIR exactly like pi itself
// ---------------------------------------------------------------------------

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim()
  ? path.resolve(process.env.PI_CODING_AGENT_DIR.trim())
  : path.join(os.homedir(), ".pi", "agent");

const DATA_DIR = path.join(AGENT_DIR, "tokline");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

function loadConfig(): ToklineConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        line: { ...DEFAULT_LINE, ...(raw.line ?? {}) },
      };
    }
  } catch {
    // Missing or unreadable config is normal on first run.
  }
  return { ...DEFAULT_CONFIG, line: { ...DEFAULT_LINE } };
}

function saveConfig(config: ToklineConfig): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  } catch {
    // Persistence is best-effort; the session keeps the in-memory config.
  }
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

/** What one channel did on the last attempt. */
interface ChannelResult {
  attempted: boolean;
  ok: boolean;
  error?: string;
}

interface RenderOutcome {
  at: number;
  mode: string;
  hasUI: boolean;
  surfaces: Surface[];
  widget: ChannelResult;
  status: ChannelResult;
  line: string;
}

export default function tokline(pi: ExtensionAPI) {
  const config = loadConfig();
  const totals = createTotals();
  const tracker = new RateTracker(config.windowMs);

  let lastContext: ExtensionContext | undefined;
  let lastPaintAt = 0;
  let lastAssertAt = 0;
  let lastLine = "";
  let streaming = false;
  let paints = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastOutcome: RenderOutcome | undefined;

  function attempt(channel: Surface, ctx: ExtensionContext, line: string): ChannelResult {
    const result: ChannelResult = { attempted: true, ok: false };
    try {
      if (channel === "widget") {
        ctx.ui.setWidget(WIDGET_KEY, [line], { placement: config.placement });
      } else {
        ctx.ui.setStatus(STATUS_KEY, line);
      }
      result.ok = true;
    } catch (error) {
      // Recorded, never swallowed: a host that cannot render is a fact the
      // user needs to see in /tokline status, not a silent no-op.
      result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  function clear(ctx: ExtensionContext | undefined): void {
    if (!ctx || !ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // Nothing to clear.
    }
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // Nothing to clear.
    }
    lastLine = "";
  }

  /**
   * Render the line into every channel this host supports.
   *
   * Repaints are throttled while streaming and skipped entirely in steady
   * state, except for the periodic re-assert; a status line must not turn into
   * a redraw loop.
   */
  function paint(ctx: ExtensionContext, force = false): void {
    lastContext = ctx;

    if (!config.enabled) {
      clear(ctx);
      return;
    }
    if (!ctx.hasUI) {
      lastOutcome = {
        at: Date.now(),
        mode: ctx.mode,
        hasUI: false,
        surfaces: [],
        widget: { attempted: false, ok: false },
        status: { attempted: false, ok: false },
        line: lastLine,
      };
      return;
    }

    const now = Date.now();
    const line = renderLine({
      totals,
      rate: tracker.value(now),
      contextPercent: ctx.getContextUsage?.()?.percent ?? null,
      config: config.line,
    });

    const changed = line !== lastLine;
    const stale = now - lastAssertAt >= config.reassertMs;
    if (!force && !changed && !stale) return;
    if (!force && changed && now - lastPaintAt < config.throttleMs) return;

    lastPaintAt = now;
    lastAssertAt = now;
    lastLine = line;
    paints++;

    const surfaces = resolveSurfaces(config.surface, ctx.mode);
    const outcome: RenderOutcome = {
      at: now,
      mode: ctx.mode,
      hasUI: true,
      surfaces,
      widget: { attempted: false, ok: false },
      status: { attempted: false, ok: false },
      line,
    };
    for (const surface of surfaces) {
      outcome[surface] = attempt(surface, ctx, line);
    }
    lastOutcome = outcome;
  }

  /** The line keeps itself alive: hosts can drop a widget, a timer cannot. */
  function startHeartbeat(): void {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      if (lastContext && !streaming) paint(lastContext);
    }, Math.max(200, config.heartbeatMs));
    // Never hold the process open on a status line.
    (heartbeat as { unref?: () => void }).unref?.();
  }

  /** Streamed chunk text, or "" when this event carries none. */
  function deltaOf(event: MessageUpdateEvent): string {
    const assistant = (event as {
      assistantMessageEvent?: { type?: string; delta?: string };
    }).assistantMessageEvent;
    if (!assistant || typeof assistant.type !== "string") return "";

    if (assistant.type === "text_delta") return String(assistant.delta ?? "");
    if (assistant.type === "thinking_delta" && config.countThinking) {
      return String(assistant.delta ?? "");
    }
    return "";
  }

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    tracker.reset();
    Object.assign(totals, createTotals());
    streaming = false;
    paint(ctx, true);
    startHeartbeat();
  });

  pi.on("message_start", (event: MessageStartEvent, ctx: ExtensionContext) => {
    const message = (event as { message?: { role?: string } }).message;
    if (!message || message.role !== "assistant") return;
    streaming = true;
    tracker.begin(Date.now());
    paint(ctx, true);
  });

  pi.on("message_update", (event: MessageUpdateEvent, ctx: ExtensionContext) => {
    if (!streaming) return;
    const delta = deltaOf(event);
    if (!delta) return;
    tracker.observe(delta, Date.now());
    paint(ctx);
  });

  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    const message = (event as {
      message?: { role?: string; usage?: unknown };
    }).message;
    if (!message || message.role !== "assistant") return;

    addUsage(totals, message.usage);
    tracker.settle(message.usage as UsageLike | undefined, Date.now());
    streaming = false;
    paint(ctx, true);
  });

  pi.on("session_shutdown", () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    clear(lastContext);
  });

  // The first paint can only happen once a context exists, and in some hosts no
  // event arrives until the user acts. Starting the heartbeat here means the
  // line appears as soon as the first event of any kind reaches us.
  pi.on("turn_start", (_event: unknown, ctx: ExtensionContext) => {
    startHeartbeat();
    paint(ctx);
  });

  // -- /tokline -------------------------------------------------------------
  pi.registerCommand("tokline", {
    description:
      "Usage line: status | on | off | reset | rate | tokens | cache | cost | context | surface auto|widget|status|both | placement above|below | separator <text> | config",
    handler: async (args: string, ctx: ExtensionContext) => {
      const argv = (args || "").trim().split(/\s+/).filter(Boolean);
      const sub = (argv[0] || "status").toLowerCase();
      const notify = (message: string) => ctx.ui.notify(message, "info");

      const toggle = (key: keyof LineConfig, label: string): void => {
        const next = !(config.line[key] as boolean);
        (config.line as unknown as Record<string, unknown>)[key] = next;
        saveConfig(config);
        paint(ctx, true);
        notify("tokline: " + label + " " + (next ? "ON" : "OFF"));
      };

      const describeChannels = (outcome: RenderOutcome | undefined): string => {
        if (!outcome) return "nothing rendered yet — no event has reached the extension";
        const channels = (["widget", "status"] as Surface[]).map((surface) => {
          const result = outcome[surface];
          if (!result.attempted) return surface + " not attempted";
          return surface + (result.ok ? " ok" : " FAILED: " + (result.error ?? "unknown error"));
        });
        return (
          "mode=" + outcome.mode +
          " hasUI=" + outcome.hasUI +
          " surfaces=" + (outcome.surfaces.length > 0 ? outcome.surfaces.join("+") : "none") +
          "\n  " + channels.join("\n  ")
        );
      };

      switch (sub) {
        case "on":
          config.enabled = true;
          saveConfig(config);
          paint(ctx, true);
          startHeartbeat();
          notify("tokline: ON — " + describeChannels(lastOutcome));
          return;
        case "off":
          config.enabled = false;
          saveConfig(config);
          clear(ctx);
          notify("tokline: OFF");
          return;
        case "reset":
          tracker.reset();
          Object.assign(totals, createTotals());
          streaming = false;
          paint(ctx, true);
          notify("tokline: counters reset");
          return;
        case "rate":
          toggle("showRate", "rate");
          return;
        case "tokens":
          toggle("showTokens", "tokens");
          return;
        case "cache":
          toggle("showCache", "cache");
          return;
        case "cost":
          toggle("showCost", "cost");
          return;
        case "context":
          toggle("showContext", "context");
          return;
        case "surface": {
          const chosen = (argv[1] || "").toLowerCase();
          if (!["auto", "widget", "status", "both"].includes(chosen)) {
            notify("tokline: usage — /tokline surface auto|widget|status|both");
            return;
          }
          config.surface = chosen as SurfaceConfig;
          saveConfig(config);
          paint(ctx, true);
          notify("tokline: surface " + chosen + "\n  " + describeChannels(lastOutcome));
          return;
        }
        case "placement": {
          const where = (argv[1] || "").toLowerCase();
          if (where !== "above" && where !== "below") {
            notify("tokline: usage — /tokline placement above|below");
            return;
          }
          config.placement = where === "above" ? "aboveEditor" : "belowEditor";
          saveConfig(config);
          paint(ctx, true);
          notify("tokline: placement " + config.placement);
          return;
        }
        case "separator": {
          const separator = argv.slice(1).join(" ");
          if (!separator) {
            notify('tokline: usage — /tokline separator " | "');
            return;
          }
          config.line.separator = separator;
          saveConfig(config);
          paint(ctx, true);
          notify("tokline: separator set");
          return;
        }
        case "config":
          notify("config file: " + CONFIG_FILE + "\n\n" + JSON.stringify(config, null, 2));
          return;
        case "status":
        default: {
          const now = Date.now();
          const reading = tracker.value(now);
          const lines: string[] = [];
          lines.push(lastLine || "(no line rendered yet)");
          lines.push("");
          lines.push(...renderBreakdown(totals));
          lines.push("");
          lines.push(
            "rate     " +
              (reading.rate === null
                ? "n/a"
                : reading.rate.toFixed(1) + " t/s" + (reading.estimated ? " (estimated from the stream)" : " (from provider usage)")),
          );
          lines.push("stream   " + (streaming ? "active" : "idle"));
          lines.push("renders  " + paints + " paint(s), heartbeat " + config.heartbeatMs + "ms, re-assert " + config.reassertMs + "ms");
          lines.push("render   " + describeChannels(lastOutcome));
          if (lastOutcome && lastOutcome.mode !== "tui") {
            lines.push(
              "note     this host is not the terminal TUI (" + lastOutcome.mode + "). Widget lines are forwarded over the",
            );
            lines.push("         extension UI protocol and the client decides whether to draw them; /tokline surface both asks");
            lines.push("         for the widget slot and the footer status line at once.");
          }
          notify(lines.join("\n"));
          return;
        }
      }
    },
  });
}