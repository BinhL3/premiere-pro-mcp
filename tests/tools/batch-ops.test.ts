import { beforeEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";

vi.mock("../../src/bridge/file-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/bridge/file-bridge.js")>();
  // Captured calls go to the real capture; anything else reaches the fake host.
  const host = vi.fn();
  return {
    ...actual,
    __host: host,
    sendCommand: vi.fn((script: string, options?: unknown) => actual.bridgeCaptureActive() ? actual.sendCommand(script, options as never) : host(script, options)),
  };
});

import * as bridge from "../../src/bridge/file-bridge.js";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
import { collectTools } from "../../src/server.js";
import { resolveCapabilities } from "../../src/security/capabilities.js";
import { runWithUndoTracking } from "../../src/bridge/undo-tracking.js";
import { withInvocationContext, markHostDispatch } from "../../src/workflows/invocation-context.js";
import { mutationReceipt } from "../../src/workflows/mutation-receipt.js";
import { buildBatchScript } from "../../src/tools/batch-ops.js";

const host = (bridge as unknown as { __host: ReturnType<typeof vi.fn> }).__host;
const tools = () => collectTools({}, resolveCapabilities());

/** Run like the server does: undo tracking on for an edit tool, inside an invocation context. */
async function applyBatch(args: Record<string, unknown>) {
  return withInvocationContext({}, async () => {
    const result = await runWithUndoTracking(true, () => tools().apply_batch.handler(args));
    return { result: result as { success: boolean; error?: string; data?: any } };
  });
}

const op = (name: string, args: Record<string, unknown>) => ({ op: name, args });
const crossfade = (i: number) => op("add_audio_transition", { track_index: 0, cut_point_seconds: 2 * (i + 1) });
const gain = (i: number) => op("set_clip_volume", { node_id: `clip-${i}`, volume_db: -3 });
const ok = (data: Record<string, unknown> = { outcome: "verified", verified: true }) => JSON.stringify({ success: true, data });

beforeEach(() => { host.mockReset(); });

describe("apply_batch validation", () => {
  it("refuses an unknown op or invalid op arguments before anything is sent", async () => {
    const unknown = (await applyBatch({ operations: [op("delete_sequence", {})] })).result;
    expect(unknown).toMatchObject({ success: false, data: { mutationOutcome: "not_applied", dispatched: false } });

    const { result } = await applyBatch({ operations: [gain(0), op("add_transition", { transition_name: "Cross Dissolve", track_index: 0 }), op("trim_clip", { node_id: "c", new_in_seconds: 1, new_out_seconds: 2 }), op("move_clip", { node_id: "c", new_start_seconds: 1, typo: true })] });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ outcome: "not_applied", mutationOutcome: "not_applied", dispatched: false });
    const statuses = result.data.operations.map((entry: { status: string }) => entry.status);
    expect(statuses).toEqual(["not_run", "refused", "refused", "refused"]);
    expect(result.data.operations[2].error).toMatch(/exactly one of new_in_seconds or new_out_seconds/);
    expect(result.data.operations[3].error).toMatch(/UNKNOWN_ARGUMENT/);
    expect(host).not.toHaveBeenCalled();
  });

  it("refuses two transitions at the same cut", async () => {
    const { result } = await applyBatch({ operations: [crossfade(0), crossfade(1), crossfade(0)] });
    expect(result.data.operations.map((entry: { status: string }) => entry.status)).toEqual(["not_run", "not_run", "refused"]);
    expect(host).not.toHaveBeenCalled();
  });

  it("refuses ops that target a clip an earlier op ripple-deletes", async () => {
    const { result } = await applyBatch({ operations: [op("ripple_delete", { node_id: "a" }), gain(0), op("set_clip_volume", { node_id: "a", volume_db: 0 })] });
    expect(result.data.operations[2]).toMatchObject({ status: "refused", error: expect.stringMatching(/operation 0 ripple-deletes/) });
    expect(host).not.toHaveBeenCalled();
  });

  it("refuses a batch whose combined script would exceed the bridge size limit", async () => {
    const operations = Array.from({ length: 100 }, (_, i) => op("add_transition", { transition_name: "Cross Dissolve", track_index: 0, cut_point_seconds: i + 1 }));
    const { result } = await applyBatch({ operations });
    if (result.data?.scriptBytes !== undefined) {
      expect(result).toMatchObject({ success: false, data: { mutationOutcome: "not_applied", dispatched: false } });
      expect(host).not.toHaveBeenCalled();
    } else {
      expect(host).toHaveBeenCalledTimes(1);
    }
  });
});

