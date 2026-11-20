import { access, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOptions, SDKAgent } from "@cursor/sdk";
import {
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { formatFailure, markRetryableTransportFailure } from "../src/async.js";
import {
  runCompletion,
  type BridgeAgent,
  type BridgeRun,
  type CompletionRequest,
} from "../src/bridge.js";

const request: CompletionRequest = {
  apiKey: "test-key",
  model: { id: "test-model" },
  prompt: "hello",
  tools: [],
};
const usage = {
  inputTokens: 10,
  outputTokens: 4,
  cacheReadTokens: 2,
  cacheWriteTokens: 0,
  totalTokens: 14,
};
const workspaces = new Set<string>();
afterEach(async () => {
  await Promise.all(
    [...workspaces].map((path) => rm(path, { recursive: true, force: true })),
  );
  workspaces.clear();
});
function harness() {
  let options: AgentOptions | undefined;
  let status: BridgeRun["status"] = "running";
  const run: BridgeRun = {
    wait: vi.fn<BridgeRun["wait"]>(async () => ({
      id: "run-1",
      status: "finished",
      result: "hello",
      usage,
    })),
    cancel: vi.fn(async () => {
      status = "cancelled";
    }),
    get status() {
      return status;
    },
    usage,
    stream: vi.fn<BridgeRun["stream"]>(async function* () {}),
  };
  const dispose = vi.fn(async () => {});
  const send = vi.fn<BridgeAgent["send"]>(async (_message, opts) => {
    await opts?.onDelta?.({ update: { type: "text-delta", text: "hello" } });
    return run;
  });
  const createAgent = vi.fn(
    async (value: AgentOptions): Promise<BridgeAgent> => {
      options = value;
      if (value.local?.cwd) workspaces.add(value.local.cwd);
      return { send, [Symbol.asyncDispose]: dispose };
    },
  );
  return {
    createAgent,
    send,
    run,
    dispose,
    setStatus(next: BridgeRun["status"]) {
      status = next;
    },
    get options() {
      return options!;
    },
  };
}

function toolCallStarted(callId = "sdk-call") {
  return {
    type: "tool-call-started" as const,
    callId,
    modelCallId: `${callId}-model`,
    toolCall: { type: "shell" as const, args: { command: "true" } },
  };
}

describe("official SDK completion", () => {
  it("returns on abort during acquisition and disposes an agent that arrives late", async () => {
    const h = harness();
    const create = h.createAgent.getMockImplementation()!;
    let acquired!: () => void;
    const started = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let release!: (value: BridgeAgent) => void;
    h.createAgent.mockImplementation(async (options) => {
      const agent = await create(options);
      acquired();
      return new Promise<BridgeAgent>((resolve) => {
        release = () => resolve(agent);
      });
    });
    const controller = new AbortController();
    const pending = runCompletion({ ...request, signal: controller.signal }, h);
    const rejected = expect(pending).rejects.toThrow(/abort/);
    await started;
    controller.abort(new Error("user aborted"));
    await rejected;
    release({ send: h.send, [Symbol.asyncDispose]: h.dispose });
    await vi.waitFor(() => expect(h.dispose).toHaveBeenCalledTimes(1));
    expect(h.send).not.toHaveBeenCalled();
  });

  it("returns on abort during send and cancels a run that arrives late", async () => {
    const h = harness();
    let sending!: () => void;
    const started = new Promise<void>((resolve) => {
      sending = resolve;
    });
    let release!: (value: BridgeRun) => void;
    h.send.mockImplementation(() => {
      sending();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const controller = new AbortController();
    const pending = runCompletion({ ...request, signal: controller.signal }, h);
    const rejected = expect(pending).rejects.toThrow(/abort/);
    await started;
    controller.abort(new Error("user aborted"));
    await rejected;
    // The known owner must be closed even while send() is still unresolved.
    expect(h.dispose).toHaveBeenCalledTimes(1);
    release(h.run);
    await vi.waitFor(() => expect(h.run.cancel).toHaveBeenCalledTimes(1));
    expect(h.dispose).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () =>
      expect(
        await access(h.options.local!.cwd!).then(
          () => true,
          () => false,
        ),
      ).toBe(false),
    );
  });
  it.each(["create", "send"])(
    "observes a late %s rejection and removes the workspace",
    async (phase) => {
      const h = harness();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let reject!: (error: Error) => void;
      if (phase === "create") {
        const create = h.createAgent.getMockImplementation()!;
        h.createAgent.mockImplementation(async (options) => {
          await create(options);
          entered();
          return new Promise((_resolve, fail) => {
            reject = fail;
          });
        });
      } else {
        h.send.mockImplementation(() => {
          entered();
          return new Promise((_resolve, fail) => {
            reject = fail;
          });
        });
      }
      const controller = new AbortController();
      const pending = runCompletion(
        { ...request, signal: controller.signal },
        h,
      );
      const rejected = expect(pending).rejects.toThrow("cancelled");
      await started;
      controller.abort(new Error("cancelled"));
      await rejected;
      await expect(access(h.options.local!.cwd!)).resolves.toBeUndefined();
      reject(new Error("late failure"));
      await vi.waitFor(async () => {
        await expect(access(h.options.local!.cwd!)).rejects.toThrow();
      });
      expect(h.dispose).toHaveBeenCalledTimes(phase === "send" ? 1 : 0);
    },
  );
  it("does not acquire an SDK agent for a pre-aborted request", async () => {
    const h = harness();
    await expect(
      runCompletion(
        { ...request, signal: AbortSignal.abort(new Error("user aborted")) },
        h,
      ),
    ).rejects.toThrow(/abort/);
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it("cancels and disposes when aborted during inference", async () => {
    const h = harness();
    const controller = new AbortController();
    vi.mocked(h.run.wait).mockImplementation(() => {
      controller.abort(new Error("user aborted"));
      return new Promise(() => {});
    });
    await expect(
      runCompletion({ ...request, signal: controller.signal }, h),
    ).rejects.toThrow(/abort/);
    expect(h.run.cancel).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  it("bounds inference silence with a deadline", async () => {
    const h = harness();
    vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
    await expect(
      runCompletion({ ...request, timeoutMs: 20 }, h),
    ).rejects.toThrow(/timed out/i);
    expect(h.run.cancel).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  describe("idle timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function streaming(h: ReturnType<typeof harness>) {
      let onDelta: NonNullable<Parameters<BridgeAgent["send"]>[1]>["onDelta"];
      vi.mocked(h.send).mockImplementation(async (_message, opts) => {
        onDelta = opts?.onDelta;
        return h.run;
      });
      return async (steps: number) => {
        for (let i = 0; i < steps; i++) {
          await vi.advanceTimersByTimeAsync(90);
          await onDelta?.({ update: { type: "thinking-delta", text: "." } });
        }
      };
    }

    it("keeps a run alive past the timeout while deltas arrive", async () => {
      const h = harness();
      const stream = streaming(h);
      vi.mocked(h.run.wait).mockImplementation(async () => {
        await stream(8);
        return { id: "run-1", status: "finished", result: "done", usage };
      });
      await expect(
        runCompletion({ ...request, timeoutMs: 100 }, h),
      ).resolves.toMatchObject({ text: "done" });
      expect(h.run.cancel).not.toHaveBeenCalled();
    });

    it("times out a full limit after the last delta", async () => {
      const h = harness();
      const stream = streaming(h);
      let aliveBeforeLimit: boolean | undefined;
      vi.mocked(h.run.wait).mockImplementation(async () => {
        await stream(4);
        await vi.advanceTimersByTimeAsync(99);
        aliveBeforeLimit = vi.mocked(h.run.cancel).mock.calls.length === 0;
        await vi.advanceTimersByTimeAsync(1);
        return new Promise(() => {});
      });
      await expect(
        runCompletion({ ...request, timeoutMs: 100 }, h),
      ).rejects.toThrow(/timed out/i);
      expect(aliveBeforeLimit).toBe(true);
      expect(h.run.cancel).toHaveBeenCalledTimes(1);
    });

    it("restarts the idle limit when summary messages arrive without deltas", async () => {
      const h = harness();
      const pending: {
        type: "summary";
        agent_id: string;
        run_id: string;
        status: "running" | "completed";
      }[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      vi.mocked(h.send).mockImplementation(async () => h.run);
      vi.mocked(h.run.stream).mockImplementation(async function* () {
        for (;;) {
          if (pending.length > 0) {
            yield pending.shift()!;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      });
      const refreshIdle = vi.fn();
      const emit = async (status: "running" | "completed") => {
        pending.push({
          type: "summary",
          agent_id: "agent-1",
          run_id: "run-1",
          status,
        });
        const resume = wake;
        wake = undefined;
        resume?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      vi.mocked(h.run.wait).mockImplementation(async () => {
        await vi.advanceTimersByTimeAsync(90);
        await emit("running");
        await vi.advanceTimersByTimeAsync(90);
        await emit("completed");
        await vi.advanceTimersByTimeAsync(90);
        closed = true;
        wake?.();
        return { id: "run-1", status: "finished", result: "done", usage };
      });
      await expect(
        runCompletion({ ...request, timeoutMs: 100, refreshIdle }, h),
      ).resolves.toMatchObject({ text: "done" });
      expect(refreshIdle).toHaveBeenCalledTimes(2);
      expect(h.run.cancel).not.toHaveBeenCalled();
    });
  });

  it("removes the workspace when releasing the caller idle timer throws", async () => {
    const h = harness();
    await expect(
      runCompletion(
        {
          ...request,
          releaseIdle: () => {
            throw new Error("idle release failed");
          },
        },
        h,
      ),
    ).resolves.toMatchObject({ calls: [], text: "hello" });
    await expect(access(h.options.local!.cwd!)).rejects.toThrow();
  });

  it("keeps the completion result when summary observation fails", async () => {
    const h = harness();
    vi.mocked(h.run.stream).mockImplementation(async function* () {
      throw new Error("summary stream failed");
    });
    await expect(runCompletion(request, h)).resolves.toMatchObject({
      text: "hello",
    });
  });

  it("keeps the completion result when the summary stream stays open", async () => {
    const h = harness();
    vi.mocked(h.run.stream).mockImplementation(async function* () {
      await new Promise<void>(() => {});
    });
    await expect(runCompletion(request, h)).resolves.toMatchObject({
      text: "hello",
    });
  });

  it("keeps watching summaries when refreshIdle throws", async () => {
    const h = harness();
    const refreshes: string[] = [];
    vi.mocked(h.send).mockImplementation(async () => h.run);
    vi.mocked(h.run.stream).mockImplementation(async function* () {
      yield {
        type: "summary" as const,
        agent_id: "agent-1",
        run_id: "run-1",
        status: "running" as const,
      };
      yield {
        type: "summary" as const,
        agent_id: "agent-1",
        run_id: "run-1",
        status: "completed" as const,
      };
    });
    vi.mocked(h.run.wait).mockImplementation(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { id: "run-1", status: "finished", result: "done", usage };
    });
    await expect(
      runCompletion(
        {
          ...request,
          refreshIdle: () => {
            refreshes.push("refresh");
            if (refreshes.length === 1) throw new Error("refresh failed");
          },
        },
        h,
      ),
    ).resolves.toMatchObject({ text: "done" });
    expect(refreshes).toEqual(["refresh", "refresh"]);
  });

  it.each([
    {
      label: "generic SDK message",
      error: { message: "Error", code: "resource_exhausted" },
      expected:
        /^\[resource_exhausted\] Cursor rate limit or usage limit was reached\.$/,
    },
    {
      label: "bracketed SDK message",
      error: {
        message: "[resource_exhausted] Error",
        code: "resource_exhausted",
      },
      expected:
        /^\[resource_exhausted\] Cursor rate limit or usage limit was reached\.$/,
    },
    {
      label: "missing SDK detail",
      error: undefined,
      expected: /^Cursor run did not finish\.$/,
    },
  ])("reports an unfinished run ($label)", async ({ error, expected }) => {
    const h = harness();
    vi.mocked(h.run.wait).mockResolvedValue({
      id: "run-1",
      status: "error",
      error,
      usage,
    });
    await expect(runCompletion(request, h)).rejects.toThrow(expected);
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["cancel rejection", "cancel failed: timeout at /synthetic/private"],
    ["cancel deadline", "SDK cleanup timed out."],
    [
      "unconfirmed cancel with disposal failure",
      "network error during disposal",
    ],
  ])(
    "reports %s as a non-retryable cleanup failure",
    async (scenario, detail) => {
      const h = harness();
      h.send.mockImplementation(async (_message, opts) => {
        void Promise.resolve(
          h.options.local!.customTools!.pi_tool_0!.execute({}, {}),
        ).catch(() => {});
        await opts?.onDelta?.({ update: toolCallStarted() });
        return h.run;
      });
      vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
      if (scenario === "cancel rejection") {
        vi.mocked(h.run.cancel).mockRejectedValue(new Error(detail));
      } else if (scenario === "cancel deadline") {
        vi.mocked(h.run.cancel).mockImplementation(() => new Promise(() => {}));
      } else {
        vi.mocked(h.run.cancel).mockResolvedValue(undefined);
        h.dispose.mockRejectedValue(new Error(detail));
      }
      const failure: unknown = await runCompletion(
        {
          ...request,
          cleanupTimeoutMs: 20,
          tools: [{ name: "bash", description: "shell", parameters: {} }],
        },
        h,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      const error = failure as AggregateError;
      const errorMessage = markRetryableTransportFailure(formatFailure(error));
      expect(
        isRetryableAssistantError({
          stopReason: "error",
          errorMessage,
        } as AssistantMessage),
      ).toBe(false);
      const workspace = h.options.local!.cwd!;
      expect(errorMessage).not.toContain(workspace);
      expect(errorMessage).not.toContain(detail);
      expect(error.errors).toEqual([
        expect.objectContaining({ message: detail }),
      ]);
      expect(h.dispose).toHaveBeenCalledTimes(1);
      if (scenario === "unconfirmed cancel with disposal failure") {
        await expect(access(workspace)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(error.cause).toEqual({ retainedWorkspace: workspace });
        await expect(access(workspace)).resolves.toBeUndefined();
      }
    },
  );

  it("keeps cleanup failure on the run error when cancellation also fails", async () => {
    const h = harness();
    vi.mocked(h.run.wait).mockRejectedValue(new Error("Premature close"));
    vi.mocked(h.run.cancel).mockRejectedValue(new Error("cancel failed"));
    let failure: unknown;
    try {
      await runCompletion(request, h);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    const workspace = h.options.local!.cwd!;
    expect(error.message).toBe("Premature close");
    expect(error.cause).toBeInstanceOf(AggregateError);
    const cleanup = error.cause as AggregateError;
    expect(cleanup.cause).toEqual({ retainedWorkspace: workspace });
    expect(cleanup.errors).toEqual([
      expect.objectContaining({ message: "cancel failed" }),
    ]);
    expect(h.run.cancel).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledTimes(1);
    await expect(access(workspace)).resolves.toBeUndefined();
  });

  it.each(["finished", "error", "running"] as const)(
    "does not return captured calls when the run ends %s instead of cancelled",
    async (terminal) => {
      const h = harness();
      h.send.mockImplementation(async (_message, opts) => {
        void Promise.resolve(
          h.options.local!.customTools!.pi_tool_0!.execute({}, {}),
        ).catch(() => {});
        await opts?.onDelta?.({ update: toolCallStarted() });
        return h.run;
      });
      vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
      vi.mocked(h.run.cancel).mockImplementation(async () => {
        h.setStatus(terminal);
      });
      await expect(
        runCompletion(
          {
            ...request,
            tools: [{ name: "bash", description: "shell", parameters: {} }],
          },
          h,
        ),
      ).rejects.toThrow(`not confirmed cancelled (status: ${terminal})`);
    },
  );

  it("returns a finished answer when disposal times out and still removes the workspace", async () => {
    const h = harness();
    h.dispose.mockImplementation(() => new Promise(() => {}));
    await expect(
      runCompletion({ ...request, cleanupTimeoutMs: 20 }, h),
    ).resolves.toMatchObject({ calls: [], text: "hello", usage });
    await expect(access(h.options.local!.cwd!)).rejects.toThrow();
  });
  it.each([false, true])(
    "hands off after confirmed cancel (disposal fails: %s)",
    async (disposalFails) => {
      const h = harness();
      const order: string[] = [];
      h.send.mockImplementation(async (_message, opts) => {
        const callback = h.options.local!.customTools!.pi_tool_0!;
        void Promise.resolve(
          callback.execute({ path: "file.ts" }, { toolCallId: "sdk-call" }),
        ).catch(() => {});
        await opts?.onDelta?.({ update: toolCallStarted("sdk-call") });
        return h.run;
      });
      vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
      const cancel = vi.mocked(h.run.cancel).getMockImplementation()!;
      vi.mocked(h.run.cancel).mockImplementation(async () => {
        order.push("cancel");
        await cancel();
      });
      h.dispose.mockImplementation(async () => {
        order.push("dispose");
        if (disposalFails) throw new Error("network error during disposal");
      });
      const result = await runCompletion(
        {
          ...request,
          tools: [
            {
              name: "read",
              description: "Read file",
              parameters: { type: "object" },
            },
          ],
        },
        h,
      );
      order.push("return");
      expect(h.options.tools).toEqual(["mcp"]);
      expect(h.options.local!.customTools!.pi_tool_0!.inputSchema).toEqual({
        type: "object",
      });
      expect(result.calls).toEqual([
        { id: "sdk-call", name: "read", arguments: { path: "file.ts" } },
      ]);
      expect(order).toEqual(["cancel", "dispose", "return"]);
      await expect(access(h.options.local!.cwd!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it("assigns distinct fallback IDs across completions without changing SDK IDs", async () => {
    async function complete() {
      const h = harness();
      h.send.mockImplementation(async (_message, opts) => {
        const tool = h.options.local!.customTools!.pi_tool_0!;
        for (const context of [{}, { toolCallId: "sdk-call" }, {}]) {
          void Promise.resolve(tool.execute({}, context)).catch(() => {});
        }
        await opts?.onDelta?.({ update: toolCallStarted() });
        return h.run;
      });
      vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
      const result = await runCompletion(
        {
          ...request,
          tools: [{ name: "echo", description: "echo", parameters: {} }],
        },
        h,
      );
      return result.calls.map((call) => call.id);
    }

    const first = await complete();
    const second = await complete();
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(first[1]).toBe("sdk-call");
    expect(second[1]).toBe("sdk-call");
    expect(new Set([...first, ...second])).toHaveProperty("size", 5);
  });
  it("returns all synchronously captured calls only after cleanup", async () => {
    const h = harness();
    const rejected: unknown[] = [];
    h.send.mockImplementation(async (_message, opts) => {
      const tool = h.options.local!.customTools!.pi_tool_0!;
      for (const id of ["first", "second"]) {
        void Promise.resolve(tool.execute({ id }, { toolCallId: id })).catch(
          (error) => rejected.push(error),
        );
      }
      await opts?.onDelta?.({ update: toolCallStarted("first") });
      return h.run;
    });
    vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
    const result = await runCompletion(
      {
        ...request,
        tools: [{ name: "echo", description: "echo", parameters: {} }],
      },
      h,
    );
    expect(result.calls).toEqual([
      { id: "first", name: "echo", arguments: { id: "first" } },
      { id: "second", name: "echo", arguments: { id: "second" } },
    ]);
    expect(rejected).toHaveLength(2);
    expect(h.run.cancel).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
    await expect(access(h.options.local!.cwd!)).rejects.toThrow();
    await expect(
      h.options.local!.customTools!.pi_tool_0!.execute({}, {}),
    ).rejects.toThrow(/closed/);
  });
  it("returns assistant text that arrived before a captured tool", async () => {
    const h = harness();
    h.send.mockImplementation(async (_message, opts) => {
      await opts?.onDelta?.({
        update: { type: "text-delta", text: "Read the file." },
      });
      void Promise.resolve(
        h.options.local!.customTools!.pi_tool_0!.execute(
          { path: "a.ts" },
          { toolCallId: "sdk-call" },
        ),
      ).catch(() => {});
      await opts?.onDelta?.({ update: toolCallStarted("sdk-call") });
      return h.run;
    });
    vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
    const result = await runCompletion(
      {
        ...request,
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: { type: "object" },
          },
        ],
      },
      h,
    );
    expect(result).toMatchObject({
      text: "Read the file.",
      calls: [{ id: "sdk-call", name: "read", arguments: { path: "a.ts" } }],
    });
    expect(h.run.cancel).toHaveBeenCalledOnce();
  });

  it("estimates cancelled tool-capture usage without counting thinking", async () => {
    const h = harness();
    const prompt = "x".repeat(10);
    const visible = "abcd";
    const args = { path: "ab" };
    h.send.mockImplementation(async (_message, opts) => {
      await opts?.onDelta?.({
        update: { type: "thinking-delta", text: "z".repeat(400) },
      });
      await opts?.onDelta?.({
        update: { type: "text-delta", text: visible },
      });
      void Promise.resolve(
        h.options.local!.customTools!.pi_tool_0!.execute(args, {
          toolCallId: "sdk-call",
        }),
      ).catch(() => {});
      await opts?.onDelta?.({ update: toolCallStarted("sdk-call") });
      return h.run;
    });
    vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
    const result = await runCompletion(
      {
        ...request,
        prompt,
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: { type: "object" },
          },
        ],
      },
      h,
    );
    // 10 prompt chars -> 3. Text 4 + {"path":"ab"} 13 = 17 chars -> 5.
    // The 400-character thinking delta is not part of the next prompt.
    expect(result).toMatchObject({
      text: visible,
      calls: [{ id: "sdk-call", name: "read", arguments: args }],
      usage: {
        inputTokens: 3,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 8,
      },
    });
    expect(result.usage).not.toBe(usage);
    expect(h.run.cancel).toHaveBeenCalledOnce();
  });

  it("includes a preamble delta still in flight at tool capture", async () => {
    const h = harness();
    const deltas: string[] = [];
    let releaseTail!: () => void;
    const tailHeld = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    h.send.mockImplementation(async (_message, opts) => {
      await opts?.onDelta?.({
        update: { type: "text-delta", text: "Before " },
      });
      void Promise.resolve(
        h.options.local!.customTools!.pi_tool_0!.execute(
          { path: "a.ts" },
          { toolCallId: "sdk-call" },
        ),
      ).catch(() => {});
      const inflight = opts?.onDelta?.({
        update: { type: "text-delta", text: "tools" },
      });
      setImmediate(releaseTail);
      await inflight;
      await opts?.onDelta?.({ update: toolCallStarted("sdk-call") });
      return h.run;
    });
    vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
    const result = await runCompletion(
      {
        ...request,
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: { type: "object" },
          },
        ],
        onDelta: async ({ update }) => {
          if (update.type !== "text-delta") return;
          deltas.push(update.text);
          if (update.text === "tools") await tailHeld;
        },
      },
      h,
    );
    expect(deltas).toEqual(["Before ", "tools"]);
    expect(result).toMatchObject({
      text: "Before tools",
      calls: [{ id: "sdk-call", name: "read", arguments: { path: "a.ts" } }],
    });
    expect(h.run.cancel).toHaveBeenCalledOnce();
  });

  it("releases tool handoff when a preamble delta never returns", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let releaseStall = () => {};
    try {
      const h = harness();
      const stalled = new Promise<void>((resolve) => {
        releaseStall = resolve;
      });
      let ready = false;
      h.send.mockImplementation(async (_message, opts) => {
        await opts?.onDelta?.({
          update: { type: "text-delta", text: "Before " },
        });
        void Promise.resolve(
          h.options.local!.customTools!.pi_tool_0!.execute(
            { path: "a.ts" },
            { toolCallId: "sdk-call" },
          ),
        ).catch(() => {});
        void opts?.onDelta?.({
          update: { type: "text-delta", text: "stalled" },
        });
        ready = true;
        return h.run;
      });
      vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
      let settled = false;
      const pending = runCompletion(
        {
          ...request,
          timeoutMs: 60_000,
          tools: [
            {
              name: "read",
              description: "Read file",
              parameters: { type: "object" },
            },
          ],
          onDelta: async ({ update }) => {
            if (update.type === "text-delta" && update.text === "stalled")
              await stalled;
          },
        },
        h,
      );
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 100 && !ready; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(ready).toBe(true);
      for (let i = 0; i < 4; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({
        text: "Before ",
        calls: [{ id: "sdk-call", name: "read", arguments: { path: "a.ts" } }],
      });
      expect(h.run.cancel).toHaveBeenCalledOnce();
    } finally {
      releaseStall();
      vi.useRealTimers();
    }
  });

  it("keeps text delivered after execute until tool-call-started", async () => {
    const h = harness();
    const startedAt = Date.now();
    h.send.mockImplementation(async (_message, opts) => {
      void Promise.resolve(
        h.options.local!.customTools!.pi_tool_0!.execute(
          { path: "a.ts" },
          { toolCallId: "sdk-call" },
        ),
      ).catch(() => {});
      await opts?.onDelta?.({
        update: { type: "text-delta", text: "Run echo. " },
      });
      await opts?.onDelta?.({
        update: { type: "thinking-completed", thinkingDurationMs: 20 },
      });
      await opts?.onDelta?.({ update: { type: "text-delta", text: "Now." } });
      await opts?.onDelta?.({ update: toolCallStarted("sdk-call") });
      await opts?.onDelta?.({
        update: { type: "text-delta", text: " hidden" },
      });
      return h.run;
    });
    vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
    const result = await runCompletion(
      {
        ...request,
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: { type: "object" },
          },
        ],
      },
      h,
    );
    expect(Date.now() - startedAt).toBeLessThan(800);
    expect(result).toMatchObject({
      text: "Run echo. Now.",
      calls: [{ id: "sdk-call", name: "read", arguments: { path: "a.ts" } }],
    });
    expect(h.run.cancel).toHaveBeenCalledOnce();
  });

  it("keeps post-execute text when tool-call-started stays quiet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      let ready = false;
      h.send.mockImplementation(async (_message, opts) => {
        void Promise.resolve(
          h.options.local!.customTools!.pi_tool_0!.execute(
            { path: "a.ts" },
            { toolCallId: "sdk-call" },
          ),
        ).catch(() => {});
        await opts?.onDelta?.({
          update: { type: "text-delta", text: "late text" },
        });
        ready = true;
        return h.run;
      });
      vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
      let settled = false;
      const pending = runCompletion(
        {
          ...request,
          timeoutMs: 60_000,
          tools: [
            {
              name: "read",
              description: "Read file",
              parameters: { type: "object" },
            },
          ],
        },
        h,
      );
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 100 && !ready; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(ready).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({
        text: "late text",
        calls: [{ id: "sdk-call", name: "read", arguments: { path: "a.ts" } }],
      });
      expect(h.run.cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps text after execute when an earlier tool-call-started already passed", async () => {
    const h = harness();
    const startedAt = Date.now();
    h.send.mockImplementation(async (_message, opts) => {
      await opts?.onDelta?.({ update: toolCallStarted("earlier") });
      void Promise.resolve(
        h.options.local!.customTools!.pi_tool_0!.execute(
          { path: "a.ts" },
          { toolCallId: "sdk-call" },
        ),
      ).catch(() => {});
      await opts?.onDelta?.({
        update: { type: "text-delta", text: "after earlier marker" },
      });
      await opts?.onDelta?.({ update: toolCallStarted("different-id") });
      await opts?.onDelta?.({
        update: { type: "text-delta", text: " hidden" },
      });
      return h.run;
    });
    vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
    const result = await runCompletion(
      {
        ...request,
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: { type: "object" },
          },
        ],
      },
      h,
    );
    expect(Date.now() - startedAt).toBeLessThan(800);
    expect(result).toMatchObject({
      text: "after earlier marker",
      calls: [{ id: "sdk-call", name: "read", arguments: { path: "a.ts" } }],
    });
    expect(h.run.cancel).toHaveBeenCalledOnce();
  });

  it("includes text still in flight when tool-call-started arrives", async () => {
    const h = harness();
    let releaseTail!: () => void;
    const tailHeld = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    h.send.mockImplementation(async (_message, opts) => {
      void Promise.resolve(
        h.options.local!.customTools!.pi_tool_0!.execute(
          { path: "a.ts" },
          { toolCallId: "sdk-call" },
        ),
      ).catch(() => {});
      const inflight = opts?.onDelta?.({
        update: { type: "text-delta", text: "late" },
      });
      await opts?.onDelta?.({ update: toolCallStarted("sdk-call") });
      releaseTail();
      await inflight;
      return h.run;
    });
    vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
    const result = await runCompletion(
      {
        ...request,
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: { type: "object" },
          },
        ],
        onDelta: async ({ update }) => {
          if (update.type === "text-delta" && update.text === "late")
            await tailHeld;
        },
      },
      h,
    );
    expect(result).toMatchObject({
      text: "late",
      calls: [{ id: "sdk-call", name: "read", arguments: { path: "a.ts" } }],
    });
    expect(h.run.cancel).toHaveBeenCalledOnce();
  });

  it("extends the quiet handoff when another delta arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      let onDelta: NonNullable<
        Parameters<BridgeAgent["send"]>[1]
      >["onDelta"] = async () => {};
      let ready = false;
      h.send.mockImplementation(async (_message, opts) => {
        onDelta = opts?.onDelta ?? onDelta;
        void Promise.resolve(
          h.options.local!.customTools!.pi_tool_0!.execute(
            { path: "a.ts" },
            { toolCallId: "sdk-call" },
          ),
        ).catch(() => {});
        ready = true;
        return h.run;
      });
      vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
      let settled = false;
      const pending = runCompletion(
        {
          ...request,
          timeoutMs: 60_000,
          tools: [
            {
              name: "read",
              description: "Read file",
              parameters: { type: "object" },
            },
          ],
        },
        h,
      );
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 100 && !ready; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(ready).toBe(true);
      await vi.advanceTimersByTimeAsync(900);
      expect(settled).toBe(false);
      await onDelta({ update: { type: "text-delta", text: "late" } });
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(800);
      await expect(pending).resolves.toMatchObject({
        text: "late",
        calls: [{ id: "sdk-call", name: "read", arguments: { path: "a.ts" } }],
      });
      expect(h.run.cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes immediately when the same tool-call-started arrived before execute", async () => {
    const h = harness();
    const startedAt = Date.now();
    h.send.mockImplementation(async (_message, opts) => {
      await opts?.onDelta?.({
        update: { type: "text-delta", text: "before " },
      });
      await opts?.onDelta?.({ update: toolCallStarted("sdk-call") });
      void Promise.resolve(
        h.options.local!.customTools!.pi_tool_0!.execute(
          { path: "a.ts" },
          { toolCallId: "sdk-call" },
        ),
      ).catch(() => {});
      await opts?.onDelta?.({
        update: { type: "text-delta", text: "after" },
      });
      return h.run;
    });
    vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
    const result = await runCompletion(
      {
        ...request,
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: { type: "object" },
          },
        ],
      },
      h,
    );
    expect(Date.now() - startedAt).toBeLessThan(800);
    expect(result).toMatchObject({
      text: "before ",
      calls: [{ id: "sdk-call", name: "read", arguments: { path: "a.ts" } }],
    });
    expect(h.run.cancel).toHaveBeenCalledOnce();
  });

  it("keeps a tool execute queued after the first tool-call-started", async () => {
    const h = harness();
    h.send.mockImplementation(async (_message, opts) => {
      const tool = h.options.local!.customTools!.pi_tool_0!;
      void Promise.resolve(
        tool.execute({ id: "first" }, { toolCallId: "first" }),
      ).catch(() => {});
      await opts?.onDelta?.({ update: toolCallStarted("first") });
      await new Promise<void>((resolve) => setImmediate(resolve));
      void Promise.resolve(
        tool.execute({ id: "second" }, { toolCallId: "second" }),
      ).catch(() => {});
      return h.run;
    });
    vi.mocked(h.run.wait).mockImplementation(() => new Promise(() => {}));
    const result = await runCompletion(
      {
        ...request,
        tools: [{ name: "echo", description: "echo", parameters: {} }],
      },
      h,
    );
    expect(result.calls).toEqual([
      { id: "first", name: "echo", arguments: { id: "first" } },
      { id: "second", name: "echo", arguments: { id: "second" } },
    ]);
    expect(h.run.cancel).toHaveBeenCalledOnce();
  });

  it("streams text, closes the isolated agent and removes its workspace", async () => {
    const h = harness();
    const deltas: string[] = [];
    const result = await runCompletion(
      {
        ...request,
        onDelta: ({ update }) => {
          if (update.type === "text-delta") deltas.push(update.text);
        },
      },
      h,
    );
    expect(result).toEqual({ calls: [], text: "hello", usage });
    expect(deltas).toEqual(["hello"]);
    expect(h.options.tools).toEqual([]);
    expect(h.options.local?.settingSources).toEqual([]);
    expect(h.options.local?.enableAgentRetries).toBe(false);
    expect(h.options.mcpServers).toEqual({});
    expect(h.options.agents).toEqual({});
    expect(h.options.systemPrompt).toBeUndefined();
    expect(h.options.local?.cwd).not.toBe(process.cwd());
    expect(h.dispose).toHaveBeenCalledTimes(1);
    await expect(access(h.options.local!.cwd!)).rejects.toThrow();
  });
});
