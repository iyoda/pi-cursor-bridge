import { writeSync } from "node:fs";
import { Agent, Cursor } from "@cursor/sdk";
import {
  estimateTokens,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runCompletion } from "./bridge.js";
import { CatalogRefreshError, CURSOR_SDK_PROVIDER } from "./catalog.js";
import { registerCompactionContinuation } from "./compaction-continuation.js";
import { createCursorSdkRegistration } from "./provider.js";

function registerContextEstimate(pi: ExtensionAPI): void {
  const key = "cursor-sdk-context";
  const update = (_event: unknown, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const usage =
      ctx.model?.provider === CURSOR_SDK_PROVIDER
        ? ctx.getContextUsage()
        : undefined;
    if (usage?.percent !== null || usage.contextWindow <= 0) {
      ctx.ui.setStatus(key, undefined);
      return;
    }
    // Pi does not trust pre-compaction usage. Estimate only its current
    // projected history, without changing provider usage or the native footer.
    const { messages } = ctx.sessionManager.buildSessionProjection();
    const tokens = messages.reduce(
      (sum, message) => sum + estimateTokens(message),
      0,
    );
    ctx.ui.setStatus(
      key,
      `Pi context ≈${((100 * tokens) / usage.contextWindow).toFixed(1)}%`,
    );
  };
  pi.on("session_start", update);
  pi.on("session_compact", update);
  pi.on("session_tree", update);
  pi.on("model_select", update);
  pi.on("agent_end", update);
}

export default function cursorSdkExtension(pi: ExtensionAPI): void {
  registerContextEstimate(pi);
  registerCompactionContinuation(pi);
  const measurePayload = process.env.PI_CURSOR_SDK_PAYLOAD_METRICS === "1";
  let omittedModels = 0;
  let omittedDetails: readonly string[] = [];
  pi.registerProvider(
    CURSOR_SDK_PROVIDER,
    createCursorSdkRegistration({
      measurePayload,
      savings: {
        trimToolResults: process.env.PI_CURSOR_SDK_TRIM_TOOL_RESULTS === "1",
        compactToolDefinitions:
          process.env.PI_CURSOR_SDK_COMPACT_TOOL_DEFINITIONS === "1",
      },
      complete: (request) =>
        runCompletion(request, {
          createAgent: (options) => Agent.create(options),
          noteSend: measurePayload
            ? (metrics) => {
                // Keep write errors synchronous so the bridge can drop failed diagnostics.
                writeSync(
                  2,
                  `${JSON.stringify({ event: "cursor-sdk-send", ...metrics })}\n`,
                );
              }
            : undefined,
        }),
      listModels: async (apiKey, signal) => {
        signal.throwIfAborted();
        const models = await Cursor.models.list({ apiKey });
        signal.throwIfAborted();
        return models;
      },
      login: (options) => Cursor.auth.login(options),
      noteOmitted(count, details) {
        omittedModels = count;
        omittedDetails = details;
      },
    }),
  );
  pi.registerCommand("cursor-sdk-refresh", {
    description: "Refresh Cursor SDK models (catalog only; no inference)",
    handler: async (_args, context) => {
      omittedModels = 0;
      omittedDetails = [];
      const result = await context.modelRegistry.refresh({
        providers: ["cursor-sdk"],
        allowNetwork: true,
        force: true,
      });
      const error = result.errors.get("cursor-sdk");
      const omitted = `${omittedModels} SDK model ${omittedModels === 1 ? "ID" : "IDs"} omitted.`;
      const remaining = omittedModels - omittedDetails.length;
      const preview = [
        omitted,
        ...omittedDetails,
        ...(remaining > 0 ? [`${remaining} more omitted.`] : []),
      ].join(" ");
      context.ui.notify(
        error
          ? error instanceof CatalogRefreshError
            ? `${error.message} Previous catalog retained.`
            : "Cursor SDK model refresh failed. Check authentication and connectivity."
          : result.aborted
            ? "Cursor SDK model refresh cancelled."
            : omittedModels > 0
              ? `Cursor SDK model catalog refreshed. ${preview}`
              : "Cursor SDK model catalog refreshed.",
        error
          ? "error"
          : !result.aborted && omittedModels > 0
            ? "warning"
            : "info",
      );
    },
  });
}
