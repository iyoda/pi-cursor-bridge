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
        on: vi.fn(),
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
        id: "bad-test-key\u001b\nmodel",
        displayName: "Bad",
        parameters: [{ id: "effort", values: [{ value: "high" }] }],
      },
      { id: "second", displayName: "One" },
      { id: "second", displayName: "Two" },
      { id: "third", displayName: "One" },
      { id: "third", displayName: "Two" },
      {
        id: "fourth",
        displayName: "Fourth",
        parameters: [{ id: "effort", values: [{ value: "high" }] }],
      },
    ]);
    const registerProvider = vi.fn<ExtensionAPI["registerProvider"]>();
    const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
    extension({
      registerProvider,
      on: vi.fn(),
      registerCommand,
    } as unknown as ExtensionAPI);
    const config = registerProvider.mock.calls[0]?.[1] as
      | {
          refreshModels?: (ctx: {
            credential?: unknown;
            allowNetwork: boolean;
            signal: AbortSignal;
            publish: (publication: { update?: () => void }) => Promise<boolean>;
          }) => Promise<void>;
        }
      | undefined;
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
      expect.stringContaining("4 SDK model IDs omitted."),
      "warning",
    );
    const message = notify.mock.calls[0]![0] as string;
    expect(message).toContain(
      "Parameterized model bad-[REDACTED]  model has no variants",
    );
    expect(message).toContain(
      "Duplicate SDK model id with different data: second",
    );
    expect(message).toContain(
      "Duplicate SDK model id with different data: third",
    );
    expect(message).toContain("1 more omitted");
    expect(message).not.toContain("fourth");
    expect(message).not.toMatch(/test-key|\u001b|\n/);

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
    extension({
      registerProvider,
      registerCommand,
      on: vi.fn(),
    } as unknown as ExtensionAPI);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(
      "cursor-sdk",
      expect.objectContaining({ name: "Cursor SDK" }),
    );
    expect(registerCommand).toHaveBeenCalledWith(
      "cursor-sdk-refresh",
      expect.objectContaining({ handler: expect.any(Function) }),
    );
  });
});
