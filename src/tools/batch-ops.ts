import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import { runWithBridgeCapture, runWithoutBridgeCapture, sendCommand, type BridgeCapture, type BridgeOptions, type CommandResult } from "../bridge/file-bridge.js";
import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { MAX_BRIDGE_SCRIPT_BYTES } from "../bridge/script-size.js";
import { capabilitiesForToolInvocation, guardToolHandler, resolveCapabilities, type CapabilityConfig } from "../security/capabilities.js";
import { argumentDiagnostics, strictDeclaredObjects } from "../workflows/strict-schema.js";
import { assertInvocationNotCancelled } from "../workflows/invocation-context.js";
import { annotateSetEffectPropertyResult } from "./audio-effect-param-scale.js";
import { AUDIO_TRANSITION_HELPERS } from "./audio-transitions.js";

type Result = CommandResult;
type Tool = { parameters: Record<string, unknown>; handler: (args: any) => Promise<Result> };
type Args = Record<string, unknown>;

/** Operations apply_batch accepts. Each is the registered tool of the same name. */
export const BATCH_OPERATIONS = [
  "add_to_timeline",
  "overwrite_clip",
  "insert_from_source",
  "trim_clip",
  "move_clip",
  "ripple_delete",
  "split_clip",
  "set_clip_volume",
  "set_clips_volume",
  "add_transition",
  "add_audio_transition",
  "batch_add_transitions",
  "set_clip_properties",
  "add_marker",
  "apply_effect",
  "set_effect_property",
] as const;
export type BatchOperation = (typeof BATCH_OPERATIONS)[number];
/** Sanity cap on one apply_batch call; anything up to it is split into chunks automatically. */
export const MAX_BATCH_OPERATIONS = 2000;
/** Ops per chunk: one ExtendScript evaluation, ~2-10 s of host time for cheap edits. */
export const CHUNK_OPERATIONS = 100;
/** Idle time between chunks so Premiere repaints and handles input between evaluations. */
const CHUNK_PAUSE_MS = 150;
/** A chunk's script stays this far under the bridge limit; ops whose scripts are re-read between chunks may grow a little. */
const CHUNK_SCRIPT_BUDGET = MAX_BRIDGE_SCRIPT_BYTES - 32 * 1024;

/** Ops that change clip positions; later time-based pre-flight checks are skipped after one. */
const STRUCTURAL = new Set<BatchOperation>(["add_to_timeline", "overwrite_clip", "insert_from_source", "trim_clip", "move_clip", "ripple_delete", "split_clip"]);
/**
 * Read-only host commands a handler sends before its write. They are answered
 * for every op together in one read round trip before the batch is applied.
 */
const READS_BEFORE_WRITE: Partial<Record<BatchOperation, number>> = { trim_clip: 1, ripple_delete: 1 };
const POSTPROCESS: Partial<Record<BatchOperation, (result: Result) => Result>> = { set_effect_property: annotateSetEffectPropertyResult };
/** Host time budget per op, on top of a fixed 30 s. */
const OP_BUDGET_MS: Partial<Record<BatchOperation, number>> = { ripple_delete: 60_000, batch_add_transitions: 20_000, set_clips_volume: 10_000, trim_clip: 5_000 };
const CAPTURED: Result = { success: true, data: { batchCaptured: true } };

export type OpStatus = "verified" | "committed_unverified" | "not_applied" | "failed" | "refused" | "not_run" | "unknown";

interface PreparedOp { index: number; op: BatchOperation; args: Args; script?: string; error?: string }

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stripStatement = (script: string) => script.trimEnd().replace(/;$/, "");

/**
 * Drop indentation and whole-line // comments. ES3 string literals cannot span
 * lines except through a trailing backslash, so a script with one is kept as is.
 */
export function compactScript(script: string): string {
  const lines = script.split("\n");
  if (lines.some(line => line.trimEnd().endsWith("\\"))) return script;
  return lines.map(line => line.trim()).filter(line => line && !line.startsWith("//")).join("\n");
}

function signature(name: string, schema: Record<string, unknown> | undefined): string {
  const properties = Object.keys(record(schema?.properties));
  const required = new Set(Array.isArray(schema?.required) ? schema!.required as string[] : []);
  return `${name}(${properties.map(key => required.has(key) ? `${key}*` : key).join(", ")})`;
}

/** Classify one op's host reply the same way a single tool call is classified. */
export function classifyOp(result: Result): OpStatus {
  const data = record(result.data);
  const outcome = typeof data.outcome === "string" ? data.outcome : undefined;
  if (result.success) {
    if (outcome === "committed_unverified" || outcome === "committed" || data.verified === false) return "committed_unverified";
    return "verified";
  }
  const notApplied = (data.mutationOutcome === "not_applied" || outcome === "not_applied") && data.timelineChanged !== true && data.undoSteps === undefined;
  return notApplied ? "not_applied" : "failed";
}

function parseOp(raw: unknown): Result {
  if (raw && typeof raw === "object" && typeof (raw as Result).success === "boolean") return raw as Result;
  return { success: false, error: "The operation returned no readable result.", data: { mutationOutcome: "unknown" } };
}

// ---- ExtendScript pre-flight ----------------------------------------------
// Checks every op against the timeline as it is before the batch starts, so a
// bad batch refuses before its first write. Checks that depend on clip
// positions are skipped once an earlier op in the batch moves clips; the op's
// own refusal still guards it at apply time.