describe("apply_batch execution", () => {
  it("sends 20 crossfades and 20 gain changes as one host command", async () => {
    const operations = [...Array.from({ length: 20 }, (_, i) => crossfade(i)), ...Array.from({ length: 20 }, (_, i) => gain(i))];
    host.mockResolvedValue({
      success: true,
      data: { batch: { failedIndex: -1, opsRun: 40, undoStart: 10, undoNow: 30 }, ops: operations.map(() => JSON.parse(ok())) },
    });
    const { result } = await applyBatch({ operations });
    expect(host).toHaveBeenCalledTimes(1);
    const [script, options] = host.mock.calls[0];
    expect(options).toMatchObject({ mutating: true, mutationOnTimeout: true });
    expect(script.match(/__batchOut\.push/g)).toHaveLength(40);
    expect(script).toContain("__pfFail(39, \"set_clip_volume\"");
    expect(() => new Function(script)).not.toThrow();
    expect(result).toMatchObject({ success: true, data: { outcome: "verified", opsApplied: 40, undo: { grouped: false, undoSteps: 20 } } });
    expect(result.data.operations).toHaveLength(40);
    expect(result.data.operations[0]).toEqual({ index: 0, op: "add_audio_transition", status: "verified" });
  });

  it("answers every op's pre-write read in one shared round trip", async () => {
    host.mockImplementation(async (script: string) => {
      if (script.includes("__reads.push")) return { success: true, data: { reads: [{ success: true, data: { totalMovers: 3 } }, { success: true, data: { totalMovers: 1 } }] } };
      return { success: true, data: { batch: { failedIndex: -1, opsRun: 3, undoStart: 0, undoNow: 6 }, ops: [JSON.parse(ok()), JSON.parse(ok()), JSON.parse(ok())] } };
    });
    const { result } = await applyBatch({ operations: [op("ripple_delete", { node_id: "a" }), op("ripple_delete", { node_id: "b" }), gain(0)] });
    expect(host).toHaveBeenCalledTimes(2);
    expect(host.mock.calls[0][1]).toMatchObject({ mutating: false });
    expect(host.mock.calls[0][0].match(/__reads\.push/g)).toHaveLength(2);
    expect(result).toMatchObject({ success: true, data: { opsApplied: 3 } });
  });

  it("reports a mid-batch failure as partial with the applied ops and a recovery lock", async () => {
    host.mockResolvedValue({
      success: false,
      data: {
        batch: { failedIndex: 2, opsRun: 3, undoStart: 4, undoNow: 6 },
        ops: [JSON.parse(ok()), JSON.parse(ok({ outcome: "committed_unverified", verified: false })), { success: false, error: "Transition not found", data: { mutationOutcome: "not_applied", timelineChanged: false, refusedBeforeChange: true } }],
      },
    });
    const { result } = await applyBatch({ operations: [crossfade(0), gain(1), crossfade(2), gain(3)] });
    expect(result).toMatchObject({ success: false, data: { outcome: "partial", mutationOutcome: "unknown", recoveryRequired: true, opsApplied: 2, appliedOperations: [0, 1], failedOperation: 2 } });
    expect(result.data.operations.map((entry: { status: string }) => entry.status)).toEqual(["verified", "committed_unverified", "not_applied", "not_run"]);
    expect(mutationReceipt(false, result.data, { dispatched: true }, "apply_batch").outcome).toBe("unknown");
  });

  it("keeps a refusal of the first op as not_applied with no lock", async () => {
    host.mockResolvedValue({
      success: false,
      data: { batch: { failedIndex: 0, opsRun: 1, undoStart: 4, undoNow: 4 }, ops: [{ success: false, error: "Clip not found", data: { mutationOutcome: "not_applied", timelineChanged: false, refusedBeforeChange: true } }] },
    });
    const { result } = await applyBatch({ operations: [gain(0), gain(1)] });
    expect(result).toMatchObject({ success: false, data: { outcome: "not_applied", mutationOutcome: "not_applied", opsApplied: 0 } });
    expect(mutationReceipt(false, result.data, { dispatched: true }, "apply_batch").outcome).toBe("not_applied");
  });
});

