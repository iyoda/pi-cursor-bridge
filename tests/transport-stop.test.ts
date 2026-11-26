import { expect, it, vi } from "vitest";
import { runCompletion, type BridgeRun } from "../src/bridge.js";
import { withOfflinePiSession } from "./offline-session.js";

const failure = "[unknown] http/2 stream closed [canceled]";
const partial = "incomplete thinking from the broken stream";
const unfinished = "I still need to verify step two.";
const task = "Review the fixture and verify step two.";
const noAnswer = "Cursor finished without an answer or tool call.";
const usage = (inputTokens: number) => ({
  inputTokens,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: inputTokens + 20,
});

it.each([
  { retry: true, thinkingOnly: "none" },
  { retry: true, thinkingOnly: "work" },
  { retry: true, thinkingOnly: "summary" },
  { retry: false, thinkingOnly: "none" },
])(
  "handles a closed SDK stream (Pi retry $retry, thinking-only recovery $thinkingOnly)",
  async ({ retry, thinkingOnly }) => {
    const attempts: { stage: string; prompt: string }[] = [];
    let workAttempts = 0;
    const disposed = vi.fn();
    const cancel = vi.fn();
    const checkpoint = "Fixture checkpoint: verify step two.";
    await withOfflinePiSession(
      "pi-cursor-transport-stop-",
      {
        complete: (request) =>
          runCompletion(request, {
            createAgent: async () => ({
              async send(prompt, options) {
                const summary =
                  /Create a structured context checkpoint summary|Create a concise checkpoint of the user's request/.test(
                    prompt,
                  );
                const stage = summary
                  ? "summary"
                  : prompt.includes(task)
                    ? "work"
                    : "seed";
                attempts.push({ stage, prompt });
                if (stage === "work" && ++workAttempts === 1) {
                  const run: BridgeRun = {
                    status: "error",
                    async wait() {
                      await options?.onDelta?.({
                        update: { type: "thinking-delta", text: partial },
                      });
                      return {
                        id: "failed-run",
                        status: "error",
                        error: { message: failure, code: "unknown" },
                      };
                    },
                    async *stream() {},
                    cancel,
                    usage: undefined,
                  };
                  return run;
                }
                const run: BridgeRun = {
                  status: "finished",
                  async wait() {
                    if (stage === thinkingOnly) {
                      await options?.onDelta?.({
                        update: { type: "thinking-delta", text: unfinished },
                      });
                    }
                    return {
                      id: `fixture-${attempts.length}`,
                      status: "finished",
                      result:
                        stage === thinkingOnly
                          ? undefined
                          : summary
                            ? checkpoint
                            : stage === "work"
                              ? unfinished
                              : "Initial context recorded.",
                      usage: usage(stage === "work" ? 60_000 : 100),
                    };
                  },
                  async *stream() {},
                  cancel,
                  usage: undefined,
                };
                return run;
              },
              [Symbol.asyncDispose]: disposed,
            }),
          }),
        listModels: vi.fn(async () => []),
        login: vi.fn(),
      },
      async ({ runtime, start }) => {
        const { session, manager } = await start({
          model: runtime.getModel("cursor-sdk", "auto")!,
          thinkingLevel: "off",
          retry: { enabled: retry, maxRetries: 2, baseDelayMs: 1 },
          compaction: {
            enabled: true,
            reserveTokens: 10_000,
            keepRecentTokens: 1,
          },
        });
        const retries: unknown[] = [];
        const compactions: unknown[] = [];
        const stops: string[] = [];
        const blocks: string[][] = [];
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "auto_retry_start")
            retries.push({ attempt: event.attempt, error: event.errorMessage });
          if (event.type === "auto_retry_end")
            retries.push({ success: event.success });
          if (event.type === "compaction_end")
            compactions.push({
              reason: event.reason,
              willRetry: event.willRetry,
              saved: !!event.result,
              error: event.errorMessage,
            });
          if (
            event.type === "message_end" &&
            event.message.role === "assistant"
          ) {
            stops.push(event.message.stopReason);
            blocks.push(event.message.content.map(({ type }) => type));
          }
        });
        try {
          await session.prompt("Seed an earlier turn.");
          await session.prompt(task);
          await session.waitForIdle();
          const work = attempts.filter(({ stage }) => stage === "work");
          expect(work).toHaveLength(retry ? 2 : 1);
          expect(disposed).toHaveBeenCalledTimes(attempts.length);
          expect(cancel).not.toHaveBeenCalled();
          expect(
            session.messages.some((message) => message.role === "toolResult"),
          ).toBe(false);
          if (!retry) {
            expect(retries).toEqual([]);
            expect(compactions).toEqual([]);
            expect(stops).toEqual(["stop", "error"]);
            expect(blocks).toEqual([["text"], ["thinking"]]);
            return;
          }
          expect(retries).toEqual([
            {
              attempt: 1,
              error: `${failure} (Cursor network error; retryable)`,
            },
            { success: thinkingOnly !== "work" },
          ]);
          expect(work[1]?.prompt).toBe(work[0]?.prompt);
          expect(work[1]?.prompt).not.toContain(partial);
          expect(stops).toEqual([
            "stop",
            "error",
            thinkingOnly === "work" ? "error" : "stop",
          ]);
          expect(blocks).toEqual([
            ["text"],
            ["thinking"],
            [thinkingOnly === "work" ? "thinking" : "text"],
          ]);
          const saved = manager
            .getBranch()
            .filter((entry) => entry.type === "compaction");
          if (thinkingOnly === "work") {
            expect(session.messages.at(-1)).toMatchObject({
              role: "assistant",
              errorMessage: noAnswer,
            });
            expect(compactions).toEqual([]);
            expect(saved).toHaveLength(0);
            expect(attempts.slice(3)).toEqual([]);
            return;
          }
          if (thinkingOnly === "summary") {
            expect(compactions).toEqual([
              {
                reason: "threshold",
                willRetry: false,
                saved: false,
                error: expect.stringContaining(noAnswer),
              },
            ]);
            expect(saved).toHaveLength(0);
            expect(attempts.slice(3).map(({ stage }) => stage)).toEqual([
              "summary",
            ]);
            return;
          }
          expect(compactions).toEqual([
            { reason: "threshold", willRetry: false, saved: true },
          ]);
          expect(saved).toHaveLength(1);
          expect(attempts.slice(3).map(({ stage }) => stage)).toEqual([
            "summary",
            "summary",
          ]);
        } finally {
          unsubscribe();
        }
      },
    );
  },
);
