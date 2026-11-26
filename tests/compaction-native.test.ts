import { expect, it, vi } from "vitest";
import type { CompletionRequest } from "../src/bridge.js";
import { withOfflinePiSession } from "./offline-session.js";

const checkpoint = "Offline checkpoint: step two remains.";
const usage = (inputTokens: number) => ({
  inputTokens,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: inputTokens + 20,
});

it.each(["threshold", "overflow"] as const)(
  "replays compacted context with native Pi: %s",
  async (reason) => {
    const steps: string[] = [];
    let sawCheckpoint = false;
    const complete = vi.fn(async ({ prompt }: CompletionRequest) => {
      if (
        prompt.includes("Create a structured context checkpoint summary") ||
        prompt.includes("Create a concise checkpoint of the user's request")
      ) {
        steps.push("summary");
        return { calls: [], text: checkpoint, usage: usage(100) };
      }
      if (prompt.includes(checkpoint)) {
        sawCheckpoint = true;
        steps.push("resumed");
        return { calls: [], text: "Step two done.", usage: usage(100) };
      }
      if (steps.length === 0) {
        steps.push("seed");
        return { calls: [], text: "Step one done.", usage: usage(100) };
      }
      steps.push("work");
      if (reason === "overflow") {
        throw new Error("This request exceeds the context window.");
      }
      return { calls: [], text: "Step two remains.", usage: usage(60_000) };
    });
    await withOfflinePiSession(
      "pi-cursor-native-compact-",
      { complete, listModels: vi.fn(async () => []), login: vi.fn() },
      async ({ runtime, start }) => {
        const { session, manager } = await start({
          model: runtime.getModel("cursor-sdk", "auto")!,
          thinkingLevel: "off",
          compaction: {
            enabled: true,
            reserveTokens: 10_000,
            keepRecentTokens: 1,
          },
        });
        const completed: { reason: string; willRetry: boolean }[] = [];
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "compaction_end" && event.result) {
            completed.push({
              reason: event.reason,
              willRetry: event.willRetry,
            });
          }
        });
        try {
          await session.prompt("Finish step one.");
          await session.prompt("Perform step two.");
          await session.waitForIdle();
          expect(completed).toEqual([
            { reason, willRetry: reason === "overflow" },
          ]);
          expect(
            manager.getBranch().filter((entry) => entry.type === "compaction"),
          ).toHaveLength(1);
          expect(steps.slice(0, 2)).toEqual(["seed", "work"]);
          if (reason === "threshold") {
            // Pi can summarize both the history and the prefix of a split turn.
            expect(steps.slice(2)).not.toHaveLength(0);
            expect(steps.slice(2).every((step) => step === "summary")).toBe(
              true,
            );
            expect(sawCheckpoint).toBe(false);
            await session.prompt("Continue step two.");
          }
          expect(steps.at(-1)).toBe("resumed");
          expect(steps.slice(2, -1)).not.toHaveLength(0);
          expect(steps.slice(2, -1).every((step) => step === "summary")).toBe(
            true,
          );
          expect(sawCheckpoint).toBe(true);
          expect(session.messages.at(-1)).toMatchObject({
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Step two done." }],
          });
        } finally {
          unsubscribe();
        }
      },
    );
  },
);
