import { runInNewContext } from "node:vm";
import { parse } from "acorn";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
import { runWithUndoTracking } from "../../src/bridge/undo-tracking.js";
import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getTimelineTools } from "../../src/tools/timeline.js";
import { mutationReceipt } from "../../src/workflows/mutation-receipt.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({ sendCommand: vi.fn() }));

const T = 254016000000;
const FRAME = T / 25;
const collection = <V>(items: V[]) => Object.defineProperty(items, "numItems", { get: () => items.length }) as V[] & { numItems: number };

type Clip = ReturnType<typeof clip>;
function clip(nodeId: string, initialStart: number, initialEnd: number) {
  let start = initialStart, end = initialEnd;
  const item = {
    nodeId, name: nodeId, writes: [] as string[],
    inPoint: { ticks: String(T) }, outPoint: { ticks: String(3 * T) },
    getLinkedItems: (): unknown => null,
    /** Lets a test make Premiere move a partner itself when the target is written. */
    afterWrite: () => {},
    get start() { return { ticks: String(start) }; },
    set start(value: unknown) { item.writes.push("start"); start = Number(value); item.afterWrite(); },
    get end() { return { ticks: String(end) }; },
    set end(value: unknown) { item.writes.push("end"); end = Number(value); },
    shift(delta: number) { start += delta; end += delta; },
  };
  return item;
}

/** V1 holds the video, A1 its linked audio, which starts 123 ticks (a sub-frame) earlier. */
function host() {
  const video = clip("v", 2 * T, 4 * T);
  const audio = clip("a", 2 * T - 123, 4 * T - 123);
  const group = collection([video, audio]);
  video.getLinkedItems = () => group;
  audio.getLinkedItems = () => group;
  const track = (items: Clip[]) => ({ clips: collection(items), transitions: collection([]), isLocked: () => false });
  const v1 = track([video]), a1 = track([audio]);
  const videoTracks: Record<string | number, unknown> = { 0: v1, 1: track([]), numTracks: 2 };
  const sequence = { sequenceID: "seq", timebase: String(FRAME), videoTracks, audioTracks: { 0: a1, numTracks: 1 } };
  const context = { app: { enableQE: () => {}, project: { activeSequence: sequence } }, qe: { project: { undoStackIndex: () => 4, getActiveSequence: () => null } } };
  vi.mocked(sendCommand).mockImplementation(async (script: string) => {
    parse(script, { ecmaVersion: 3, allowReserved: "never" });
    return JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, context)));
  });
  return { video, audio, v1, a1 };
}

type Result = { success: boolean; error?: string; data?: Record<string, unknown> };
const move = (args: { node_id?: string; new_start_seconds?: number; new_track_index?: number; include_linked?: boolean } = {}) =>
  runWithUndoTracking(true, () => getTimelineTools({}).move_clip.handler({ node_id: "v", new_start_seconds: 8, ...args })) as Promise<Result>;
const range = (item: Clip) => [Number(item.start.ticks), Number(item.end.ticks), item.inPoint.ticks, item.outPoint.ticks];

beforeEach(() => vi.clearAllMocks());

describe("move_clip moves linked partners", () => {
  it("moves the linked audio by the same displacement, keeping its sub-frame offset and source range", async () => {
    const { video, audio } = host();
    const result = await move();
    expect(result).toMatchObject({ success: true, data: { verified: true, linkedPartnersMoved: [{ nodeId: "a", track: "A1" }] } });
    expect(range(video)).toEqual([8 * T, 10 * T, String(T), String(3 * T)]);
    expect(range(audio)).toEqual([8 * T - 123, 10 * T - 123, String(T), String(3 * T)]);
  });

  it("moves from an audio anchor that starts between frames instead of refusing it as off-grid", async () => {
    const { video, audio } = host();
    await expect(move({ node_id: "a" })).resolves.toMatchObject({ success: true, data: { verified: true } });
    expect(Number(audio.start.ticks)).toBe(8 * T - 123);
    expect(Number(video.start.ticks)).toBe(8 * T);
  });

  it("does not write a partner Premiere already moved with the target", async () => {
    const { video, audio } = host();
    let shifted = false;
    video.afterWrite = () => { if (!shifted) { shifted = true; audio.shift(6 * T); } };
    await expect(move()).resolves.toMatchObject({ success: true, data: { verified: true } });
    expect(audio.writes).toEqual([]);
    expect(Number(audio.start.ticks)).toBe(8 * T - 123);
  });

  it("include_linked:false moves only the target", async () => {
    const { video, audio } = host();
    await expect(move({ include_linked: false })).resolves.toMatchObject({ success: true, data: { linkedPartnersMoved: [] } });
    expect(Number(video.start.ticks)).toBe(8 * T);
    expect(Number(audio.start.ticks)).toBe(2 * T - 123);
  });

  it("reports committed_unverified when Premiere moves the partner somewhere else", async () => {
    const { video, audio } = host();
    video.afterWrite = () => { if (Number(audio.start.ticks) < 5 * T) audio.shift(T); };
    const result = await move();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("did not follow"), data: { timelineChanged: true, outcome: "committed_unverified" } });
    expect(mutationReceipt(false, result.data, { dispatched: true }, "move_clip").outcome).toBe("committed_unverified");
  });

  it.each(["occupied destination", "locked partner track", "partner transition", "linked track change"])("refuses a %s before any write, as not_applied", async (scenario) => {
    const { video, audio, a1 } = host();
    if (scenario === "occupied destination") a1.clips.push(clip("neighbour", 9 * T, 11 * T));
    if (scenario === "locked partner track") a1.isLocked = () => true;
    if (scenario === "partner transition") a1.transitions.push({ start: { ticks: String(2 * T - 1000) }, end: { ticks: String(2 * T) } } as never);
    const result = await move(scenario === "linked track change" ? { new_track_index: 1 } : {});
    expect(result).toMatchObject({ success: false, data: { mutationOutcome: "not_applied", timelineChanged: false } });
    expect(mutationReceipt(false, result.data, { dispatched: true }, "move_clip").outcome).toBe("not_applied");
    expect([...video.writes, ...audio.writes]).toEqual([]);
  });
});
