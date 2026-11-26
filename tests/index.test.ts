import { writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, Cursor, type SDKAgent } from "@cursor/sdk";
import {
  normalizeContext,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeSync: vi.fn(),
}));

const model: Model<"cursor-sdk-api"> = {
  type: "chat",
  id: "auto",
  name: "Auto",
  api: "cursor-sdk-api",
  provider: "cursor-sdk",
  baseUrl: "https://api2.cursor.sh",
  reasoning: false,
  input: ["text"],
  contextWindow: 64000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function providerConfig(): ProviderConfig {
  const registerProvider = vi.fn<ExtensionAPI["registerProvider"]>();
  extension({
    registerProvider,
    on: vi.fn(),
    registerCommand: vi.fn(),
  } as unknown as ExtensionAPI);
  const provider = registerProvider.mock.calls[0]?.[1] as
    ProviderConfig | undefined;
  if (!provider) throw new Error("cursor-sdk provider was not registered");
  return provider;
}

describe("cursor-sdk extension wiring", () => {
  const dataDirs: string[] = [];
  let previousDataDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(writeSync).mockReset();
    vi.unstubAllEnvs();
    if (previousDataDir === undefined) delete process.env.CURSOR_DATA_DIR;
    else process.env.CURSOR_DATA_DIR = previousDataDir;
    await Promise.all(
      dataDirs
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("sends login and model listing through the official Cursor SDK", async () => {
    const login = vi.spyOn(Cursor.auth, "login").mockResolvedValue({
      apiKey: "wired-key",
      apiKeyExpiresAtMs: 123,
    });
    const list = vi
      .spyOn(Cursor.models, "list")
      .mockResolvedValue([{ id: "from-index", displayName: "From Index" }]);
    const config = providerConfig();
    const signal = new AbortController().signal;
    const onAuth = vi.fn();
    await expect(
      config.oauth!.login({
        signal,
        onAuth,
        onDeviceCode: vi.fn(),
        onPrompt: vi.fn(async () => ""),
        onSelect: vi.fn(async () => undefined),
      }),
    ).resolves.toMatchObject({ access: "wired-key", expires: 123 });
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        store: null,
        openBrowser: false,
        apiKeyName: "pi-cursor-sdk",
        signal,
      }),
    );
    const url = "https://cursor.example/login";
    const sent = login.mock.calls[0]?.[0];
    if (!sent?.onLoginUrl) throw new Error("login options were not passed");
    sent.onLoginUrl(url);
    expect(onAuth).toHaveBeenCalledWith(expect.objectContaining({ url }));

    const refreshed = await config.refreshModels!({
      credential: { type: "api_key", key: "test-key" },
      allowNetwork: true,
      signal,
      publish: async (publication) => {
        publication.update?.();
        return true;
      },
    });
    expect(list).toHaveBeenCalledWith({ apiKey: "test-key" });
    expect(refreshed.map((item) => item.id)).toEqual(["from-index", "auto"]);
  });

  it.each(["off", "other", "on", "write-error"])(
    "creates the SDK agent and handles payload metrics mode %s",
    async (mode) => {
      vi.stubEnv(
        "PI_CURSOR_SDK_PAYLOAD_METRICS",
        mode === "off" ? undefined : mode === "other" ? "true" : "1",
      );
      const write = vi.mocked(writeSync);
      if (mode === "write-error") {
        write.mockImplementation(() => {
          throw Object.assign(new Error("closed stderr"), { code: "EPIPE" });
        });
      }
      previousDataDir = process.env.CURSOR_DATA_DIR;
      const dataDir = await mkdtemp(join(tmpdir(), "pi-cursor-sdk-index-"));
      dataDirs.push(dataDir);
      process.env.CURSOR_DATA_DIR = dataDir;
      const create = vi.spyOn(Agent, "create").mockResolvedValue({
        async send() {
          return {
            status: "finished",
            async wait() {
              return { status: "finished", result: "from-index" };
            },
            async cancel() {},
            stream: async function* () {},
          };
        },
        async [Symbol.asyncDispose]() {},
      } as unknown as SDKAgent);
      const config = providerConfig();
      const events: AssistantMessageEvent[] = [];
      for await (const event of config.streamSimple!(
        model,
        normalizeContext({ messages: [] }),
        { apiKey: "test-key" },
      )) {
        events.push(event);
      }
      expect(events.at(-1)?.type).toBe("done");
      if (mode === "off" || mode === "other") {
        expect(write).not.toHaveBeenCalled();
      } else {
        expect(write).toHaveBeenCalledTimes(1);
        const [fd, line] = write.mock.calls[0]!;
        expect(fd).toBe(2);
        expect(line).toMatch(/^[^\n]+\n$/u);
        expect(String(line)).not.toContain("test-key");
        expect(JSON.parse(String(line))).toEqual({
          event: "cursor-sdk-send",
          promptBytes: expect.any(Number),
          promptBreakdown: {
            instructionsBytes: expect.any(Number),
            historyBytes: 0,
            toolResultsBytes: 0,
            promptToolsBytes: 2,
            harnessNotesBytes: expect.any(Number),
            framingBytes: expect.any(Number),
          },
          sdkCustomToolsJsonBytes: 2,
          toolCount: 0,
        });
      }
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "test-key",
          model: { id: "auto" },
          local: expect.objectContaining({ enableAgentRetries: false }),
        }),
      );
    },
  );
});
