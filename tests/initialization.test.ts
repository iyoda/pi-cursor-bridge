import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompletion, type BridgeAgent } from "../src/bridge.js";

const fs = vi.hoisted(() => ({ mkdtemp: vi.fn(), rm: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdtemp: fs.mkdtemp,
  rm: fs.rm,
}));

beforeEach(() => {
  vi.useFakeTimers();
  fs.mkdtemp.mockReset().mockResolvedValue("/virtual/private-workspace");
  fs.rm.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

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
        { createAgent },
      );
      const rejected = expect(pending).rejects.toThrow(/cancelled|timed out/);
      if (mode === "abort") controller.abort(new Error("cancelled"));
      else await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(createAgent).not.toHaveBeenCalled();
      expect(fs.rm).not.toHaveBeenCalled();
      release("/virtual/late-workspace");
      await vi.advanceTimersByTimeAsync(0);
      expect(fs.rm).toHaveBeenCalledWith("/virtual/late-workspace", {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
      expect(createAgent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
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
      { createAgent },
    );
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    reject(new Error("late filesystem failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(createAgent).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });
  it("clears the deadline when workspace acquisition fails", async () => {
    fs.mkdtemp.mockRejectedValue(new Error("ENOSPC"));
    const createAgent = vi.fn<() => Promise<BridgeAgent>>();
    await expect(runCompletion(request, { createAgent })).rejects.toThrow(
      "ENOSPC",
    );
    expect(createAgent).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline and removes the workspace when schema conversion fails", async () => {
    const parameters: Record<string, unknown> = { type: "object" };
    parameters.circular = parameters;
    const createAgent = vi.fn<() => Promise<BridgeAgent>>();
    await expect(
      runCompletion(
        {
          ...request,
          tools: [{ name: "read", description: "read", parameters }],
        },
        { createAgent },
      ),
    ).rejects.toThrow(/circular/i);
    expect(createAgent).not.toHaveBeenCalled();
    expect(fs.rm).toHaveBeenCalledWith("/virtual/private-workspace", {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
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
      { createAgent },
    );
    const rejected = expect(pending).rejects.toThrow(/circular/i);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fs.rm).toHaveBeenCalledTimes(2);
    expect(createAgent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
