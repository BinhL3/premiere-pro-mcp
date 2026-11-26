# Performance notes

## July 2026 audit

The bridge used synchronous existence checks every 100 ms for every in-flight command. Node's
filesystem documentation recommends `fs.watch()` over stat polling when possible, while warning
that watching can be unreliable on some network and virtualized filesystems. The bridge therefore
uses event notification as the low-latency path and retains a polling fallback for correctness
(10 ms during a command's first 2 s, then 250 ms; see the November 2026 notes below).

The Streamable HTTP endpoint intentionally remains stateless. The MCP transport specification
permits servers without session management, but this means each request constructs a new
`McpServer`. Tool definitions and converted Zod schemas are immutable for a given bridge and
capability configuration, so they are cached while each request still receives an independent MCP
server and transport.

Research sources:

- [Node.js filesystem API](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)
- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Adobe Premiere UXP ESLint and transaction guidance](https://developer.adobe.com/premiere-pro/uxp/resources/fundamentals/eslint-support/)

## Local benchmark

Windows, Node.js 22, 100 `createServer()` calls:

| Path | Average |
|---|---:|
| Cache bypassed with unique bridge configurations | 5.873 ms |
| Reused bridge configuration | 2.208 ms |

This is a 62.4% reduction in repeated server-construction time. It does not measure Premiere host
execution time or claim equivalent end-to-end editing latency. Bridge watcher behavior is covered
by unit tests; live CEP latency remains dependent on Premiere and the host filesystem.

## November 2026: per-call bridge cost and `apply_batch`

### Where a CEP tool call spends its time

Path: MCP client → stdio → server handler → `withBridgeWorkflow` (queue + cooperating-process
lease) → command file `cmd_<id>.jsx` (bootstrap line + script) → CEP panel claims it →
`CSInterface.evalScript` → ExtendScript → panel writes `res_<id>.json` → server notices the reply →
parse → MCP result.

Each stage is now timed per call (`get_operation_performance` with `recent`, and `stageTimingMs`
medians in `get_bridge_telemetry`). `host_eval` uses ExtendScript's own clock: the server prefixes
`buildScript()` output with a clock read and splices `__hostEvalMs` into the reply, then removes it
before any caller sees the result.

Live, Premiere 27 (macOS), 40 single edits (20 Constant Power crossfades + 20 clip gain changes) on
a 21-clip sequence, installed CEP panel still polling at 200 ms. Per-call average:

| Stage | ms per call | Evidence |
|---|---:|---|
| queue_wait + lease_acquire | ~1 | lease is `mkdir` + `owner.json` write/read/unlink |
| dispatch (staged write + rename) | ~1 | |
| pickup (publish → panel claims the file) | 63-83 | panel `setInterval(processCommands, 200)` in `cep-plugin/main.js`; expected mean ~100 ms minus overlap |
| host_eval (ExtendScript, incl. per-op readback) | 35-105 | varies run to run with Premiere's state; the same 40 edits took 1.4-4.3 s in total |
| transit after claim (evalScript marshalling, panel JSON re-encode, reply write) | ~30 | `bridge_transit − pickup − reply_notice` |
| reply_notice (reply written → server notices) | 14 → 4.5 | macOS batches FSEvents; fixed by the 10 ms fast-poll window |
| readback (JSON.parse) | <1 | |
| server + MCP framing | ~10 | wall − host_wait |

Not costs today: the ~200 KB helper prelude loads once per engine (`$.evalFile` behind a version
check), the recovery journal is written only for an unknown outcome, and directory validation is a
few `lstat` calls. Every mutating command also reads the QE undo index twice (a few ms of host
time) for undo accounting.

### What changed

- **`apply_batch`**: N edits in one round trip and one evaluation. Each op runs through its own
  tool handler with `sendCommand` captured (`runWithBridgeCapture`), so validation and generated
  scripts are the existing ones; pre-flight runs first in the same evaluation (42-53 ms for 40
  ops). Measured: 40 single calls took 4.4-7.3 s of bridge time against 2.0-4.0 s for the same edits
  in one batch (8.8 s vs 5.2 s at the start of the work). The larger saving is outside the bridge:
  one model turn instead of 40.
- **Panel pickup**: the panel watches the bridge directory and runs a command when its file
  appears; the 200 ms poll stays as fallback. This removes most of the 63-83 ms pickup per call
  once the panel is reinstalled and Premiere restarted. Not yet measured live: the installed panel and
  its headless instance load new code only on a restart.
- **Reply notice**: 10 ms polling during a command's first 2 s (an `existsSync` per tick), then
  250 ms; events remain the primary path.
- **Telemetry**: `lease_acquire`, `pickup`, `host_eval`, `bridge_transit`, `reply_notice`.

Expected per-call bridge overhead after a panel restart: ~40 ms (from ~95-125 ms).

Not changed, noted for later: each tool result is sent twice, once as `structuredContent` and once
as pretty-printed JSON text, so compact text would roughly halve MCP payload size. `ripple_delete`
sends a dry-run and then the real command; the real script repeats every check.

### Automatic chunking (`apply_batch` past 100 ops)

`apply_batch` takes up to 2,000 operations and splits them into back-to-back chunks, one
ExtendScript evaluation each. The chunk size is bounded by two limits: at most 100 ops, and a
script under the 500 KB bridge limit (less 32 KB headroom). Each op's generated script is large
(about 3.7 KB for a clip gain, 6.3 KB for an audio crossfade), so the byte limit usually binds
first: ~64 crossfades or ~100 gain changes fit one chunk. Chunks are then evened out (250 gains
become 84/84/82, not 100/100/50). A 100-op chunk of cheap edits runs in a few seconds of host
time, far inside its bridge timeout (30 s plus a per-op budget), and the server waits 150 ms
between chunks so Premiere can repaint and take input.

Pre-flight across chunks:

- Before the first write, every op's handler runs in Node (schema, argument checks, authority,
  the shared pre-write reads), and every op is pre-flighted in Premiere in read-only commands
  covering the whole batch. Clip-position checks stop after the first structural op of the batch,
  as in a single chunk. Any failure refuses the whole batch as `not_applied` with no lock.
