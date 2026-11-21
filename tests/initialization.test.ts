import { setImmediate as realSetImmediate } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runCompletion,
  type BridgeAgent,
  type CompletionDependencies,
  type WorkspaceRemovalHooks,
} from "../src/bridge.js";

const fs = vi.hoisted(() => ({
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdtemp: fs.mkdtemp,
  rm: fs.rm,
  stat: fs.stat,
}));

const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
const removalOptions = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 20,
};

function testRemoval(): WorkspaceRemovalHooks {
  return {
    schedule(callback, ms) {
      return setTimeout(callback, ms);
    },
    remove(path) {
      return fs.rm(path, removalOptions);
    },
  };
}

function deps(
  createAgent: CompletionDependencies["createAgent"],
): CompletionDependencies {
  return { createAgent, workspaceRemoval: testRemoval() };
}

async function drainRemoval(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise<void>((resolve) => {
      realSetImmediate(resolve);
    });
  }
}

let previousDataDir: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  previousDataDir = process.env.CURSOR_DATA_DIR;
  process.env.CURSOR_DATA_DIR = "/virtual/cursor-data";
  fs.mkdtemp.mockReset().mockResolvedValue("/virtual/private-workspace");
  fs.rm.mockReset().mockResolvedValue(undefined);
  fs.stat.mockReset().mockRejectedValue(missing());
});
afterEach(async () => {
  // Existence checks use the setImmediate captured at import. Drain those
  // turns before advancing the injected sweep clock.
  await drainRemoval();
  await vi.advanceTimersByTimeAsync(1_000);
  vi.useRealTimers();
  if (previousDataDir === undefined) delete process.env.CURSOR_DATA_DIR;
  else process.env.CURSOR_DATA_DIR = previousDataDir;
});

const request = {
  apiKey: "test-key",
  model: { id: "auto" },
  prompt: "hello",
  tools: [],
};

describe("completion initialization cleanup", () => {
  it.each(["abort", "deadline"])(
    "interrupts workspace acquisition on %s and removes a late workspace",
    async (mode) => {
      let release!: (path: string) => void;
      fs.mkdtemp.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      );
      const controller = new AbortController();
      const createAgent = vi.fn<() => Promise<BridgeAgent>>();
      const pending = runCompletion(
        { ...request, timeoutMs: 20, signal: controller.signal },
        deps(createAgent),
      );
      const rejected = expect(pending).rejects.toThrow(/cancelled|timed out/);
      if (mode === "abort") controller.abort(new Error("cancelled"));
      else await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(createAgent).not.toHaveBeenCalled();
      expect(fs.rm).not.toHaveBeenCalled();
      release("/virtual/late-workspace");
      await drainRemoval();
      expect(fs.rm).toHaveBeenNthCalledWith(
        1,
        "/virtual/late-workspace",
        removalOptions,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fs.rm.mock.calls.map(([path]) => path)).toEqual(
        Array(4).fill("/virtual/late-workspace"),
      );
    },
  );

  it("observes a workspace acquisition rejection after abort", async () => {
    let reject!: (error: Error) => void;
    fs.mkdtemp.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const controller = new AbortController();
    const createAgent = vi.fn<() => Promise<BridgeAgent>>();
    const pending = runCompletion(
      { ...request, signal: controller.signal },
      deps(createAgent),
    );
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    reject(new Error("late filesystem failure"));
    await drainRemoval();
    expect(createAgent).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline when workspace acquisition fails", async () => {
    fs.mkdtemp.mockRejectedValue(new Error("ENOSPC"));
    const createAgent = vi.fn<() => Promise<BridgeAgent>>();
    await expect(runCompletion(request, deps(createAgent))).rejects.toThrow(
      "ENOSPC",
    );
    expect(createAgent).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes a recreated workspace on the later sweep clock", async () => {
    const parameters: Record<string, unknown> = { type: "object" };
    parameters.circular = parameters;
    const createAgent = vi.fn<() => Promise<BridgeAgent>>();
    await expect(
      runCompletion(
        {
          ...request,
          tools: [{ name: "read", description: "read", parameters }],
        },
        deps(createAgent),
      ),
    ).rejects.toThrow(/circular/i);
    expect(createAgent).not.toHaveBeenCalled();
    expect(fs.rm).toHaveBeenNthCalledWith(
      1,
      "/virtual/private-workspace",
      removalOptions,
    );
    expect(fs.rm).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(3);
    await vi.advanceTimersByTimeAsync(29);
    expect(fs.rm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fs.rm).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(170);
    expect(fs.rm).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(800);
    expect(fs.rm).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries workspace removal while the SDK store still holds state", async () => {
    const busy = Object.assign(
      new Error(
        "ENOTEMPTY: directory not empty, rmdir '/virtual/private-workspace/state'",
      ),
      { code: "ENOTEMPTY" },
    );
    fs.rm.mockRejectedValueOnce(busy);
    const parameters: Record<string, unknown> = { type: "object" };
    parameters.circular = parameters;
    const createAgent = vi.fn<() => Promise<BridgeAgent>>();
    const pending = runCompletion(
      {
        ...request,
        tools: [{ name: "read", description: "read", parameters }],
      },
      deps(createAgent),
    );
    // Retries wait on the setTimeout captured at import, not the fake clock.
    // The busy workspace is removed on the second try.
    await expect(pending).rejects.toThrow(/circular/i);
    expect(fs.rm).toHaveBeenNthCalledWith(
      1,
      "/virtual/private-workspace",
      removalOptions,
    );
    expect(fs.rm).toHaveBeenNthCalledWith(
      2,
      "/virtual/private-workspace",
      removalOptions,
    );
    expect(fs.rm).toHaveBeenCalledTimes(2);
    expect(createAgent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(3);
  });

  it("removes a workspace the SDK store recreates after rm returns", async () => {
    let seen = 0;
    fs.stat.mockImplementation(async (path: string) => {
      if (path === "/virtual/private-workspace" && seen === 0) {
        seen += 1;
        return {};
      }
      throw missing();
    });
    const parameters: Record<string, unknown> = { type: "object" };
    parameters.circular = parameters;
    const createAgent = vi.fn<() => Promise<BridgeAgent>>();
    await expect(
      runCompletion(
        {
          ...request,
          tools: [{ name: "read", description: "read", parameters }],
        },
        deps(createAgent),
      ),
    ).rejects.toThrow(/circular/i);
    expect(fs.rm).toHaveBeenNthCalledWith(
      1,
      "/virtual/private-workspace",
      removalOptions,
    );
    expect(fs.rm).toHaveBeenNthCalledWith(
      2,
      "/virtual/private-workspace",
      removalOptions,
    );
    expect(fs.rm).toHaveBeenCalledTimes(2);
    expect(createAgent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(3);
  });
});
