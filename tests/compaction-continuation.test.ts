import { afterEach, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import type { CompletionRequest } from "../src/bridge.js";
import { withOfflinePiSession } from "./offline-session.js";

const marker = "<!-- cursor-sdk:continue-after-compaction -->";

afterEach(() => vi.unstubAllEnvs());

it.each([
  {
    name: "marked unfinished",
    enabled: true,
    mark: true,
    compact: true,
    expected: 1,
  },
  { name: "completed", enabled: true, mark: false, compact: true, expected: 0 },
  { name: "disabled", enabled: false, mark: true, compact: true, expected: 0 },
  {
    name: "no threshold compaction",
    enabled: true,
    mark: true,
    compact: false,
    expected: 0,
  },
])(
  "runs at most one post-compaction continuation for $name work",
  async ({ enabled, mark, compact, expected }) => {
    vi.stubEnv(
      "PI_CURSOR_SDK_CONTINUE_AFTER_COMPACTION",
      enabled ? "1" : undefined,
    );
    let initial = true;
    let continued = 0;
    let summaries = 0;
    const requests: string[] = [];
    const complete = vi.fn(async ({ prompt }: CompletionRequest) => {
      requests.push(prompt);
      let text: string;
      let inputTokens = 100;
      if (prompt.includes("Create a structured context checkpoint summary")) {
        summaries++;
        text = "Synthetic saved checkpoint";
      } else if (
        prompt.includes("Resume the unfinished task from the compacted context")
      ) {
        expect(prompt).toContain("Synthetic saved checkpoint");
        continued++;
        // A repeated model marker must not cause another continuation.
        text = `Still unfinished\n${marker}`;
      } else if (initial) {
        initial = false;
        text = "Initial reply";
      } else {
        text = mark ? `Work remains\n${marker}` : "Work is done";
        inputTokens = compact ? 60_000 : 100;
      }
      return {
        calls: [],
        text,
        usage: {
          inputTokens,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: inputTokens + 20,
        },
      };
    });
    await withOfflinePiSession(
      "pi-cursor-continue-",
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
          extensionFactories: [
            (pi) => extension({ ...pi, registerProvider() {} }),
          ],
        });
        await session.bindExtensions({});
        await session.prompt("Initial task");
        await session.prompt("Next task");
        const compactions = manager
          .getBranch()
          .filter((entry) => entry.type === "compaction");
        expect(summaries > 0).toBe(compact);
        expect(compactions.length).toBe(compact ? 1 : 0);
        expect(continued).toBe(expected);
        expect(requests[1]?.includes(marker)).toBe(enabled);
        expect(
          manager
            .getBranch()
            .filter(
              (entry) =>
                entry.type === "custom_message" &&
                entry.customType === "cursor-sdk-post-compaction",
            ),
        ).toHaveLength(expected);
      },
    );
  },
);
