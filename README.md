# pi-tokline

**A live usage line under the pi editor.** Output rate, session tokens and the
provider's cache hit rate, in one line that stays where you can see it:

```
42.3 t/s | 1.24M tok | cache 87.4%
```

Most usage tooling tells you what you spent an hour ago. This answers the three
questions you actually ask *while* a run is going: how fast is it producing, how
much has this session moved, and how much of the input the provider served from
its prompt cache. It updates as the model streams and costs nothing when idle.

## Techniques

### 1. One rate, two definitions

While a message streams, the only evidence available is the delta stream, so the
rate is a sliding-window estimate over the last `windowMs` and is rendered with a
`~` (`~42.3 t/s`). The moment the message ends, the provider's own `output` count
replaces it over the real wall-clock time and the `~` disappears.

Two problems this solves. A cumulative average would keep reporting the slow
start of a long message forever, so the window slides instead. And a number that
can still move must never be dressed as a settled one, so the estimate is marked
at the character level and the marker is load-bearing: `/tokline status` also
states which of the two it is currently showing.

### 2. Provider-truth token accounting

The session total is `input + output + cacheRead + cacheWrite`, summed from
assistant message usage only. Cache reads are included because they are real
tokens the model consumed — hiding them makes a session look smaller than the
context it actually carried.

It is deliberately **not** smoothed with a live estimate: it steps once per
message. Mixing an estimate into a billed number is how a tool ends up reporting
a total that never matches the invoice. The same reasoning puts the cache hit
rate on a stated definition — cache reads over the whole input side
(`cacheRead / (input + cacheRead)`), with `n/a` rather than `0%` when a session
has no input-side traffic at all.

### 3. Host-adaptive dual-channel rendering

Pi front ends are not one surface, so the line is pushed through every channel
the host can accept, and the choice is made from the host's own mode:

| Channel | Where it lands |
| --- | --- |
| `setWidget(key, lines, { placement: "belowEditor" })` | the terminal's own slot between the editor and the footer |
| `setStatus(key, text)` | the footer's extension-status line |

On the terminal, the editor slot alone is used — a second copy in the footer would
be noise. Anywhere else the extension asks for **both**, because non-terminal
front ends receive them as forwarded `extension_ui_request` messages and decide
for themselves what to draw. `surface` overrides the heuristic when a client
behaves differently than its mode suggests.

### 4. Self-healing heartbeat, zero-cost steady state

A widget is a host-side object: reloads, compaction and client re-mounts can drop
it. A heartbeat reconsiders the line once a second and re-asserts an unchanged one
after `reassertMs`, so the line comes back on its own. The other half matters just
as much — in steady state nothing is repainted, because a status line that
triggers a redraw per tick is worse than no status line. Streaming repaints are
throttled to `throttleMs`.

### 5. Session-aware token estimation for the live rate

The live estimate counts CJK characters at roughly 0.75 tokens each and everything
else at roughly 4 characters per token, counting astral characters once rather
than twice. English and Chinese sessions therefore report comparable rates
instead of one of them reading 4x high.

### 6. Fully non-invasive

The extension never touches the transcript, the prompt, or the prompt cache. It
only reads usage that the host already produced and writes to two UI channels. An
extension that changed what the model sees would invalidate the very prefix cache
it is measuring.

### 7. Failures are data, not silence

Every channel attempt is recorded — attempted, succeeded, or the error text — and
`/tokline status` prints the host mode, whether a UI was available, which channels
were tried and what each did. A host that refuses to draw is a fact you can read
instead of a blank space you have to debug:

```
render   mode=rpc hasUI=true surfaces=widget+status
  widget ok
  status ok
```

## Install

```bash
cp -r /path/to/pi-tokline ~/.pi/agent/packages/pi-tokline
```

then add it to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["./packages/pi-tokline"]
}
```

Via git or npm:

```bash
pi install git:github.com/gallinwu/pi-tokline
pi install npm:pi-tokline
```

Extensions load at startup: restart pi.

## Commands

```
/tokline                     status: the line, the breakdown, the rate source, host channels
/tokline on | off            show or hide the line
/tokline reset               zero the session counters
/tokline rate                toggle the t/s segment
/tokline tokens              toggle the token segment
/tokline cache               toggle the cache segment
/tokline cost                toggle the cost segment
/tokline context             toggle the context-window segment
/tokline surface auto|widget|status|both
/tokline placement above|below
/tokline separator <text>    join segments with something else
/tokline config              print the config file path and contents
```

## Configuration

`~/.pi/agent/tokline/config.json` (`PI_CODING_AGENT_DIR` is honoured, as pi
itself does). Defaults:

```json
{
  "enabled": true,
  "placement": "belowEditor",
  "surface": "auto",
  "throttleMs": 120,
  "heartbeatMs": 1000,
  "reassertMs": 15000,
  "windowMs": 3000,
  "countThinking": false,
  "line": {
    "showRate": true,
    "showTokens": true,
    "showCache": true,
    "showCost": false,
    "showContext": false,
    "separator": " | ",
    "prefix": ""
  }
}
```

`countThinking` is off by default: thinking tokens are output tokens, but they are
not what "speed" usually means to the reader. `prefix` takes a short marker for
the first segment (`"\u26a1 "`).

The line is plain text with no ANSI escapes, so it stays copyable and testable.

## Verified

```
node --test test/*.test.ts    # 27 pure-logic tests: metering, rate windows, estimation, the line
node harness/load.mjs         # five fake hosts: terminal, RPC, widget-hostile, headless, short re-assert
node harness/real-loader.mjs  # loads index.ts through pi's own loader (jiti + virtual modules)
TOKLINE_HARNESS_MODE=tui node harness/real-loader.mjs
```

The harness covers the host matrix rather than one happy path, including the
regression that shipped once: a host-mode guard that rendered nothing on every
non-terminal front end while the command still worked, plus the swallowed render
error that hid it. Both are asserted now, so neither can come back quietly.

## Requirements

Pi 1.x, Node 22+. Uses `ctx.ui.setWidget` / `ctx.ui.setStatus` and the
`message_start` / `message_update` / `message_end` lifecycle. No runtime
dependencies — `@earendil-works/pi-coding-agent` is imported for types only, so
the module loads through strip-only TypeScript as well as through pi's loader.

## License

MIT