const PREFLIGHT_HELPERS = `
var __pf = [];
var __pfSeq = app.project.activeSequence;
if (!__pfSeq) return __refuse("apply_batch refused: no active sequence; nothing was changed.");
var __pfFrameTicks = parseFloat(__pfSeq.timebase);
var __pfClips = null;
function __pfFail(i, op, msg) { __pf.push({ index: i, op: op, error: msg }); }
function __pfClip(id) {
  if (!__pfClips) {
    __pfClips = {};
    var kinds = [["video", __pfSeq.videoTracks], ["audio", __pfSeq.audioTracks]];
    for (var k = 0; k < kinds.length; k++) {
      for (var t = 0; t < kinds[k][1].numTracks; t++) {
        var track = kinds[k][1][t];
        for (var c = 0; c < track.clips.numItems; c++) __pfClips["n" + String(track.clips[c].nodeId)] = { clip: track.clips[c], trackType: kinds[k][0], trackIndex: t };
      }
    }
  }
  var key = "n" + String(id);
  return __pfClips.hasOwnProperty(key) ? __pfClips[key] : null;
}
function __pfTrack(type, index) {
  var tracks = type === "audio" ? __pfSeq.audioTracks : __pfSeq.videoTracks;
  return index >= 0 && index < tracks.numTracks ? tracks[index] : null;
}
function __pfCutTicks(seconds) { return __snapSequenceTicks(__pfSeq, __secondsToTicks(seconds)); }
// Clip edges per track, read from the DOM once: each DOM access crosses into the host.
var __pfEdgeCache = {};
function __pfEdges(type, index) {
  var key = type + index;
  if (__pfEdgeCache.hasOwnProperty(key)) return __pfEdgeCache[key];
  var track = __pfTrack(type, index), edges = { starts: [], ends: [] };
  if (track) {
    for (var c = 0; c < track.clips.numItems; c++) {
      edges.starts.push(parseFloat(track.clips[c].start.ticks));
      edges.ends.push(parseFloat(track.clips[c].end.ticks));
    }
  }
  __pfEdgeCache[key] = edges;
  return edges;
}
function __pfHasEdge(type, index, ticks) {
  var edges = __pfEdges(type, index);
  for (var c = 0; c < edges.starts.length; c++) {
    if (Math.abs(edges.ends[c] - ticks) < __pfFrameTicks / 2 || Math.abs(edges.starts[c] - ticks) < __pfFrameTicks / 2) return true;
  }
  return false;
}
function __pfAdjacentPairs(type, index, ticks) {
  var edges = __pfEdges(type, index), tolerance = __pfFrameTicks / 2 + 1, found = 0;
  for (var ci = 0; ci < edges.starts.length; ci++) {
    if (Math.abs(edges.starts[ci] - ticks) > tolerance) continue;
    for (var oi = 0; oi < edges.ends.length; oi++) {
      if (oi !== ci && Math.abs(edges.ends[oi] - edges.starts[ci]) <= tolerance) found++;
    }
  }
  return found;
}
function __pfSpans(type, index, ticks) {
  var edges = __pfEdges(type, index);
  for (var c = 0; c < edges.starts.length; c++) if (edges.starts[c] < ticks && edges.ends[c] > ticks) return true;
  return false;
}
function __pfCovered(type, index, ticks) {
  var track = __pfTrack(type, index), slack = __pfFrameTicks / 2 + 1;
  try {
    for (var t = 0; t < track.transitions.numItems; t++) {
      var tr = track.transitions[t];
      if (parseFloat(tr.start.ticks) - slack <= ticks && parseFloat(tr.end.ticks) + slack >= ticks) return true;
    }
  } catch (e) {}
  return false;
}
var __pfQe = false;
function __pfEnableQe() { if (!__pfQe) { app.enableQE(); __pfQe = true; } }
function __pfVideoTransition(name) {
  __pfEnableQe();
  try { var byName = qe.project.getVideoTransitionByName ? qe.project.getVideoTransitionByName(name) : null; if (byName && String(byName.name || "") !== "") return true; } catch (e1) {}
  try {
    var list = __qeCatalogFrom(qe.project.getVideoTransitionList());
    for (var i = 0; i < list.numItems; i++) if (list[i].name === name) return true;
  } catch (e2) {}
  return false;
}
function __pfVideoEffect(name) {
  __pfEnableQe();
  if (__qeEffectIsOtherKindOnly("video", name)) return false;
  try { var byName = qe.project.getVideoEffectByName(name); if (byName && __qeEffectNameMatches(byName, name)) return true; } catch (e1) {}
  var catalog = __getQeEffectCatalog("video");
  if (!catalog.ok) return false;
  for (var i = 0; i < catalog.effects.numItems; i++) if (catalog.effects[i].name === name) return true;
  return false;
}
function __pfHasComponent(clip, name) {
  try {
    for (var i = 0; i < clip.components.numItems; i++) if (String(clip.components[i].displayName) === name) return true;
  } catch (e) {}
  return false;
}
`;

const str = (value: unknown) => `"${escapeForExtendScript(String(value))}"`;
const num = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

