import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Cursor, type SDKAgent } from "@cursor/sdk";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  type ExtensionAPI,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import extension from "../src/index.js";

const id = "cursor-sdk";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function withRuntime(
  overlay: boolean,
  run: (
    runtime: ModelRuntime,
    credentials: InMemoryCredentialStore,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-cursor-registration-"));
  try {
    const modelsPath = join(directory, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: overlay
          ? {
              [id]: {
                api: "cursor-sdk-api",
                apiKey: "fixture-config-key",
                baseUrl: "https://fixture.invalid",
                models: [{ id: "stale-model", name: "Stale model" }],
              },
            }
          : {},
      }),
    );
    vi.stubEnv("CURSOR_DATA_DIR", directory);
    const credentials = new InMemoryCredentialStore();
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    extension({
      registerProvider(
        provider:
          string | Parameters<ModelRuntime["registerNativeProvider"]>[0],
        config?: ProviderConfig,
      ) {
        if (typeof provider === "string")
          runtime.registerProvider(provider, config!);
        else runtime.registerNativeProvider(provider);
      },
      registerCommand() {},
    } as unknown as ExtensionAPI);
    await run(runtime, credentials);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectDispatchKey(runtime: ModelRuntime, expected: string) {
  const create = vi.spyOn(Agent, "create").mockResolvedValue({
    async send() {
      return {
        status: "finished",
        async wait() {
          return { status: "finished", result: "offline" };
        },
        stream: async function* () {},
      };
    },
    async [Symbol.asyncDispose]() {},
  } as unknown as SDKAgent);
  const model = runtime.getModel(id, "auto")!;
  const result = await runtime.completeSimple(model, { messages: [] });
  expect(result.stopReason).toBe("stop");
  expect(create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ apiKey: expected }),
  );
}

it("accepts and stores a manually entered Cursor SDK API key through Pi", async () => {
  vi.stubEnv("CURSOR_API_KEY", "fixture-env-key");
  const list = vi
    .spyOn(Cursor.models, "list")
    .mockResolvedValue([{ id: "sdk-model", displayName: "SDK model" }]);
  await withRuntime(false, async (runtime) => {
    const prompt = vi.fn(async () => "fixture-manual-key");
    await runtime.login(id, "api_key", { notify() {}, prompt });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ type: "secret" }),
    );
    await runtime.refresh({ providers: [id], allowNetwork: true });
    expect(list).toHaveBeenLastCalledWith({ apiKey: "fixture-manual-key" });
    await expectDispatchKey(runtime, "fixture-manual-key");
  });
});

it.each(["ambient", "stored"])(
  "uses the %s key instead of the models.json key",
  async (source) => {
    vi.stubEnv("CURSOR_API_KEY", "fixture-env-key");
    const list = vi
      .spyOn(Cursor.models, "list")
      .mockResolvedValue([{ id: "sdk-model", displayName: "SDK model" }]);
    await withRuntime(true, async (runtime, credentials) => {
      if (source === "stored")
        await credentials.modify(id, async () => ({
          type: "api_key",
          key: "fixture-stored-key",
        }));
      const result = await runtime.refresh({
        providers: [id],
        allowNetwork: true,
      });
      expect(result.errors.size).toBe(0);
      const expected =
        source === "stored" ? "fixture-stored-key" : "fixture-env-key";
      expect(list).toHaveBeenLastCalledWith({ apiKey: expected });
      await expectDispatchKey(runtime, expected);
    });
  },
);

it("does not expose models.json rows absent from Cursor SDK routing", async () => {
  vi.stubEnv("CURSOR_API_KEY", "fixture-env-key");
  vi.spyOn(Cursor.models, "list").mockResolvedValue([
    { id: "sdk-model", displayName: "SDK model" },
  ]);
  await withRuntime(true, async (runtime) => {
    expect(runtime.getModel(id, "stale-model")).toBeUndefined();
    await runtime.refresh({ providers: [id], allowNetwork: true });
    expect((await runtime.getAvailable(id)).map(({ id }) => id)).toEqual([
      "sdk-model",
      "auto",
    ]);
  });
});
