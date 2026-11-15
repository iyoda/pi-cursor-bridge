import { afterEach, describe, expect, it, vi } from "vitest";
import { Cursor } from "@cursor/sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { CatalogRefreshError } from "../src/catalog.js";

describe("Pi extension registration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      new CatalogRefreshError("Invalid catalog: Model ID collision: example"),
      /Model ID collision.*Previous catalog retained/,
    ],
    [
      new Error("secret-network-response"),
      /Check authentication and connectivity/,
    ],
  ])(
    "shows catalog diagnostics without exposing raw network errors",
    async (error, expected) => {
      const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
      extension({
        registerProvider: vi.fn(),
        registerCommand,
      } as unknown as ExtensionAPI);
      const handler = registerCommand.mock.calls[0]![1].handler;
      const notify = vi.fn();
      await handler("", {
        modelRegistry: {
          refresh: vi.fn(async () => ({
            errors: new Map([["cursor-sdk", error]]),
            aborted: false,
          })),
        },
        ui: { notify },
      } as unknown as Parameters<typeof handler>[1]);
      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(expected),
        "error",
      );
      expect(notify.mock.calls[0]![0]).not.toContain("secret-network-response");
    },
  );
  it("reports omitted models and clears that count after a failed refresh", async () => {
    vi.spyOn(Cursor.models, "list").mockResolvedValue([
      { id: "good", displayName: "Good" },
      {
        id: "bad",
        displayName: "Bad",
        parameters: [{ id: "effort", values: [{ value: "high" }] }],
      },
    ]);
    const registerProvider = vi.fn<ExtensionAPI["registerProvider"]>();
    const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
    extension({
      registerProvider,
      registerCommand,
    } as unknown as ExtensionAPI);
    const config = registerProvider.mock.calls[0]?.[1];
    if (!config?.refreshModels) throw new Error("provider was not registered");
    const handler = registerCommand.mock.calls[0]![1].handler;
    const notify = vi.fn();
    const signal = new AbortController().signal;
    await handler("", {
      modelRegistry: {
        refresh: vi.fn(async () => {
          await config.refreshModels!({
            credential: { type: "api_key", key: "test-key" },
            allowNetwork: true,
            signal,
            publish: async (publication) => {
              publication.update?.();
              return true;
            },
          });
          return { errors: new Map(), aborted: false };
        }),
      },
      ui: { notify },
    } as unknown as Parameters<typeof handler>[1]);
    expect(notify).toHaveBeenCalledWith(
      "Cursor SDK model catalog refreshed. 1 model omitted.",
      "warning",
    );

    notify.mockClear();
    await handler("", {
      modelRegistry: {
        refresh: vi.fn(async () => ({
          errors: new Map([
            ["cursor-sdk", new CatalogRefreshError("Invalid catalog: empty")],
          ]),
          aborted: false,
        })),
      },
      ui: { notify },
    } as unknown as Parameters<typeof handler>[1]);
    expect(notify).toHaveBeenCalledWith(
      "Invalid catalog: empty Previous catalog retained.",
      "error",
    );
  });

  it("uses a distinct provider id without changing existing cursor providers", () => {
    const registerProvider = vi.fn();
    const registerCommand = vi.fn();
    extension({ registerProvider, registerCommand } as unknown as ExtensionAPI);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(
      "cursor-sdk",
      expect.objectContaining({ api: "cursor-sdk-api" }),
    );
    expect(registerCommand).toHaveBeenCalledWith(
      "cursor-sdk-refresh",
      expect.objectContaining({ handler: expect.any(Function) }),
    );
  });
});
