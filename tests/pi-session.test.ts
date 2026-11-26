import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import type { ProviderDependencies } from "../src/provider.js";
import { withOfflinePiSession } from "./offline-session.js";

describe("real Pi request compatibility", () => {
  it("shows a separate approximate context percentage until Pi has post-compaction usage", async () => {
    const deps: ProviderDependencies = {
      complete: vi.fn(async () => ({
        calls: [],
        text: "offline reply",
        usage: {
          inputTokens: 1000,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1020,
        },
      })),
      listModels: vi.fn(async () => []),
      login: vi.fn(),
    };
    await withOfflinePiSession(
      "pi-cursor-post-compact-",
      deps,
      async ({ runtime, start }) => {
        const { session, manager } = await start({
          model: runtime.getModel("cursor-sdk", "auto")!,
          thinkingLevel: "off",
        });
        const handlers = new Map<
          string,
          (event: unknown, ctx: ExtensionContext) => void
        >();
        extension({
          on: (
            event: string,
            handler: (event: unknown, ctx: ExtensionContext) => void,
          ) => handlers.set(event, handler),
          registerCommand() {},
          registerProvider() {},
        } as unknown as ExtensionAPI);
        const setStatus = vi.fn();
        const ctx = {
          hasUI: true,
          model: session.model,
          ui: { setStatus },
          sessionManager: manager,
          getContextUsage: () => session.getContextUsage(),
        } as unknown as ExtensionContext;
        const fire = (event: string) =>
          handlers.get(event)?.({ type: event }, ctx);

        await session.prompt("A".repeat(64_000));
        expect(session.getContextUsage()?.percent).not.toBeNull();
        const kept = manager.appendMessage({
          role: "user",
          content: "B".repeat(2560),
          timestamp: 1,
        });
        manager.appendCompaction("S".repeat(2560), kept, 20_000);
        expect(session.getContextUsage()?.percent).toBeNull();
        fire("session_compact");
        expect(setStatus).toHaveBeenLastCalledWith(
          "cursor-sdk-context",
          "Pi context ≈2.0%",
        );

        await session.prompt("Continue");
        expect(session.getContextUsage()?.percent).not.toBeNull();
        fire("agent_end");
        expect(setStatus).toHaveBeenLastCalledWith(
          "cursor-sdk-context",
          undefined,
        );
      },
    );
  });
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