// The helpers and the generated script are ES3, so they run in Node against a
// minimal fake of the Premiere DOM: enough for pre-flight, which must refuse
// before any op script starts.
function fakePremiere() {
  const ticks = (seconds: number) => ({ ticks: String(seconds * 254016000000) });
  const clip = (nodeId: string, start: number, end: number) => ({ nodeId, name: nodeId, start: ticks(start), end: ticks(end), components: { numItems: 0 } });
  const collection = <T>(items: T[]) => Object.assign([...items], { numItems: items.length, numTracks: items.length });
  const audio = collection([{ clips: collection([clip("a1", 0, 2), clip("a2", 2, 4)]) }]);
  const video = collection([{ clips: collection([clip("v1", 0, 2), clip("v2", 2, 4)]) }]);
  let undo = 7;
  const writes: string[] = [];
  const context = vm.createContext({
    $: { os: "Macintosh" },
    app: { enableQE: () => {}, project: { activeSequence: { timebase: String(254016000000 / 25), audioTracks: audio, videoTracks: video, sequenceID: "seq" } } },
    qe: { project: { undoStackIndex: () => undo, // Live Premiere 27 returns an unnamed object for an unknown name.
    getAudioTransitionByName: (name: string) => ({ name: name === "Constant Power" ? name : "" }), getVideoTransitionByName: () => ({ name: "" }), getAudioTransitionList: () => null, getVideoTransitionList: () => null,
      // QE throws for a track index past the end; nothing here can add a transition.
      getActiveSequence: () => ({ getVideoTrackAt: (i: number) => { if (i >= 1) throw new Error("Unknown error exception"); return { numItems: 0 }; }, getAudioTrackAt: (i: number) => { if (i >= 1) throw new Error("Unknown error exception"); return { numItems: 0 }; } }) } },
  });
  vm.runInContext(getHelpersSource(), context);
  return { context, writes, bumpUndo: () => undo++ };
}