function preflightFor(op: PreparedOp, structuralBefore: boolean, effectsAddedBefore: Set<string>): string {
  const { index: i, args } = op;
  const fail = (msg: string) => `__pfFail(${i}, "${op.op}", ${msg});`;
  const clipCheck = (want?: "audio" | "video") => `
    var __c${i} = __pfClip(${str(args.node_id)});
    if (!__c${i}) ${fail(`"Clip not found: " + ${str(args.node_id)}`)}
    ${want ? `else if (__c${i}.trackType !== "${want}") ${fail(`"Clip is not ${want === "audio" ? "an audio" : "a video"} clip."`)}` : ""}`;
  switch (op.op) {
    case "add_to_timeline":
    case "overwrite_clip": {
      const audio = op.op === "overwrite_clip" && typeof args.audio_track_index !== "number" ? "" : `if (!__pfTrack("audio", ${num(args.audio_track_index, 0)})) ${fail(`"Audio track ${num(args.audio_track_index, 0)} does not exist."`)}`;
      return `
    if (!__findProjectItem(${str(args.item_id)})) ${fail(`"Project item not found: " + ${str(args.item_id)}`)}
    if (!__pfTrack("video", ${num(args.track_index, 0)})) ${fail(`"Video track ${num(args.track_index, 0)} does not exist."`)}
    ${audio}`;
    }
    case "insert_from_source":
      return "";
    case "trim_clip":
    case "ripple_delete":
    case "set_clip_properties":
      return clipCheck();
    case "move_clip":
      return `${clipCheck()}
    ${typeof args.new_track_index === "number" ? `if (__c${i} && !__pfTrack(__c${i}.trackType, ${args.new_track_index})) ${fail(`"Target track ${args.new_track_index} does not exist."`)}` : ""}`;
    case "set_clip_volume":
      return clipCheck("audio");
    case "apply_effect":
      return `${clipCheck("video")}
    if (!__pfVideoEffect(${str(args.effect_name)})) ${fail(`"Video effect not found: " + ${str(args.effect_name)}`)}`;
    case "set_effect_property": {
      const key = JSON.stringify([args.node_id, args.effect_name]);
      return `${clipCheck()}
    ${effectsAddedBefore.has(key) ? "" : `else if (!__pfHasComponent(__c${i}.clip, ${str(args.effect_name)})) ${fail(`"Effect " + ${str(args.effect_name)} + " is not on the clip."`)}`}`;
    }
    case "add_marker":
      return typeof args.node_id === "string" ? clipCheck() : "";
    case "split_clip": {
      const type = args.track_type === "audio" ? "audio" : "video";
      const track = num(args.track_index, 0);
      return `
    var __t${i} = __pfTrack("${type}", ${track});
    if (!__t${i}) ${fail(`"${type} track ${track} does not exist."`)}
    ${structuralBefore ? "" : `else if (!__pfSpans("${type}", ${track}, __pfCutTicks(${num(args.time_seconds, 0)}))) ${fail(`"No clip spans the split time on this track."`)}`}`;
    }
    case "set_clips_volume": {
      const track = num(args.track_index, 0);
      const indices = Array.isArray(args.clip_indices) ? args.clip_indices.filter((value): value is number => typeof value === "number") : [];
      const maxIndex = indices.length ? Math.max(...indices) : -1;
      return `
    var __t${i} = __pfTrack("audio", ${track});
    if (!__t${i}) ${fail(`"Audio track ${track} does not exist."`)}
    ${structuralBefore || maxIndex < 0 ? "" : `else if (${maxIndex} >= __pfEdges("audio", ${track}).starts.length) ${fail(`"Clip index ${maxIndex} is out of range on audio track ${track}."`)}`}`;
    }
    case "add_transition":
    case "batch_add_transitions": {
      const track = num(args.track_index, 0);
      const cut = `__pfCutTicks(${num(args.cut_point_seconds, 0)})`;
      const edge = op.op === "add_transition" && !structuralBefore
        ? `else if (!__pfHasEdge("video", ${track}, ${cut})) ${fail(`"No video clip edge within half a frame of ${num(args.cut_point_seconds, 0)}s."`)}
    else if (__pfCovered("video", ${track}, ${cut})) ${fail(`"A transition already covers the cut at ${num(args.cut_point_seconds, 0)}s."`)}`
        : "";
      return `
    var __t${i} = __pfTrack("video", ${track});
    if (!__t${i}) ${fail(`"Video track ${track} does not exist."`)}
    ${edge}
    if (!__pfVideoTransition(${str(args.transition_name)})) ${fail(`"Video transition not found: " + ${str(args.transition_name)}`)}`;
    }
    case "add_audio_transition": {
      const track = num(args.track_index, 0);
      const name = typeof args.transition_name === "string" ? args.transition_name : "Constant Power";
      return `
    var __t${i} = __pfTrack("audio", ${track});
    if (!__t${i}) ${fail(`"Audio track ${track} does not exist."`)}
    ${structuralBefore ? "" : `else if (__pfAdjacentPairs("audio", ${track}, __pfCutTicks(${num(args.cut_point_seconds, 0)})) !== 1) ${fail(`"The cut at ${num(args.cut_point_seconds, 0)}s must join exactly one pair of adjacent audio clips."`)}
    else if (__pfCovered("audio", ${track}, __pfCutTicks(${num(args.cut_point_seconds, 0)}))) ${fail(`"A transition already covers the cut at ${num(args.cut_point_seconds, 0)}s."`)}`}
    __pfEnableQe();
    if (!__audioTransitionResolve(${str(name)})) ${fail(`"Audio transition not found: " + ${str(name)}`)}`;
    }
  }
}

/**
 * Pre-flight checks for ops that run back to back from the current timeline:
 * clip-position checks stop after the first structural op among them.
 */
