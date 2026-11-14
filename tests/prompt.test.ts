import { describe, expect, it } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { buildPrompt } from "../src/prompt.js";

describe("Pi transcript replay", () => {
  it("replays system section and tool updates into the current state", () => {
    const prompt = buildPrompt(
      normalizeContext({
        messages: [
          {
            role: "system",
            content: "Base instructions",
            timestamp: 1,
            sections: { policy: "Old policy" },
            toolsAdded: [
              { name: "old_tool", description: "old", parameters: {} },
            ],
          },
          { role: "user", content: "First request", timestamp: 2 },
          {
            role: "system",
            content: "Additional instructions",
            timestamp: 3,
            sections: { policy: "New policy" },
            toolsRemoved: [{ name: "old_tool" }],
            toolsAdded: [
              { name: "new_tool", description: "new", parameters: {} },
            ],
          },
          { role: "user", content: "Latest request", timestamp: 4 },
        ],
      }),
    );
    expect(prompt.instructions).toContain("Base instructions");
    expect(prompt.instructions).toContain("Additional instructions");
    expect(prompt.instructions).toContain("New policy");
    expect(prompt.instructions).not.toContain("Old policy");
    expect(prompt.tools.map((tool) => tool.name)).toEqual(["new_tool"]);
    expect(prompt.transcript).toEqual([
      { role: "user", content: "First request" },
      { role: "user", content: "Latest request" },
    ]);
  });
  it("rejects images rather than dropping them or leaking base64 into JSON", () => {
    const context = normalizeContext({
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
          timestamp: 1,
        },
      ],
    });
    expect(() => buildPrompt(context)).toThrow(/text-only/i);
  });

  it("omits signed thinking and failed assistant output", () => {
    const assistant = {
      role: "assistant" as const,
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 1,
    };
    const context = normalizeContext({
      messages: [
        {
          ...assistant,
          stopReason: "stop",
          content: [
            {
              type: "thinking",
              thinking: "private",
              thinkingSignature: "secret-signature",
            },
            { type: "text", text: "hello" },
          ],
        },
        {
          ...assistant,
          stopReason: "error",
          content: [{ type: "text", text: "failed partial" }],
        },
      ],
    });
    expect(buildPrompt(context).transcript).toEqual([
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
  });
  it("replays instructions, roles and tool results without provider metadata", () => {
    const context = normalizeContext({
      systemPrompt: "Use Japanese",
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object" },
        },
      ],
      messages: [
        { role: "user", content: "Inspect code", timestamp: 1 },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "Permission denied" }],
          isError: true,
          timestamp: 2,
        },
      ],
    });
    const prompt = buildPrompt(context);
    expect(prompt.instructions).toBe("Use Japanese");
    expect(prompt.transcript).toEqual([
      { role: "user", content: "Inspect code" },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "Permission denied" }],
        isError: true,
      },
    ]);
    expect(prompt.tools[0]?.name).toBe("read");
    expect(JSON.stringify(prompt)).not.toContain("timestamp");
  });
});
