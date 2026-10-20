/**
 * Host harness: loads index.ts the way a Node 24 host does (native type
 * stripping), wires it to fake ExtensionAPIs, and drives whole messages through
 * several different hosts.
 *
 * Multiple hosts is the point. The first bug this extension shipped was a
 * `mode !== "tui"` guard that made it render nothing on every non-terminal host
 * while its /tokline command still worked, so the failure was invisible. That
 * case — and the silently swallowed setWidget error behind it — are now
 * regression tests.
 *
 * Run: node harness/load.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keep the run out of the real ~/.pi/agent: index.ts reads this at module load.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tokline-harness-"));
process.env.PI_CODING_AGENT_DIR = sandbox;

const { default: tokline } = await import("../index.ts");

const CONFIG_FILE = path.join(sandbox, "tokline", "config.json");

/** Config is read when the extension is constructed, so hosts get a clean slate. */
function resetConfig(overrides) {
  try {
    fs.rmSync(CONFIG_FILE, { force: true });
  } catch {
    // no config yet
  }
  if (overrides) {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(overrides, null, 2), "utf-8");
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
function check(name, condition, detail = "") {
  if (!condition) failures.push(name);
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}

// ---------------------------------------------------------------------------
// fake hosts
// ---------------------------------------------------------------------------

function makeHost(mode, options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const widgetCalls = [];
  const statusCalls = [];
  const notifications = [];

  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    registerCommand(name, opts) {
      commands.set(name, opts);
    },
    registerTool() {},
    registerFlag() {},
    registerShortcut() {},
    registerProvider() {},
    registerVirtualModel() {},
    sendMessage() {},
    appendEntry() {},
    events: { emit() {}, on: () => () => {} },
  };

  const ctx = {
    mode,
    hasUI: options.hasUI ?? true,
    cwd: process.cwd(),
    ui: {
      notify(message, tone) {
        notifications.push({ tone: tone || "info", message });
      },
      setWidget(key, content, opts) {
        if (options.failWidget) throw new Error("this client cannot draw widgets");
        widgetCalls.push({ key, content, options: opts });
      },
      setStatus(key, text) {
        if (options.failStatus) throw new Error("this client has no footer");
        statusCalls.push({ key, text });
      },
    },
    sessionManager: { getSessionId: () => "harness-" + mode },
    isIdle: () => true,
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 12000, contextWindow: 200000, percent: 6 }),
  };

  return {
    mode,
    pi,
    ctx,
    handlers,
    commands,
    widgetCalls,
    statusCalls,
    notifications,
    async emit(event, payload = { type: event }) {
      for (const handler of handlers.get(event) || []) await handler(payload, ctx);
    },
    line: () => {
      const call = widgetCalls[widgetCalls.length - 1];
      return call?.content ? call.content[0] : "(cleared)";
    },
    widgetLines: () => widgetCalls[widgetCalls.length - 1]?.content,
    lastStatus: () => statusCalls[statusCalls.length - 1]?.text,
    lastNotification: () => notifications[notifications.length - 1]?.message ?? "",
    run: (args) => commands.get("tokline").handler(args, ctx),
  };
}

/** One assistant message: start, spaced deltas, then usage. */
async function driveMessage(host, usage) {
  await host.emit("message_start", { type: "message_start", message: { role: "assistant" } });
  for (let i = 0; i < 8; i++) {
    await host.emit("message_update", {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(80), partial: {} },
    });
    await sleep(60);
  }
  await host.emit("message_end", { type: "message_end", message: { role: "assistant", usage } });
}

const USAGE = {
  input: 100,
  output: 6000,
  cacheRead: 900,
  cacheWrite: 0,
  totalTokens: 7000,
  cost: { total: 3.4237 },
};

// ---------------------------------------------------------------------------
// host 1: the terminal TUI
// ---------------------------------------------------------------------------

console.log("=== terminal TUI host (mode=tui) ===");
resetConfig();
const tui = makeHost("tui");
tokline(tui.pi);

check("registers the /tokline command", tui.commands.has("tokline"));
check(
  "subscribes to the message lifecycle",
  tui.handlers.has("message_start") && tui.handlers.has("message_update") && tui.handlers.has("message_end"),
);

await tui.emit("session_start");
console.log("boot line: " + tui.line());
check("paints an honest empty line at boot", tui.line() === "-- t/s | 0 tok | cache --", tui.line());
check("widget goes below the editor", tui.widgetCalls.at(-1)?.options?.placement === "belowEditor");
check("the TUI does not also get a footer copy", tui.statusCalls.length === 0);

await driveMessage(tui, USAGE);
console.log("settled line: " + tui.line());
check("settled rate is exact, not estimated", /^\d+\.\d t\/s/.test(tui.line()), tui.line());
check("session tokens are the billable total", tui.line().includes("7K tok"), tui.line());
check("cache hit is cache reads over the input side", tui.line().includes("cache 90%"), tui.line());

