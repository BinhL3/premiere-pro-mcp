import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Closing the last project unloads Premiere's visible panel mid-command, so
// close commands are named *.headless.jsx and left to the surviving headless engine.
const source = readFileSync(new URL("../../cep-plugin/main.js", import.meta.url), "utf8");
const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const routing = between("function headlessEngineIsLive(", "function readFile(");
const heartbeat = between("function writeBridgeHeartbeat(", "function startBridgeHeartbeat(");
const identity = between("var IS_HEADLESS_ENGINE = false;", "// ---- Logging ----");
const COMMANDS = ["cmd_a.jsx", "cmd_b.headless.jsx", "cmd_c.jsx.staged", "res_a.json"];

function engine({ headless, engineFileAgeMs }: { headless: boolean; engineFileAgeMs?: number }) {
  const writes: string[] = [];
  const now = 1_000_000;
  const state: Record<string, unknown> = {
    tempDir: "/tmp/cep-routing", ENGINE_ID: "unit", bridgeRunning: true, HEARTBEAT_MS: 1000,
    window: { __adobe_cep__: { getExtensionId: () => headless ? "com.mcp.premiere.bridge.headless" : "com.mcp.premiere.bridge.panel" } },
    path: { join: (...parts: string[]) => parts.join("/") },
    Date: class { getTime() { return now; } },
    deleteFile() {},
    fs: {
      existsSync: () => true,
      readdirSync: () => COMMANDS,
      statSync: (file: string) => {
        if (!file.endsWith("headless-engine.json") || engineFileAgeMs === undefined) throw Error("ENOENT");
        return { mtime: { getTime: () => now - engineFileAgeMs } };
      },
      openSync: (file: string) => { writes.push(file); return 3; },
      writeFileSync: () => {},
      closeSync: () => {},
      renameSync: (_from: string, to: string) => writes.push(`renamed:${to}`),
    },
  };
  runInNewContext(`${identity}\n${routing}\n${heartbeat}`, state);
  return { run: (code: string) => runInNewContext(code, state), writes };
}

describe("CEP headless command routing", () => {
  it("identifies the headless engine from its extension ID", () => {
    expect(engine({ headless: true }).run("IS_HEADLESS_ENGINE")).toBe(true);
    expect(engine({ headless: false }).run("IS_HEADLESS_ENGINE")).toBe(false);
  });

  it("leaves headless-routed commands to a live headless engine", () => {
    expect(engine({ headless: false, engineFileAgeMs: 500 }).run("listCommandFiles()")).toEqual(["cmd_a.jsx"]);
  });

  it("runs headless-routed commands itself when no headless engine is live", () => {
    expect(engine({ headless: false }).run("listCommandFiles()")).toEqual(["cmd_a.jsx", "cmd_b.headless.jsx"]);
    expect(engine({ headless: false, engineFileAgeMs: 10_000 }).run("listCommandFiles()")).toEqual(["cmd_a.jsx", "cmd_b.headless.jsx"]);
  });

  it("lets the headless engine take every command", () => {
    expect(engine({ headless: true, engineFileAgeMs: 500 }).run("listCommandFiles()")).toEqual(["cmd_a.jsx", "cmd_b.headless.jsx"]);
  });

  it("advertises only a running headless engine", () => {
    const headless = engine({ headless: true });
    headless.run("writeBridgeHeartbeat()");
    expect(headless.writes).toContain("renamed:/tmp/cep-routing/headless-engine.json");
    const visible = engine({ headless: false });
    visible.run("writeBridgeHeartbeat()");
    expect(visible.writes.some((file) => file.includes("headless-engine"))).toBe(false);
    const stopped = engine({ headless: true });
    stopped.run("bridgeRunning = false; writeBridgeHeartbeat()");
    expect(stopped.writes.some((file) => file.includes("headless-engine"))).toBe(false);
  });
});

describe("CEP command watcher", () => {
  const watcher = between("var commandWatcher = null;", "function stopBridge(");
  function panel(watch: (dir: string, options: unknown, listener: (event: string, name: string | null) => void) => unknown) {
    const processed: number[] = [];
    const state: Record<string, unknown> = { tempDir: "/tmp/cep-watch", bridgeRunning: true, processCommands: () => processed.push(1), fs: { watch } };
    runInNewContext(watcher, state);
    return { run: (code: string) => runInNewContext(code, state), processed };
  }

  it("processes commands as soon as a cmd_*.jsx file appears, ignoring other files", () => {
    let listener: ((event: string, name: string | null) => void) | undefined;
    let closed = 0;
    const handle = { on() {}, close: () => { closed++; } };
    const p = panel((_dir, _options, callback) => { listener = callback; return handle; });
    p.run("startCommandWatcher()");
    listener!("rename", "cmd_x.jsx.staged");
    listener!("rename", "res_x.json");
    expect(p.processed).toHaveLength(0);
    listener!("rename", "cmd_x.jsx");
    listener!("rename", null);
    expect(p.processed).toHaveLength(2);
    p.run("bridgeRunning = false");
    listener!("rename", "cmd_y.jsx");
    expect(p.processed).toHaveLength(2);
    p.run("stopCommandWatcher()");
    expect(closed).toBe(1);
  });

  it("falls back to polling when the directory cannot be watched", () => {
    const p = panel(() => { throw new Error("ENOSYS"); });
    expect(() => p.run("startCommandWatcher()")).not.toThrow();
    expect(p.run("commandWatcher")).toBeNull();
  });
});