export function preflightChecks(ops: PreparedOp[]): string[] {
  const effectsAdded = new Set<string>();
  let structuralBefore = false;
  return ops.map((op) => {
    const check = preflightFor(op, structuralBefore, effectsAdded);
    if (STRUCTURAL.has(op.op)) structuralBefore = true;
    if (op.op === "apply_effect") effectsAdded.add(JSON.stringify([op.args.node_id, op.args.effect_name]));
    return check;
  });
}

const preflightPrelude = (ops: PreparedOp[]) => `
    ${PREFLIGHT_HELPERS}
    ${ops.some(op => op.op === "add_audio_transition") ? AUDIO_TRANSITION_HELPERS : ""}`;

/** One read-only command that pre-flights the given checks and changes nothing. */
export function buildPreflightScript(ops: PreparedOp[], checks: string[]): string {
  return compactScript(buildToolScript(`
    ${preflightPrelude(ops)}
    ${checks.join("\n")}
    if (__pf.length) return __refuse("apply_batch pre-flight refused " + __pf.length + " operation(s); nothing was changed.", { preflightFailures: __pf });
    return '{"success":true,"data":{"preflight":"passed"}}';
  `));
}

/** One chunk's apply script: pre-flight its ops against the live timeline, then run each op's own script in order, stopping at the first failure. */
export function buildBatchScript(ops: PreparedOp[]): string {
  const checks = preflightChecks(ops);
  const apply = ops.map((op, i) => `
    __batchT = new Date().getTime();
    __batchR = ${stripStatement(compactScript(op.script!))};
    __batchMs.push(new Date().getTime() - __batchT);
    __batchOut.push(typeof __batchR === "string" ? __batchR : '{"success":false,"error":"Operation returned no result."}');
    if (__batchOut[${i}].indexOf('{"success":true') !== 0) return __batchFinish(${i});`).join("");
  return compactScript(buildToolScript(`
    var __batchT0 = new Date().getTime();
    ${preflightPrelude(ops)}
    ${checks.join("\n")}
    if (__pf.length) return __refuse("apply_batch pre-flight refused " + __pf.length + " operation(s); nothing was changed.", { preflightFailures: __pf });
    var __batchPreflightMs = new Date().getTime() - __batchT0;
    var __batchUndoStart = __undoStart;
    var __batchOut = [];
    var __batchMs = [];
    var __batchR = null, __batchT = 0;
    function __batchFinish(failedIndex) {
      var meta = { failedIndex: failedIndex, opsRun: __batchOut.length, undoStart: __batchUndoStart, undoNow: __readUndoIndex(), preflightMs: __batchPreflightMs, opMs: __batchMs };
      return '{"success":' + (failedIndex < 0 ? "true" : "false") + ',"data":{"batch":' + __jsonStringify(meta) + ',"ops":[' + __batchOut.join(",") + "]}}";
    }
    ${apply}
    return __batchFinish(-1);
  `));
}

const scriptBytes = (script: string) => Buffer.byteLength(script, "utf-8");

function greedyChunks(ops: PreparedOp[], maxOps: number, budget: number): PreparedOp[][] | null {
  const chunks: PreparedOp[][] = [];
  for (let start = 0; start < ops.length;) {
    let size = Math.min(maxOps, ops.length - start);
    for (;;) {
      const bytes = scriptBytes(buildBatchScript(ops.slice(start, start + size)));
      if (bytes <= budget) break;
      if (size === 1) return null;
      size = Math.max(1, Math.min(size - 1, Math.floor(size * budget / bytes)));
    }
    chunks.push(ops.slice(start, start + size));
    start += size;
  }
  return chunks;
}

/**
 * Split into back-to-back chunks of at most CHUNK_OPERATIONS ops whose scripts
 * fit the bridge, evened out so no chunk is a short tail. Null if one op alone
 * does not fit.
 */
export function planChunks(ops: PreparedOp[], budget = CHUNK_SCRIPT_BUDGET): PreparedOp[][] | null {
  const greedy = greedyChunks(ops, CHUNK_OPERATIONS, budget);
  if (!greedy || greedy.length < 2) return greedy;
  const even = greedyChunks(ops, Math.ceil(ops.length / greedy.length), budget);
  return even && even.length === greedy.length ? even : greedy;
}