// Steady state must not become a redraw loop.
const quietPaints = tui.widgetCalls.length;
await sleep(1300);
check("no repaint while the line is unchanged", tui.widgetCalls.length === quietPaints, `${tui.widgetCalls.length} vs ${quietPaints}`);

await tui.emit("session_shutdown");
check("shutdown clears the widget", tui.widgetLines() === undefined);
check("shutdown clears the footer status too", tui.statusCalls.at(-1)?.text === undefined);

// ---------------------------------------------------------------------------
// host 2: an RPC front end (pi web, desktop clients)
// ---------------------------------------------------------------------------

console.log("\n=== RPC host (mode=rpc) ===");
resetConfig();
const rpc = makeHost("rpc");
tokline(rpc.pi);

await rpc.emit("session_start");
console.log("widget line: " + rpc.line());
console.log("status line: " + rpc.lastStatus());
check("an RPC host gets the widget channel", rpc.widgetCalls.length > 0);
check("an RPC host ALSO gets the footer status channel", rpc.statusCalls.length > 0);
check("both channels carry the same text", rpc.line() === rpc.lastStatus(), rpc.line());
check("widget is still placed below the editor", rpc.widgetCalls.at(-1)?.options?.placement === "belowEditor");

await driveMessage(rpc, USAGE);
check("the RPC line updates with usage", rpc.lastStatus().includes("7K tok") && rpc.lastStatus().includes("cache 90%"), rpc.lastStatus());

await rpc.run("status");
const status = rpc.lastNotification();
console.log("--- /tokline status ---\n" + status);
check("status reports the host mode", status.includes("mode=rpc"));
check("status reports both channels as ok", status.includes("widget ok") && status.includes("status ok"));
check("status reports the render count", /renders\s+\d+ paint/.test(status));

await rpc.run("surface widget");
check("the surface command reports what it asked for", rpc.lastNotification().includes("surfaces=widget"), rpc.lastNotification().split("\n")[0]);
const rpcStatusPushes = rpc.statusCalls.length;
const rpcWidgetPushes = rpc.widgetCalls.length;
await driveMessage(rpc, { input: 0, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000 });
check("surface=widget stops pushing to the footer", rpc.statusCalls.length === rpcStatusPushes, `${rpc.statusCalls.length} vs ${rpcStatusPushes}`);
check("surface=widget keeps updating the widget", rpc.widgetCalls.length > rpcWidgetPushes);
check("the second message accumulates", rpc.line().includes("9K tok"), rpc.line());

// ---------------------------------------------------------------------------
// host 3: a client that rejects widgets
// ---------------------------------------------------------------------------

console.log("\n=== RPC host that cannot draw widgets (setWidget throws) ===");
resetConfig();
const hostile = makeHost("rpc", { failWidget: true });
tokline(hostile.pi);
await hostile.emit("session_start");
check("no widget was recorded", hostile.widgetCalls.length === 0);
check("the surviving channel gets the line", hostile.lastStatus() === "-- t/s | 0 tok | cache --", hostile.lastStatus());

await hostile.run("status");
const hostileStatus = hostile.lastNotification();
console.log("--- /tokline status ---\n" + hostileStatus);
check("the failure is reported, not swallowed", hostileStatus.includes("widget FAILED: this client cannot draw widgets"), hostileStatus);
check("the working channel is still reported ok", hostileStatus.includes("status ok"));

// ---------------------------------------------------------------------------
// host 4: no UI at all
// ---------------------------------------------------------------------------

console.log("\n=== headless host (hasUI=false) ===");
resetConfig();
const headless = makeHost("json", { hasUI: false });
tokline(headless.pi);
await headless.emit("session_start");
check("nothing is attempted without a UI", headless.widgetCalls.length === 0 && headless.statusCalls.length === 0);
await headless.run("status");
check("status explains the headless host", headless.lastNotification().includes("hasUI=false"), headless.lastNotification().split("\n")[0]);

// ---------------------------------------------------------------------------
// host 5: a short re-assert, i.e. the line re-asserts itself unattended
// ---------------------------------------------------------------------------

console.log("\n=== short re-assert configured (reassertMs=300, heartbeatMs=250) ===");
resetConfig({ reassertMs: 300, heartbeatMs: 250 });
const durable = makeHost("tui");
tokline(durable.pi);
await durable.emit("session_start");
const beforeIdle = durable.widgetCalls.length;
await sleep(1100);
check("the line re-asserts itself with no events", durable.widgetCalls.length > beforeIdle, `${durable.widgetCalls.length} vs ${beforeIdle}`);
check("the re-asserted line is unchanged", durable.line() === "-- t/s | 0 tok | cache --", durable.line());

console.log("\n--- config file ---");
check("config is persisted under the agent dir", fs.existsSync(CONFIG_FILE), CONFIG_FILE);
if (fs.existsSync(CONFIG_FILE)) console.log(fs.readFileSync(CONFIG_FILE, "utf-8"));

if (failures.length > 0) {
  console.log(`\n${failures.length} FAILED:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nall checks passed");