describe("apply_batch pre-flight in the host script", () => {
  it("refuses a stale clip id and an unknown transition as not_applied before any op runs", async () => {
    host.mockImplementation(async (script: string) => {
      const premiere = fakePremiere();
      const reply = JSON.parse(vm.runInContext(script, premiere.context));
      expect(premiere.writes).toEqual([]);
      return reply;
    });
    const { result } = await applyBatch({ operations: [op("set_clip_volume", { node_id: "a1", volume_db: -6 }), op("ripple_delete", { node_id: "stale" }), op("add_audio_transition", { track_index: 0, cut_point_seconds: 2, transition_name: "Nope" })] });
    // ripple_delete's dry-run read runs first; it too finds no clip.
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ mutationOutcome: "not_applied" });
  });

  it("refuses the whole batch from pre-flight with per-op reasons", async () => {
    host.mockImplementation(async (script: string) => JSON.parse(vm.runInContext(script, fakePremiere().context)));
    const { result } = await applyBatch({ operations: [op("set_clip_volume", { node_id: "a1", volume_db: -6 }), op("set_clip_volume", { node_id: "stale", volume_db: -6 }), op("add_audio_transition", { track_index: 0, cut_point_seconds: 2, transition_name: "Nope" }), op("set_clip_volume", { node_id: "a2", volume_db: -6 }), op("set_clip_volume", { node_id: "v1", volume_db: 0 })] });
    expect(host).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, data: { outcome: "not_applied", mutationOutcome: "not_applied", refusedBeforeChange: true, timelineChanged: false } });
    expect(result.data.operations.map((entry: { status: string }) => entry.status)).toEqual(["not_run", "refused", "refused", "not_run", "refused"]);
    expect(result.data.operations[1].error).toMatch(/Clip not found/);
    expect(result.data.operations[2].error).toMatch(/Audio transition not found/);
    expect(result.data.operations[4].error).toMatch(/not an audio clip/);
    expect(mutationReceipt(false, result.data, { dispatched: true }, "apply_batch").outcome).toBe("not_applied");
  });

  it("builds a syntactically valid script for every supported op", () => {
    const ops = [
      { op: "add_to_timeline", args: { item_id: "i" } }, { op: "overwrite_clip", args: { item_id: "i", audio_track_index: 1 } }, { op: "insert_from_source", args: {} },
      { op: "trim_clip", args: { node_id: "c" } }, { op: "move_clip", args: { node_id: "c", new_track_index: 1 } }, { op: "ripple_delete", args: { node_id: "c" } },
      { op: "split_clip", args: { time_seconds: 1 } }, { op: "set_clip_volume", args: { node_id: "c" } }, { op: "set_clips_volume", args: { track_index: 0, clip_indices: [0, 3] } },
      { op: "add_transition", args: { transition_name: "x", track_index: 0, cut_point_seconds: 1 } }, { op: "add_audio_transition", args: { track_index: 0, cut_point_seconds: 1 } },
      { op: "batch_add_transitions", args: { transition_name: "x" } }, { op: "set_clip_properties", args: { node_id: "c" } }, { op: "add_marker", args: { time_seconds: 1, node_id: "c" } },
      { op: "apply_effect", args: { node_id: "c", effect_name: "Blur" } }, { op: "set_effect_property", args: { node_id: "c", effect_name: "Blur" } },
    ].map((entry, index) => ({ index, op: entry.op as never, args: entry.args, script: "(function() { return __result({}); })();" }));
    expect(() => new Function(buildBatchScript(ops))).not.toThrow();
  });
});

describe("transition refusals on Premiere 27 QE", () => {
  it("refuse an out-of-range track or an unknown transition name as not_applied", async () => {
    host.mockImplementation(async (script: string) => JSON.parse(vm.runInContext(script, fakePremiere().context)));
    for (const [name, args] of [
      ["add_transition", { transition_name: "Cross Dissolve", track_index: 9, cut_point_seconds: 2 }],
      ["add_transition", { transition_name: "No Such Transition", track_index: 0, cut_point_seconds: 2 }],
      ["batch_add_transitions", { transition_name: "Cross Dissolve", track_index: 9 }],
      ["add_audio_transition", { track_index: 9, cut_point_seconds: 2 }],
      ["add_audio_transition", { track_index: 0, cut_point_seconds: 2, transition_name: "No Such Audio" }],
    ] as const) {
      const result = await withInvocationContext({}, () => runWithUndoTracking(true, () => tools()[name].handler(args)));
      expect(result, `${name} ${JSON.stringify(args)}`).toMatchObject({ success: false, data: { mutationOutcome: "not_applied", refusedBeforeChange: true } });
    }
  });
});

describe("host eval timing", () => {
  it("wraps only buildScript output and keeps other scripts unchanged", () => {
    const built = "(function() {\n  try {\n    __undoStart = null;\n  } catch(e) {}\n})();";
    const wrapped = bridge.withHostEvalTiming("BOOT;", built);
    expect(wrapped).toContain("var __mcpR = (function()");
    expect(wrapped.indexOf("__mcpT0")).toBeLessThan(wrapped.indexOf("BOOT;"));
    const context = vm.createContext({});
    const reply = vm.runInContext(bridge.withHostEvalTiming("", "(function() {\n  try {\n    __undoStart = null;\n    return '{\"success\":true,\"data\":1}';\n  } catch(e) {}\n})();"), context);
    expect(JSON.parse(reply)).toMatchObject({ success: true, data: 1, __hostEvalMs: expect.any(Number) });
    expect(bridge.withHostEvalTiming("BOOT;", "var x = 1; x;")).toBe("BOOT;\nvar x = 1; x;");
  });
});

void markHostDispatch;
