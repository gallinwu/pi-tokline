/**
 * Real-loader harness: loads index.ts through pi's OWN loader - jiti, with the
 * same virtual-module aliases pi configures - instead of Node's type stripping.
 *
 * `load.mjs` proves the logic; this proves the module survives the loader that
 * actually runs inside pi (type-only imports erased, `.ts` specifiers resolved).
 *
 * Run: node harness/real-loader.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tokline-real-"));

const CANDIDATE_ROOTS = [
  path.join(os.homedir(), ".pi", "agent", "install", "releases"),
  "E:/pi/Pi Agent/resources/server/node_modules",
];

function resolvePiRoot() {
  if (process.env.PI_MODULES_ROOT) return process.env.PI_MODULES_ROOT;
  for (const root of CANDIDATE_ROOTS) {
    if (root.endsWith("releases")) {
      if (!fs.existsSync(root)) continue;
      for (const version of fs.readdirSync(root)) {
        const modules = path.join(root, version, "node_modules");
        if (fs.existsSync(path.join(modules, "@earendil-works/pi-coding-agent"))) return modules;
      }
      continue;
    }
    if (fs.existsSync(path.join(root, "@earendil-works/pi-coding-agent"))) return root;
  }
  throw new Error("could not locate a pi installation; set PI_MODULES_ROOT");
}

const PI_ROOT = resolvePiRoot();
console.log("pi modules: " + PI_ROOT);

const require = createRequire(path.join(PI_ROOT, "index.js"));
const { createJiti } = require(path.join(PI_ROOT, "jiti/lib/jiti.cjs"));

const entry = path.resolve(import.meta.dirname, "..", "index.ts");
const jiti = createJiti(entry, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": path.join(PI_ROOT, "@earendil-works/pi-coding-agent/dist/index.js"),
    "@earendil-works/pi-agent-core": path.join(PI_ROOT, "@earendil-works/pi-agent-core/dist/index.js"),
    typebox: path.join(PI_ROOT, "typebox/build/index.mjs"),
  },
});

const mod = await jiti.import(entry, { default: true });
const tokline = mod?.default ?? mod;

const failures = [];
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};

check("the loader returns a callable extension", typeof tokline === "function");

const handlers = new Map();
const commands = new Map();
const paints = [];
const statuses = [];
const pi = {
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(handler);
    return () => {};
  },
  registerCommand(name, options) {
    commands.set(name, options);
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

// An RPC-style front end on purpose: that is the host where the first version
// rendered nothing at all, and the loader path is the part this harness checks.
const ctx = {
  mode: process.env.TOKLINE_HARNESS_MODE ?? "rpc",
  hasUI: true,
  cwd: process.cwd(),
  ui: {
    notify(message) {
      console.log("notify: " + message.split("\n")[0]);
    },
    setWidget(key, content, options) {
      paints.push({ key, content, options });
    },
    setStatus(key, text) {
      statuses.push({ key, text });
    },
  },
  sessionManager: { getSessionId: () => "real-loader" },
  isIdle: () => true,
  isProjectTrusted: () => true,
  getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 1 }),
};

tokline(pi);
check("registers /tokline", commands.has("tokline"));
check("subscribes to the message lifecycle", handlers.has("message_start") && handlers.has("message_update") && handlers.has("message_end"));

await handlers.get("message_start")[0]({ type: "message_start", message: { role: "assistant" } }, ctx);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Deltas spaced out in real time, the way a provider delivers them; an
// instant synthetic burst would leave the window below its measurement floor.
for (let i = 0; i < 3; i++) {
  await handlers.get("message_update")[0](
    { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4000) } },
    ctx,
  );
  console.log("streaming: " + (paints[paints.length - 1]?.content?.[0] ?? "(no paint)"));
  await sleep(120);
}
await handlers.get("message_end")[0](
  {
    type: "message_end",
    message: { role: "assistant", usage: { input: 200, output: 4000, cacheRead: 1800, cacheWrite: 0, totalTokens: 6000, cost: { total: 0.61 } } },
  },
  ctx,
);

const line = paints[paints.length - 1]?.content?.[0] ?? "(nothing painted)";
console.log("rendered line from the real loader: " + line);
check("paints one line under the editor", paints.length > 0 && paints[paints.length - 1].options?.placement === "belowEditor");
check("the line carries the three segments", /t\/s/.test(line) && / tok/.test(line) && /cache \d/.test(line), line);
if (ctx.mode === "tui") {
  check("the TUI leaves the footer alone (auto = editor slot only)", statuses.length === 0, `${statuses.length} status pushes`);
} else {
  check("the footer status channel carries the same line", statuses.at(-1)?.text === line, statuses.at(-1)?.text);
}

if (failures.length > 0) {
  console.log(`\n${failures.length} FAILED: ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("\nreal-loader checks passed");