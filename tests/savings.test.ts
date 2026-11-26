import { describe, expect, it, vi } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { createCursorSdkProvider } from "../src/provider.js";
import type { CompletionRequest } from "../src/bridge.js";

const model = {
  id: "auto",
  api: "cursor-sdk-api",
  provider: "cursor-sdk",
} as Model<"cursor-sdk-api">;
const big = "始🙂".repeat(5000) + "終";
const tool = {
  name: "read",
  description: "A detailed description",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};
const result = (id: string, isError = false) => ({
  role: "toolResult" as const,
  toolName: "read",
  toolCallId: id,
  content: [{ type: "text" as const, text: big }],
  timestamp: 1,
  isError,
});
const assistant = (stopReason: "stop" | "aborted") => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "previous response" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason,
  timestamp: 2,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const context = normalizeContext({
  tools: [tool],
  messages: [
    result("old"),
    result("error", true),
    assistant("stop"),
    result("not-answered"),
    assistant("aborted"),
    { role: "user", content: "continue", timestamp: 2 },
    result("recent"),
  ],
});
async function request(
  savings?: { trimToolResults?: boolean; compactToolDefinitions?: boolean },
  toolChoice?: "none",
) {
  const complete = vi.fn(async (_request: CompletionRequest) => ({
    calls: [],
    text: "Fixture answer.",
  }));
  const provider = createCursorSdkProvider({
    complete,
    listModels: async () => [],
    login: vi.fn(),
    savings,
    measurePayload: true,
  });
  const output = await provider
    .streamSimple(model, context, {
      apiKey: "test-placeholder",
      toolChoice,
    })
    .result();
  expect(output.stopReason).toBe("stop");
  const sent = complete.mock.calls[0]![0];
  return {
    sent,
    json: JSON.parse(sent.prompt.slice(0, sent.prompt.indexOf("\n"))),
  };
}

describe("Cursor usage savings", () => {
  it("clips only large successful historical tool results and leaves Pi history untouched", async () => {
    const full = await request();
    const { sent, json } = await request({ trimToolResults: true });
    expect(full.json.transcript[0].content[0].text).toBe(big);
    const clip = json.transcript[0].content[0].text as string;
    expect(clip).toContain("omitted");
    expect(clip).not.toContain("�");
    expect(clip.endsWith("終")).toBe(true);
    expect(Buffer.byteLength(clip)).toBeLessThanOrEqual(8192);
    expect(json.transcript[0].toolCallId).toBe("old");
    expect(json.transcript[1].content[0].text).toBe(big);
    for (const id of ["not-answered", "recent"]) {
      const entry = json.transcript.find(
        (msg: { toolCallId?: string }) => msg.toolCallId === id,
      );
      expect(entry.content[0].text === big).toBe(true);
    }
    expect(clip.startsWith("始🙂")).toBe(true);
    expect(
      context.messages.find((m) => m.role === "toolResult")?.content,
    ).toEqual(result("old").content);
    expect(sent.promptBreakdown!.toolResultsBytes).toBeLessThan(
      full.sent.promptBreakdown!.toolResultsBytes,
    );
  });

  it("keeps SDK tools intact while sending only names in the replay; none stays none", async () => {
    const full = await request();
    const { sent, json } = await request({ compactToolDefinitions: true });
    expect(full.json.tools).toEqual([tool]);
    expect(json.tools).toEqual([{ name: "read" }]);
    expect(sent.tools).toEqual([tool]);
    expect(sent.promptBreakdown!.promptToolsBytes).toBeLessThan(
      full.sent.promptBreakdown!.promptToolsBytes,
    );
    const disabled = await request({ compactToolDefinitions: true }, "none");
    expect(disabled.json.tools).toEqual([]);
    expect(disabled.sent.tools).toEqual([]);
  });

  it("uses Pi's native retry and model-specific compaction settings", () => {
    const example = JSON.parse(
      readFileSync(
        new URL("../examples/cursor-budget-settings.json", import.meta.url),
        "utf8",
      ),
    );
    const settings = SettingsManager.inMemory(example);
    expect(settings.getRetrySettings()).toMatchObject({
      maxRetries: 1,
    });
    expect(settings.getCompactionSettings(model)).toMatchObject({
      reserveTokens: 24000,
      keepRecentTokens: 12000,
    });
    expect(
      settings.getCompactionSettings({ id: "other", provider: "other" }),
    ).toEqual(SettingsManager.inMemory().getCompactionSettings());
    expect(example.retry).not.toHaveProperty("enabled");
  });
});