- Each chunk pre-flights again, against the live timeline, at the top of its own evaluation, and
  `trim_clip`/`ripple_delete` in later chunks re-read the timeline just before their chunk. A
  refusal there comes after earlier chunks wrote, so it is reported as `partial` with the lock.

### Bigger change, not built: everything over the UXP WebSocket

The UXP bridge (`src/bridge/uxp-websocket-bridge.ts`) is already a persistent, authenticated
loopback WebSocket. Requests are pushed and correlated, with no polling and no files. Moving the
edit surface (and `apply_batch`) onto it would give:

- **Latency**: no pickup and no file I/O. Transit becomes a loopback frame (sub-millisecond) plus
  the UXP call itself, so overhead should drop to a few ms per call. CEP's floor is ~40 ms even with
  watchers on both sides.
- **Real undo grouping**: `project.executeTransaction()` commits a set of actions as one undoable
  step. ExtendScript has no equivalent, which is why `apply_batch` reports `grouped: false`.
- **Atomicity**: actions built in a `lockedAccess` block commit together or not at all, so a
  mid-batch failure would no longer leave a partial edit.

Limits:

- **Coverage**: UXP exposes documented DOM actions only (move, trim, clone, remove, component
  params, markers, sequence settings; see `docs/adobe-uxp-26.3-coverage.md`). Most of what the CEP
  tools do through the undocumented QE DOM has no UXP action: razor/split, insert with sync-lock
  razoring, QE transition placement, and the QE effect catalog. Those stay on CEP, so a batch
  mixing them cannot be one transaction.
- **Versions**: Premiere 25.6+ only, with a token-configured UXP panel. CEP must stay for older
  hosts, and a failed UXP mutation must never be retried through CEP.
- **No await inside a transaction**: readback has to happen after commit, and an action that
  fails construction aborts the whole set.
- **Behaviour differences**: transition defaults and alignment, volume units and effect
  parameter scales differ between the DOM, QE and UXP. Each op needs its own live validation
  before it can replace its CEP version.

A practical order: move the high-volume, UXP-covered ops first (clip volume, clip properties,
markers, move/trim) behind `apply_batch` routing, keep QE-only ops on CEP, and split a mixed batch
into one UXP transaction plus one CEP evaluation, reporting which part committed.