/** Whole-batch pre-flight, split into read-only commands that each fit the bridge. */
function planPreflight(ops: PreparedOp[], budget = CHUNK_SCRIPT_BUDGET): string[] {
  const checks = preflightChecks(ops);
  const scripts: string[] = [];
  let group: number[] = [];
  const flush = () => { if (group.length) scripts.push(buildPreflightScript(group.map(i => ops[i]), group.map(i => checks[i]))); group = []; };
  const base = scriptBytes(buildPreflightScript(ops, []));
  let bytes = base;
  checks.forEach((check, i) => {
    const size = scriptBytes(check);
    if (group.length && bytes + size > budget) { flush(); bytes = base; }
    group.push(i);
    bytes += size;
  });
  flush();
  return scripts;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function getBatchOpsTools(
  bridgeOptions: BridgeOptions,
  options: { getToolCatalog: () => Record<string, Tool>; capabilities?: CapabilityConfig; schemas?: Record<string, Record<string, unknown> | undefined> },
) {
  const capabilities = options.capabilities ?? resolveCapabilities();
  const signatures = BATCH_OPERATIONS.map(name => signature(name, options.schemas?.[name])).join("; ");

  async function validate(name: BatchOperation, args: Args): Promise<Tool> {
    const tool = options.getToolCatalog()[name];
    if (!tool) throw new Error(`TOOL_UNAVAILABLE: ${name} is not registered in this session`);
    const schema = strictDeclaredObjects(tool.parameters);
    const diagnostics = argumentDiagnostics(args, schema);
    if (diagnostics.length) throw new Error(diagnostics.join("; "));
    const validation = await fromJsonSchema(schema as JsonSchemaType)["~standard"].validate(args);
    if ("issues" in validation && validation.issues) throw new Error(`INVALID_ARGUMENT: ${validation.issues.map(issue => issue.message).join("; ")}`);
    for (const authority of capabilitiesForToolInvocation(name, args)) if (!capabilities.capabilities.has(authority)) throw new Error(`AUTHORITY_DENIED: ${name} requires ${authority}`);
    return tool;
  }

  /** Answer every op's pre-write reads with one combined read-only command. */
  async function readTogether(scripts: string[]): Promise<Result[]> {
    const script = buildToolScript(`
      var __reads = [];
      ${scripts.map(read => `__reads.push(${stripStatement(read)});`).join("\n")}
      return '{"success":true,"data":{"reads":[' + __reads.join(",") + "]}}";
    `);
    const reply = await runWithoutBridgeCapture(() => sendCommand(script, { ...bridgeOptions, mutating: false }));
    const reads = record(reply.data).reads;
    if (!reply.success || !Array.isArray(reads) || reads.length !== scripts.length) {
      return scripts.map(() => ({ success: false, error: `apply_batch pre-write read failed: ${reply.error ?? "unreadable reply"}`, data: { mutationOutcome: "not_applied" } }));
    }
    return reads.map(parseOp);
  }

  /**
   * Run each op's real handler with sendCommand captured: its validation runs
   * unchanged and its generated script is kept instead of sent. Handlers that
   * read before writing block until all such reads are answered together.
   */
  async function prepare(ops: PreparedOp[]): Promise<void> {
    const pending: { script: string; resolve: (result: Result) => void }[] = [];
    let active = ops.length;
    let idle: (() => void) | null = null;
    const settle = () => { if (active === 0 && idle) { const wake = idle; idle = null; wake(); } };
    const runs = ops.map(async (op) => {
      const reads = READS_BEFORE_WRITE[op.op] ?? 0;
      let sends = 0;
      const capture: BridgeCapture = {
        send: (script) => {
          const n = sends++;
          if (n < reads) {
            return new Promise<Result>((resolve) => {
              pending.push({ script, resolve: (result) => { active++; resolve(result); } });
              active--;
              settle();
            });
          }
          if (n === reads) { op.script = script; return Promise.resolve(CAPTURED); }
          op.script = undefined;
          return Promise.resolve({ success: false, error: "BATCH_UNSUPPORTED: this operation sends more host commands than apply_batch can combine.", data: { mutationOutcome: "not_applied" } });
        },
      };
      try {
        const tool = await validate(op.op, op.args);
        const result = await runWithBridgeCapture(capture, () => guardToolHandler(op.op, tool.handler, capabilities)(op.args));
        if (sends > reads + 1) op.error = "BATCH_UNSUPPORTED: this operation sends more host commands than apply_batch can combine.";
        else if (op.script === undefined || !result?.success) op.error = result?.error ?? "The operation produced no host command.";
      } catch (error) {
        op.error = error instanceof Error ? error.message : String(error);
      } finally {
        if (op.error) op.script = undefined;
        active--;
        settle();
      }
    });
    for (;;) {
      await new Promise<void>((resolve) => { idle = resolve; settle(); });
      if (!pending.length) break;
      const batch = pending.splice(0);
      const results = await readTogether(batch.map(entry => entry.script));
      batch.forEach((entry, index) => entry.resolve(results[index]));
    }
    await Promise.all(runs);
  }

  function opSummary(op: PreparedOp, status: OpStatus, result: Result | undefined, full: boolean): Record<string, unknown> {
    const data = record(result?.data);
    return {
      index: op.index,
      op: op.op,
      status,
      ...(result && !result.success && result.error ? { error: result.error } : {}),
      ...(typeof data.warning === "string" ? { warning: data.warning } : {}),
      ...(typeof data.undoSteps === "number" ? { undoSteps: data.undoSteps } : {}),
      ...(full && result?.data !== undefined ? { result: result.data } : {}),
    };
  }

  const preflightFailures = (data: Record<string, unknown>) => Array.isArray(data.preflightFailures) ? data.preflightFailures.map(record) : [];

  return {
    apply_batch: {
      description:
        "Apply many timeline edits with as few Premiere round trips as possible. Prefer this over calling edit tools in a loop and over execute_extendscript whenever you have two or more of these edits. Any size from 1 to " + MAX_BATCH_OPERATIONS + " operations works in one call: up to " + CHUNK_OPERATIONS + " run in one ExtendScript evaluation, and larger batches are split automatically into back-to-back chunks of up to " + CHUNK_OPERATIONS + " with a short pause between them so Premiere stays responsive. Each operation is { op, args }, where args are exactly that tool's own arguments (validated against its schema). Operations: " + signatures + ". " +
        "Order matters; ops run top to bottom. Before anything is written, every op in the whole batch is validated (schema, the tool's own argument checks, authority) and then pre-flighted in Premiere against the timeline as it was before the batch (clip and project-item IDs, tracks, transition and effect names, cut edges, transitions already at a cut); any failure refuses the whole batch as not_applied with no lock. Pre-flight skips clip-position checks for ops after a structural op (insert, overwrite, trim, move, ripple, split); in a chunked batch each chunk is pre-flighted again against the live timeline right before it runs, which restores those checks from that chunk on, and trim_clip and ripple_delete in later chunks re-read the timeline then. " +
        "Then each op runs its own verified write and readback; the batch stops at the first op that fails in any chunk. If an earlier op already changed the timeline, the result is partial: ops 0 through appliedThrough committed (opsApplied counts them, appliedOperations lists them in compact results of up to " + CHUNK_OPERATIONS + " ops and in full results), failedOperation is the global index that stopped it, and the recovery lock is set, so inspect before another edit. trim_clip and ripple_delete each need one read first; all such reads in a chunk share one extra round trip. " +
        "Undo: Premiere's ExtendScript has no undo grouping, so the batch is not one undo step. undoSteps counts QE undo entries; many DOM writes (volume, scale, markers) record none, so do not rely on Undo to revert a batch. Indices are always global (position in operations). detail 'compact' (default) lists every op's status for batches up to " + CHUNK_OPERATIONS + " ops; above that it returns statusCounts plus only the ops that are not plainly verified. Statuses: verified, committed_unverified, not_applied, failed, refused, not_run, unknown. Pass detail 'full' for every op with its readback and host time.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          operations: {
            type: "array",
            minItems: 1,
            maxItems: MAX_BATCH_OPERATIONS,
            description: `Ordered operations, any number up to ${MAX_BATCH_OPERATIONS}; batches over ${CHUNK_OPERATIONS} are chunked automatically. args are the named tool's own arguments.`,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { type: "string", enum: [...BATCH_OPERATIONS], description: "Tool whose edit this operation performs." },
                args: { type: "object", additionalProperties: true, description: "That tool's arguments, exactly as for a single call." },
              },
              required: ["op", "args"],
            },
          },
          detail: { type: "string", enum: ["compact", "full"], description: `compact (default): per-op status, error, warning, undoSteps; over ${CHUNK_OPERATIONS} ops, statusCounts plus only ops not plainly verified. full: every op with its readback and host time.` },
        },
        required: ["operations"],
      },
      handler: async (args: { operations: { op: BatchOperation; args: Args }[]; detail?: "compact" | "full" }) => {
        const full = args.detail === "full";
        if (!Array.isArray(args.operations) || args.operations.length === 0 || args.operations.length > MAX_BATCH_OPERATIONS) {
          const given = Array.isArray(args.operations) ? ` (${args.operations.length} given)` : "";
          return { success: false, error: `operations must hold 1-${MAX_BATCH_OPERATIONS} items${given}. Batches over ${CHUNK_OPERATIONS} are chunked automatically, so split only past ${MAX_BATCH_OPERATIONS}, into several apply_batch calls. Nothing was changed.`, data: { mutationOutcome: "not_applied", dispatched: false } };
        }
        const ops: PreparedOp[] = args.operations.map((entry, index) => ({ index, op: entry?.op, args: record(entry?.args) }));
        const n = ops.length;
        const unknownOp = ops.find(op => !(BATCH_OPERATIONS as readonly string[]).includes(op.op));
        if (unknownOp) return { success: false, error: `Operation ${unknownOp.index} has unsupported op ${String(unknownOp.op)}. Supported: ${BATCH_OPERATIONS.join(", ")}.`, data: { mutationOutcome: "not_applied", dispatched: false } };

        const results: (Result | undefined)[] = new Array(n);
        const statuses: OpStatus[] = new Array(n).fill("not_run");
        const errors = new Map<number, string>();
        const hostMs: (number | undefined)[] = new Array(n);
        const listing = () => {
          const entries = ops.map((op, i) => {
            const entry = opSummary(op, statuses[i], results[i], full);
            if (entry.error === undefined && errors.has(i)) entry.error = errors.get(i);
            if (full && hostMs[i] !== undefined) entry.hostMs = hostMs[i];
            return entry;
          });
          if (full || n <= CHUNK_OPERATIONS) return { operations: entries };
          const statusCounts: Partial<Record<OpStatus, number>> = {};
          for (const status of statuses) statusCounts[status] = (statusCounts[status] ?? 0) + 1;
          return {
            statusCounts,
            operations: entries.filter(entry => entry.status !== "not_run" && (entry.status !== "verified" || entry.warning !== undefined || entry.error !== undefined)),
            operationsListed: "exceptions only: ops that are not plainly verified (not_run ops are counted, not listed). Pass detail 'full' for every op.",
          };
        };
        const refusal = (error: string, extra: Record<string, unknown> = {}) => ({
          success: false,
          error,
          data: { outcome: "not_applied", mutationOutcome: "not_applied", timelineChanged: false, ...extra, ...listing() },
        });

        const removed = new Map<string, number>();
        for (const op of ops) {
          const target = typeof op.args.node_id === "string" ? op.args.node_id : undefined;
          if (target && removed.has(target)) op.error = `Targets clip ${target}, which operation ${removed.get(target)} ripple-deletes earlier in this batch.`;
          if (op.op === "ripple_delete" && target) removed.set(target, op.index);
          if (op.op === "ripple_delete" && op.args.dry_run === true) op.error = "dry_run is not supported inside apply_batch; call ripple_delete directly to preview.";
        }
        const cuts = new Map<string, number>();
        for (const op of ops) {
          if (op.op !== "add_transition" && op.op !== "add_audio_transition") continue;
          const key = JSON.stringify([op.op, op.args.track_index ?? 0, op.args.cut_point_seconds]);
          if (cuts.has(key)) op.error ??= `Adds a second transition at the cut operation ${cuts.get(key)} already targets.`;
          else cuts.set(key, op.index);
        }
        // Every op's handler runs now, so argument errors anywhere refuse the whole batch.
        // trim_clip and ripple_delete in later chunks run again before their chunk to read the timeline as it is then.
        if (!ops.some(op => op.error)) await prepare(ops);

        const refusedInNode = ops.filter(op => op.error);
        if (refusedInNode.length) {
          for (const op of refusedInNode) { statuses[op.index] = "refused"; errors.set(op.index, op.error!); }
          return refusal(`apply_batch refused before sending anything: ${refusedInNode.length} operation(s) are invalid. Nothing was changed.`, { dispatched: false });
        }

        const chunks = planChunks(ops);
        if (!chunks) {
          return { success: false, error: `apply_batch refused: one operation's script alone exceeds the ${MAX_BRIDGE_SCRIPT_BYTES / 1024} KB bridge limit. Nothing was changed.`, data: { outcome: "not_applied", mutationOutcome: "not_applied", timelineChanged: false, dispatched: false } };
        }
        const started = Date.now();
        const chunkLog: Record<string, unknown>[] = [];
        let undoSteps: number | null = 0;
        let preflightMs: number | null = 0;
        let applyMs = 0;
        let wholeBatchPreflight: { commands: number; wallMs: number } | undefined;
        const chunkInfo = (run: number) => ({ count: chunks.length, run, size: CHUNK_OPERATIONS });
        const hostTiming = () => ({ preflightMs, applyMs, wallMs: Date.now() - started, ...(wholeBatchPreflight ? { wholeBatchPreflight } : {}), ...(chunks.length > 1 ? { chunks: chunkLog } : {}) });
        const undo = () => ({ grouped: false, undoSteps, note: "Premiere's ExtendScript cannot group edits into one undo step. undoSteps counts QE undo entries only; DOM writes such as volume, scale and markers often record none." });

        /** Stop after an earlier op (in this chunk or an earlier one) may have changed the timeline. */
        const partial = (k: number, failedIndex: number, reason: string) => {
          const applied = ops.filter((_, i) => statuses[i] === "verified" || statuses[i] === "committed_unverified").map(op => op.index);
          const notRun = statuses.filter(status => status === "not_run").length;
          const failedStatus = statuses[failedIndex];
          const listed = listing();
          const where = chunks.length > 1 ? ` in chunk ${k + 1} of ${chunks.length}` : "";
          return {
            success: false,
            error: `apply_batch stopped at operation ${failedIndex} (${ops[failedIndex]?.op})${where}: ${reason.replace(/\.+$/, "")}. ` +
              `${applied.length} earlier operation(s) were applied and remain in the timeline; ${notRun} did not run. Inspect the timeline, then acknowledge the recovery lock before the next edit.`,
            data: {
              outcome: "partial",
              mutationOutcome: "unknown",
              recoveryRequired: true,
              timelineChanged: applied.length > 0 || failedStatus === "failed" ? true : null,
              opsApplied: applied.length,
              appliedThrough: applied.length ? applied[applied.length - 1] : null,
              ...(full || n <= CHUNK_OPERATIONS ? { appliedOperations: applied } : {}),
              failedOperation: failedIndex,
              ...(chunks.length > 1 ? { failedChunk: k, chunks: chunkInfo(k + 1) } : {}),
              partialSteps: (listed.operations as { index: number }[]).filter(entry => entry.index <= failedIndex),
              undo: undo(),
              hostTiming: hostTiming(),
              ...listed,
            },
          };
        };

        // A chunked batch is pre-flighted as a whole, read-only, before its first write.
        if (chunks.length > 1) {
          const t0 = Date.now();
          const scripts = planPreflight(ops);
          for (const script of scripts) {
            assertInvocationNotCancelled();
            const reply = await sendCommand(script, { ...bridgeOptions, mutating: false });
            const failures = preflightFailures(record(reply.data));
            if (failures.length) {
              for (const failure of failures) if (typeof failure.index === "number") { statuses[failure.index] = "refused"; errors.set(failure.index, String(failure.error)); }
              return refusal(`apply_batch pre-flight refused ${failures.length} operation(s) across the whole batch of ${n}; nothing was changed.`, { refusedBeforeChange: true, chunks: chunkInfo(0) });
            }
            if (!reply.success) return refusal(`apply_batch pre-flight could not run: ${reply.error ?? "unreadable reply"}. Nothing was changed.`, { chunks: chunkInfo(0) });
          }
          wholeBatchPreflight = { commands: scripts.length, wallMs: Date.now() - t0 };
        }

        for (let k = 0; k < chunks.length; k++) {
          const chunk = chunks[k];
          const first = chunk[0].index;
          if (k > 0) {
            await pause(CHUNK_PAUSE_MS);
            try { assertInvocationNotCancelled(); }
            catch (error) { errors.set(first, error instanceof Error ? error.message : String(error)); return partial(k, first, "the request was cancelled between chunks"); }
            const rereads = chunk.filter(op => READS_BEFORE_WRITE[op.op]);
            if (rereads.length) {
              for (const op of rereads) { op.script = undefined; op.error = undefined; }
              await prepare(rereads);
              const bad = rereads.find(op => op.error);
              if (bad) { statuses[bad.index] = "refused"; errors.set(bad.index, bad.error!); return partial(k, bad.index, bad.error!); }
            }
          } else {
            assertInvocationNotCancelled();
          }
          const script = buildBatchScript(chunk);
          if (scriptBytes(script) > MAX_BRIDGE_SCRIPT_BYTES - 4096) {
            const reason = `the chunk's script exceeds the ${MAX_BRIDGE_SCRIPT_BYTES / 1024} KB bridge limit`;
            if (k === 0) return { success: false, error: `apply_batch refused: ${reason}. Nothing was changed.`, data: { outcome: "not_applied", mutationOutcome: "not_applied", timelineChanged: false, dispatched: false, scriptBytes: scriptBytes(script) } };
            statuses[first] = "refused"; errors.set(first, reason);
            return partial(k, first, reason);
          }
          const timeoutMs = Math.min(900_000, Math.max(bridgeOptions.timeoutMs ?? 30_000, 30_000 + chunk.reduce((sum, op) => sum + (OP_BUDGET_MS[op.op] ?? 2_000), 0)));
          const t0 = Date.now();
          const reply = await sendCommand(script, { ...bridgeOptions, timeoutMs, mutating: true, mutationOnTimeout: true });
          const wallMs = Date.now() - t0;
          const data = record(reply.data);

          // Pre-flight refusal, timeout or a bridge failure: no per-op list came back.
          if (!Array.isArray(data.ops)) {
            chunkLog.push({ chunk: k, first, last: chunk[chunk.length - 1].index, ops: chunk.length, wallMs });
            const failures = preflightFailures(data);
            if (failures.length) {
              for (const failure of failures) if (typeof failure.index === "number") { statuses[failure.index] = "refused"; errors.set(failure.index, String(failure.error)); }
              if (k === 0) return { ...reply, data: { ...data, outcome: data.mutationOutcome === "not_applied" ? "not_applied" : data.outcome, ...(chunks.length > 1 ? { chunks: chunkInfo(1) } : {}), ...listing() } };
              const firstRefused = Math.min(...failures.map(failure => Number(failure.index)).filter(Number.isFinite));
              return partial(k, firstRefused, `pre-flight against the timeline after chunk ${k} refused ${failures.length} operation(s): ${String(failures[0].error)}`);
            }
            if (k === 0) return reply;
            const unknown = data.mutationOutcome !== "not_applied";
            for (const op of chunk) statuses[op.index] = unknown ? "unknown" : "not_run";
            errors.set(first, reply.error ?? "The bridge returned no result for this chunk.");
            return partial(k, first, reply.error ?? "the bridge returned no result for this chunk");
          }

          const batch = record(data.batch);
          const opMs = Array.isArray(batch.opMs) ? batch.opMs.filter((value): value is number => typeof value === "number") : [];
          data.ops.slice(0, chunk.length).forEach((raw, i) => {
            const op = chunk[i];
            const parsed = parseOp(raw);
            const post = POSTPROCESS[op.op];
            results[op.index] = post ? post(parsed) : parsed;
            statuses[op.index] = classifyOp(results[op.index]!);
            hostMs[op.index] = opMs[i];
          });
          const chunkUndo = typeof batch.undoStart === "number" && typeof batch.undoNow === "number" ? Math.max(0, batch.undoNow - batch.undoStart) : null;
          undoSteps = undoSteps === null || chunkUndo === null ? null : undoSteps + chunkUndo;
          const chunkPreflightMs = typeof batch.preflightMs === "number" ? batch.preflightMs : null;
          preflightMs = preflightMs === null || chunkPreflightMs === null ? null : preflightMs + chunkPreflightMs;
          const chunkApplyMs = opMs.reduce((sum, value) => sum + value, 0);
          applyMs += chunkApplyMs;
          chunkLog.push({ chunk: k, first, last: chunk[chunk.length - 1].index, ops: chunk.length, preflightMs: chunkPreflightMs, applyMs: chunkApplyMs, wallMs });

          const failedLocal = typeof batch.failedIndex === "number" ? batch.failedIndex : -1;
          if (failedLocal < 0 && reply.success) continue;
          const failedIndex = chunk[failedLocal >= 0 ? Math.min(failedLocal, chunk.length - 1) : Math.min(data.ops.length, chunk.length - 1)].index;
          if (k === 0 && failedIndex === 0 && statuses[0] === "not_applied" && (chunkUndo === null || chunkUndo === 0)) {
            return {
              success: false,
              error: `apply_batch stopped at operation 0 (${ops[0].op}), which refused before changing anything: ${results[0]?.error ?? "refused"}. Nothing was changed.`,
              data: { outcome: "not_applied", mutationOutcome: "not_applied", timelineChanged: false, refusedBeforeChange: true, opsApplied: 0, ...(chunks.length > 1 ? { chunks: chunkInfo(1) } : {}), undo: undo(), hostTiming: hostTiming(), ...listing() },
            };
          }
          return partial(k, failedIndex, results[failedIndex]?.error ?? reply.error ?? "failed");
        }

        const allVerified = statuses.every(status => status === "verified");
        return {
          success: true,
          data: {
            outcome: allVerified ? "verified" : "committed_unverified",
            verified: allVerified,
            opsApplied: n,
            timelineChanged: true,
            ...(chunks.length > 1 ? { chunks: chunkInfo(chunks.length) } : {}),
            undo: undo(),
            hostTiming: hostTiming(),
            ...listing(),
          },
        };
      },
    },
  };
}
