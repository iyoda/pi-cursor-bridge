import { describe, expect, it, vi } from "vitest";
import type { ProviderDependencies } from "../src/provider.js";
import { withOfflinePiSession } from "./offline-session.js";

describe("real Pi request compatibility", () => {
  it("runs an ordinary Pi turn without inventing an explicit maxTokens limit", async () => {
    const deps: ProviderDependencies = {
      complete: vi.fn(async () => ({ calls: [], text: "offline reply" })),
      listModels: vi.fn(async () => []),
      login: vi.fn(),
    };
    await withOfflinePiSession(
      "pi-cursor-sdk-session-test-",
      deps,
      async ({ runtime, start }) => {
        const { session } = await start({
          model: runtime.getModel("cursor-sdk", "auto")!,
          thinkingLevel: "off",
        });
        await session.prompt("Say hello");
        expect(deps.complete).toHaveBeenCalledTimes(1);
        const final = session.messages.at(-1);
        expect(final?.role === "assistant" && final.stopReason).toBe("stop");
        expect(final?.role === "assistant" && final.content).toEqual([
          { type: "text", text: "offline reply" },
        ]);
      },
    );
  });
});
