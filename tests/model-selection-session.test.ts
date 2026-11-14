import { expect, it, vi } from "vitest";
import type { ProviderDependencies } from "../src/provider.js";
import { withOfflinePiSession } from "./offline-session.js";

it("uses Pi model and Thinking changes for SDK selection and native session records", async () => {
  const deps: ProviderDependencies = {
    complete: vi.fn(async () => ({ calls: [], text: "offline reply" })),
    listModels: vi.fn(async () => [
      {
        id: "test-model",
        displayName: "Test Model",
        variants: [false, true].flatMap((fast) =>
          ["medium", "high"].map((effort) => ({
            displayName: effort,
            params: [
              { id: "context", value: "272k" },
              { id: "fast", value: String(fast) },
              { id: "effort", value: effort },
            ],
          })),
        ),
      },
    ]),
    login: vi.fn(),
  };
  await withOfflinePiSession(
    "pi-cursor-sdk-selection-test-",
    deps,
    async ({ runtime, start }) => {
      const refresh = await runtime.refresh({
        providers: ["cursor-sdk"],
        allowNetwork: true,
      });
      expect([...refresh.errors]).toEqual([]);
      const fast = runtime.getModel("cursor-sdk", "test-model-fast")!;
      const regular = runtime.getModel("cursor-sdk", "test-model")!;
      expect(fast).toBeDefined();
      expect(regular).toBeDefined();
      const { session, manager } = await start({
        model: fast,
        thinkingLevel: "high",
      });
      await session.prompt("First reply");
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
      });
      expect(vi.mocked(deps.complete).mock.calls[0]![0].model).toEqual({
        id: "test-model",
        params: [
          { id: "context", value: "272k" },
          { id: "fast", value: "true" },
          { id: "effort", value: "high" },
        ],
        maxMode: false,
      });
      await session.setModel(regular);
      session.setThinkingLevel("medium");
      await session.prompt("Second reply");
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
      });
      expect(vi.mocked(deps.complete).mock.calls[1]![0].model).toEqual({
        id: "test-model",
        params: [
          { id: "context", value: "272k" },
          { id: "fast", value: "false" },
          { id: "effort", value: "medium" },
        ],
        maxMode: false,
      });
      expect(manager.getBranch()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "model_change",
            provider: "cursor-sdk",
            modelId: "test-model",
          }),
          expect.objectContaining({
            type: "thinking_level_change",
            thinkingLevel: "medium",
          }),
        ]),
      );
      expect(manager.getBranch().some((entry) => entry.type === "custom")).toBe(
        false,
      );
      expect(deps.complete).toHaveBeenCalledTimes(2);
    },
  );
});
