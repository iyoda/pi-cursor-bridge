import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  abortAfter,
  formatFailure,
  isTransientCursorTransportFailure,
  markRetryableTransportFailure,
  MAX_TIMEOUT_MS,
  untilAborted,
  validateTimeout,
} from "../src/async.js";
import { runCompletion } from "../src/bridge.js";

function piRetries(errorMessage: string): boolean {
  return isRetryableAssistantError({
    stopReason: "error",
    errorMessage,
  } as AssistantMessage);
}

describe("deadline primitives", () => {
  it.each([0, -1, 1.5, NaN, Infinity, MAX_TIMEOUT_MS + 1])(
    "rejects invalid timeout %s before acquiring an agent",
    async (ms) => {
      expect(() => validateTimeout(ms)).toThrow(/Deadline values/);
      const deps = { createAgent: vi.fn() };
      const request = {
        apiKey: "test",
        model: { id: "auto" },
        prompt: "test",
        tools: [],
      };
      await expect(
        runCompletion({ ...request, timeoutMs: ms }, deps),
      ).rejects.toThrow(/Deadline values/);
      await expect(
        runCompletion({ ...request, cleanupTimeoutMs: ms }, deps),
      ).rejects.toThrow(/Deadline values/);
      expect(deps.createAgent).not.toHaveBeenCalled();
    },
  );

  describe("abortAfter idle refresh", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("measures the limit from the latest refresh", () => {
      const deadline = abortAfter(100, "idle");
      vi.advanceTimersByTime(90);
      deadline.refresh();
      vi.advanceTimersByTime(99);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(deadline.signal.aborted).toBe(true);
      expect((deadline.signal.reason as Error).message).toBe("idle");
    });

    it.each([
      {
        label: "after clear",
        end: (deadline: ReturnType<typeof abortAfter>) => deadline.clear(),
      },
      {
        label: "after firing",
        end: () => vi.advanceTimersByTime(100),
      },
    ])("does not re-arm $label", ({ end }) => {
      const deadline = abortAfter(100, "idle");
      end(deadline);
      const aborted = deadline.signal.aborted;
      deadline.refresh();
      deadline.clear();
      deadline.refresh();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1_000);
      expect(deadline.signal.aborted).toBe(aborted);
    });

    it("does not re-arm after the parent signal aborts", () => {
      const parent = new AbortController();
      const deadline = abortAfter(100, "idle", parent.signal);
      parent.abort(new Error("user"));
      deadline.refresh();
      expect(vi.getTimerCount()).toBe(0);
      expect((deadline.signal.reason as Error).message).toBe("user");
    });
  });

  it.each([1, MAX_TIMEOUT_MS])("accepts timeout boundary %s", (ms) => {
    expect(() => validateTimeout(ms)).not.toThrow();
  });

  it("observes a rejection even when the signal is already aborted", async () => {
    const error = new Error("cancelled");
    await expect(
      untilAborted(
        Promise.reject(new Error("late failure")),
        AbortSignal.abort(error),
      ),
    ).rejects.toBe(error);
  });

  it("removes the abort listener after completion", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(
      untilAborted(Promise.resolve(42), controller.signal),
    ).resolves.toBe(42);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("failure text", () => {
  it.each<{ label: string; value: unknown; expected: string }>([
    {
      label: "code and generic message",
      value: { message: "Error", code: "resource_exhausted" },
      expected:
        "[resource_exhausted] Cursor rate limit or usage limit was reached.",
    },
    {
      label: "stored bracket text",
      value: new Error("[resource_exhausted] Error"),
      expected:
        "[resource_exhausted] Cursor rate limit or usage limit was reached.",
    },
    {
      label: "repeated Error prefix",
      value: "Error: Error: [resource_exhausted] Error",
      expected:
        "[resource_exhausted] Cursor rate limit or usage limit was reached.",
    },
    {
      label: "specific message",
      value: { message: "Too many requests", code: "resource_exhausted" },
      expected: "[resource_exhausted] Too many requests",
    },
    {
      label: "formatted text stays stable",
      value: new Error(
        "[resource_exhausted] Cursor rate limit or usage limit was reached.",
      ),
      expected:
        "[resource_exhausted] Cursor rate limit or usage limit was reached.",
    },
    {
      label: "ConnectError numeric code",
      value: Object.assign(new Error("[resource_exhausted] Error"), {
        name: "ConnectError",
        code: 8,
        rawMessage: "Error",
      }),
      expected:
        "[resource_exhausted] Cursor rate limit or usage limit was reached.",
    },
    {
      label: "ConnectError with an empty raw message",
      value: Object.assign(new Error("[resource_exhausted]"), {
        name: "ConnectError",
        code: 8,
        rawMessage: "",
      }),
      expected:
        "[resource_exhausted] Cursor rate limit or usage limit was reached.",
    },
    {
      label: "ordinary error",
      value: new Error("Authorization: Bearer secret"),
      expected: "Authorization: Bearer secret",
    },
  ])("$label", ({ value, expected }) => {
    expect(formatFailure(value)).toBe(expected);
  });

  it("uses the caller fallback when the SDK message is only Error", () => {
    expect(
      formatFailure({ message: "Error" }, "Cursor run did not finish."),
    ).toBe("Cursor run did not finish.");
  });

  it("keeps Pi's own Error prefix from doubling", () => {
    const displayed = `Error: ${formatFailure(
      new Error("[resource_exhausted] Error"),
    )}`;
    expect(displayed).toBe(
      "Error: [resource_exhausted] Cursor rate limit or usage limit was reached.",
    );
  });
});

describe("retryable transport failures", () => {
  it.each<{
    label: string;
    message: string;
    code?: string;
    expected: string;
  }>([
    {
      label: "premature close",
      message: "[unknown] Premature close",
      expected: "[unknown] Premature close (Cursor network error; retryable)",
    },
    {
      label: "connection stalled",
      message: "[connection_stalled] Connection stalled",
      expected:
        "[connection_stalled] Connection stalled (Cursor network error; retryable)",
    },
    {
      label: "connection stalled repeatedly",
      message: "[connection_stalled] Connection stalled repeatedly",
      expected:
        "[connection_stalled] Connection stalled repeatedly (Cursor network error; retryable)",
    },
    {
      label: "connection stalled code",
      message: "Connection stalled",
      code: "connection_stalled",
      expected: "Connection stalled (Cursor network error; retryable)",
    },
    {
      label: "ECONNRESET",
      message: "read ECONNRESET",
      expected: "read ECONNRESET (Cursor network error; retryable)",
    },
    {
      label: "NGHTTP2",
      message: "NGHTTP2_REFUSED_STREAM",
      expected: "NGHTTP2_REFUSED_STREAM (Cursor network error; retryable)",
    },
  ])("marks $label", ({ message, code, expected }) => {
    expect(isTransientCursorTransportFailure(message, code)).toBe(true);
    expect(markRetryableTransportFailure(message, code)).toBe(expected);
    expect(piRetries(expected)).toBe(true);
  });

  it("treats ENOTFOUND as transient without rewriting text Pi already retries", () => {
    const message = "getaddrinfo ENOTFOUND api2.cursor.sh";
    expect(isTransientCursorTransportFailure(message)).toBe(true);
    expect(markRetryableTransportFailure(message)).toBe(message);
    expect(piRetries(message)).toBe(true);
  });

  it("requires a word boundary around DNS codes", () => {
    expect(isTransientCursorTransportFailure("ENOTFOUNDED")).toBe(false);
    expect(markRetryableTransportFailure("ENOTFOUNDED")).toBe("ENOTFOUNDED");
  });

  it.each([
    "[resource_exhausted] Cursor rate limit or usage limit was reached.",
    "[resource_exhausted] Premature close",
    "Cursor run did not finish.",
    "SDK cleanup failed (workspace retained at /tmp/ws): Premature close",
    "SDK cleanup timed out. Premature close",
    "not confirmed cancelled (status: error): Premature close",
    "Cursor completion timed out.",
    "Unauthorized: Premature close",
    "Permission Denied: Premature close",
  ])("leaves %s unchanged", (message) => {
    expect(markRetryableTransportFailure(message)).toBe(message);
  });

  it("keeps cleanup failures non-retryable", () => {
    const message =
      "SDK cleanup failed (workspace retained at /tmp/ws): Premature close";
    expect(piRetries(markRetryableTransportFailure(message))).toBe(false);
  });

  it("keeps request-validation failures non-retryable", () => {
    const message =
      "Unsupported Cursor SDK request control: custom fetch/headers, temperature or deferred execution. Premature close";
    expect(markRetryableTransportFailure(message)).toBe(message);
    expect(piRetries(markRetryableTransportFailure(message))).toBe(false);
  });

  it("does not append the marker twice", () => {
    const once = markRetryableTransportFailure("[unknown] Premature close");
    expect(markRetryableTransportFailure(once)).toBe(once);
    expect(once.match(/network error/g)).toHaveLength(1);
  });
});
