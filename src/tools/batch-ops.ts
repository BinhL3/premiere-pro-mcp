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
export const MAX_BATCH_OPERATIONS = 100;

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

export type OpStatus = "verified" | "committed_unverified" | "not_applied" | "failed" | "refused" | "not_run";

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

/** The one apply script: pre-flight every op, then run each op's own script in order, stopping at the first failure. */
export function buildBatchScript(ops: PreparedOp[]): string {
  const effectsAdded = new Set<string>();
  let structuralBefore = false;
  const checks: string[] = [];
  for (const op of ops) {
    checks.push(preflightFor(op, structuralBefore, effectsAdded));
    if (STRUCTURAL.has(op.op)) structuralBefore = true;
    if (op.op === "apply_effect") effectsAdded.add(JSON.stringify([op.args.node_id, op.args.effect_name]));
  }
  const apply = ops.map((op, i) => `
    __batchT = new Date().getTime();
    __batchR = ${stripStatement(compactScript(op.script!))};
    __batchMs.push(new Date().getTime() - __batchT);
    __batchOut.push(typeof __batchR === "string" ? __batchR : '{"success":false,"error":"Operation returned no result."}');
    if (__batchOut[${i}].indexOf('{"success":true') !== 0) return __batchFinish(${i});`).join("");
  return compactScript(buildToolScript(`
    var __batchT0 = new Date().getTime();
    ${PREFLIGHT_HELPERS}
    ${ops.some(op => op.op === "add_audio_transition") ? AUDIO_TRANSITION_HELPERS : ""}
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

  function opSummary(op: PreparedOp, status: OpStatus, result: Result | undefined, full: boolean) {
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

  return {
    apply_batch: {
      description:
        "Apply many timeline edits in ONE Premiere round trip and ONE ExtendScript evaluation. Prefer this over calling edit tools in a loop and over execute_extendscript whenever you have two or more of these edits. Each operation is { op, args }, where args are exactly that tool's own arguments (validated against its schema). Operations: " + signatures + ". " +
        "Order matters; ops run top to bottom. Before anything is written, every op is validated (schema, the tool's own argument checks, authority) and then pre-flighted in Premiere against the timeline as it was before the batch (clip and project-item IDs, tracks, transition and effect names, cut edges, transitions already at a cut); any failure refuses the whole batch as not_applied with no lock. Pre-flight skips clip-position checks for ops after a structural op (insert, overwrite, trim, move, ripple, split). " +
        "Then each op runs its own verified write and readback; the batch stops at the first op that fails. If an earlier op already changed the timeline, the result is partial: opsApplied lists exactly which ops committed, and the recovery lock is set, so inspect before another edit. trim_clip and ripple_delete each need one read first; all such reads share one extra round trip. " +
        "Undo: Premiere's ExtendScript has no undo grouping, so the batch is not one undo step. undoSteps counts QE undo entries; many DOM writes (volume, scale, markers) record none, so do not rely on Undo to revert a batch. Returns one compact per-op status list (verified, committed_unverified, not_applied, failed, refused, not_run); pass detail 'full' to include each op's readback.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          operations: {
            type: "array",
            minItems: 1,
            maxItems: MAX_BATCH_OPERATIONS,
            description: "Ordered operations. args are the named tool's own arguments.",
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
          detail: { type: "string", enum: ["compact", "full"], description: "compact (default): per-op status, error, warning, undoSteps. full: also each op's readback." },
        },
        required: ["operations"],
      },
      handler: async (args: { operations: { op: BatchOperation; args: Args }[]; detail?: "compact" | "full" }) => {
        const full = args.detail === "full";
        if (!Array.isArray(args.operations) || args.operations.length === 0 || args.operations.length > MAX_BATCH_OPERATIONS) {
          return { success: false, error: `operations must hold 1-${MAX_BATCH_OPERATIONS} items.`, data: { mutationOutcome: "not_applied", dispatched: false } };
        }
        const ops: PreparedOp[] = args.operations.map((entry, index) => ({ index, op: entry?.op, args: record(entry?.args) }));
        const unknownOp = ops.find(op => !(BATCH_OPERATIONS as readonly string[]).includes(op.op));
        if (unknownOp) return { success: false, error: `Operation ${unknownOp.index} has unsupported op ${String(unknownOp.op)}. Supported: ${BATCH_OPERATIONS.join(", ")}.`, data: { mutationOutcome: "not_applied", dispatched: false } };

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
        if (!ops.some(op => op.error)) await prepare(ops);

        const refusedInNode = ops.filter(op => op.error);
        if (refusedInNode.length) {
          return {
            success: false,
            error: `apply_batch refused before sending anything: ${refusedInNode.length} operation(s) are invalid. Nothing was changed.`,
            data: {
              outcome: "not_applied", mutationOutcome: "not_applied", timelineChanged: false, dispatched: false,
              operations: ops.map(op => ({ index: op.index, op: op.op, status: (op.error ? "refused" : "not_run") as OpStatus, ...(op.error ? { error: op.error } : {}) })),
            },
          };
        }

        const script = buildBatchScript(ops);
        if (Buffer.byteLength(script, "utf-8") > MAX_BRIDGE_SCRIPT_BYTES - 4096) {
          return { success: false, error: `apply_batch refused: the combined script exceeds the ${MAX_BRIDGE_SCRIPT_BYTES / 1024} KB bridge limit. Split the operations into smaller batches. Nothing was changed.`, data: { outcome: "not_applied", mutationOutcome: "not_applied", timelineChanged: false, dispatched: false, scriptBytes: Buffer.byteLength(script, "utf-8") } };
        }
        const timeoutMs = Math.min(900_000, Math.max(bridgeOptions.timeoutMs ?? 30_000, 30_000 + ops.reduce((sum, op) => sum + (OP_BUDGET_MS[op.op] ?? 2_000), 0)));
        assertInvocationNotCancelled();
        const reply = await sendCommand(script, { ...bridgeOptions, timeoutMs, mutating: true, mutationOnTimeout: true });
        const data = record(reply.data);

        // Pre-flight refusal, timeout or a bridge failure: no per-op list came back.
        if (!Array.isArray(data.ops)) {
          const failures = Array.isArray(data.preflightFailures) ? data.preflightFailures.map(record) : [];
          if (!failures.length) return reply;
          return {
            ...reply,
            data: {
              ...data,
              outcome: data.mutationOutcome === "not_applied" ? "not_applied" : data.outcome,
              operations: ops.map(op => {
                const failure = failures.find(entry => entry.index === op.index);
                return { index: op.index, op: op.op, status: (failure ? "refused" : "not_run") as OpStatus, ...(failure ? { error: String(failure.error) } : {}) };
              }),
            },
          };
        }

        const batch = record(data.batch);
        const results = data.ops.map((raw, i) => {
          const parsed = parseOp(raw);
          const post = POSTPROCESS[ops[i]?.op];
          return post ? post(parsed) : parsed;
        });
        const statuses = results.map(classifyOp);
        const operations = ops.map((op, i) => i < results.length ? opSummary(op, statuses[i], results[i], full) : { index: op.index, op: op.op, status: "not_run" as OpStatus });
        const undoStart = typeof batch.undoStart === "number" ? batch.undoStart : null;
        const undoNow = typeof batch.undoNow === "number" ? batch.undoNow : null;
        const undoSteps = undoStart !== null && undoNow !== null ? Math.max(0, undoNow - undoStart) : null;
        const opMs = Array.isArray(batch.opMs) ? batch.opMs.filter((value): value is number => typeof value === "number") : [];
        const hostTiming = { preflightMs: typeof batch.preflightMs === "number" ? batch.preflightMs : null, applyMs: opMs.reduce((sum, value) => sum + value, 0) };
        operations.forEach((entry, i) => { if (full && opMs[i] !== undefined) (entry as Record<string, unknown>).hostMs = opMs[i]; });
        const undo = { grouped: false, undoSteps, note: "Premiere's ExtendScript cannot group edits into one undo step. undoSteps counts QE undo entries only; DOM writes such as volume, scale and markers often record none." };
        const failedIndex = typeof batch.failedIndex === "number" ? batch.failedIndex : -1;

        if (failedIndex < 0 && reply.success) {
          const allVerified = statuses.every(status => status === "verified");
          return {
            success: true,
            data: {
              outcome: allVerified ? "verified" : "committed_unverified",
              verified: allVerified,
              opsApplied: ops.length,
              timelineChanged: true,
              undo,
              hostTiming,
              operations,
            },
          };
        }

        const applied = operations.slice(0, failedIndex).map(entry => entry.index);
        const failedStatus = statuses[failedIndex];
        if (failedIndex === 0 && failedStatus === "not_applied" && (undoSteps === null || undoSteps === 0)) {
          return {
            success: false,
            error: `apply_batch stopped at operation 0 (${ops[0].op}), which refused before changing anything: ${results[0].error ?? "refused"}. Nothing was changed.`,
            data: { outcome: "not_applied", mutationOutcome: "not_applied", timelineChanged: false, refusedBeforeChange: true, opsApplied: 0, undo, hostTiming, operations },
          };
        }
        return {
          success: false,
          error: `apply_batch stopped at operation ${failedIndex} (${ops[failedIndex]?.op}): ${(results[failedIndex]?.error ?? "failed").replace(/\.+$/, "")}. ` +
            `${applied.length} earlier operation(s) were applied and remain in the timeline; the later ${ops.length - failedIndex - 1} did not run. Inspect the timeline, then acknowledge the recovery lock before the next edit.`,
          data: {
            outcome: "partial",
            mutationOutcome: "unknown",
            recoveryRequired: true,
            timelineChanged: applied.length > 0 || failedStatus === "failed" ? true : null,
            opsApplied: applied.length,
            appliedOperations: applied,
            failedOperation: failedIndex,
            partialSteps: operations.slice(0, failedIndex + 1),
            undo,
            hostTiming,
            operations,
          },
        };
      },
    },
  };
}
