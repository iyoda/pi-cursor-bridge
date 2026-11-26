import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_SDK_PROVIDER } from "./catalog.js";

const MARKER = "<!-- cursor-sdk:continue-after-compaction -->";

export function registerCompactionContinuation(pi: ExtensionAPI): void {
  if (process.env.PI_CURSOR_SDK_CONTINUE_AFTER_COMPACTION !== "1") return;

  let run:
    { unfinished: boolean; compacted: boolean; used: boolean } | undefined;
  const reset = () => {
    run = undefined;
  };
  pi.on("session_start", reset);
  pi.on("agent_settled", reset);
  pi.on("before_agent_start", (event, ctx) => {
    reset();
    if (
      event.messageType !== "user" ||
      ctx.model?.provider !== CURSOR_SDK_PROVIDER
    )
      return;
    run = { unfinished: false, compacted: false, used: false };
    event.systemPromptOptions.appendSystemPrompt += `\n\nCursor bridge continuation: use tools normally. If you must end a response while the current user task still has a concrete authorized next step that needs no user input, end the visible text with a standalone ${MARKER} line. Do not emit it if the work is complete, blocked, or awaiting approval. It only requests one continuation if Pi automatically compacts; it is not a tool and does not change permissions.`;
  });
  pi.on("turn_end", (event, ctx) => {
    if (!run || run.used) return;
    run.compacted = false;
    const message = event.message;
    const tail = message.role === "assistant" && message.content.at(-1);
    run.unfinished =
      ctx.model?.provider === CURSOR_SDK_PROVIDER &&
      message.role === "assistant" &&
      message.provider === CURSOR_SDK_PROVIDER &&
      message.stopReason === "stop" &&
      tail !== false &&
      tail?.type === "text" &&
      tail.text.trimEnd().split("\n").at(-1) === MARKER;
  });
  pi.on("session_compact", (event, ctx) => {
    if (
      run &&
      !run.used &&
      run.unfinished &&
      event.reason === "threshold" &&
      !event.willRetry &&
      ctx.model?.provider === CURSOR_SDK_PROVIDER
    ) {
      run.compacted = true;
    }
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (
      !run?.compacted ||
      run.used ||
      event.outcome !== "completed" ||
      event.continue ||
      event.context.pendingMessages.length ||
      ctx.model?.provider !== CURSOR_SDK_PROVIDER
    )
      return;
    run.used = true;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "cursor-sdk-post-compaction",
          content:
            "Resume the unfinished task from the compacted context. Continue only the original authorized work. Do not repeat completed steps; stop if user input or approval is needed.",
          display: false,
        },
      ],
      continue: true,
    };
  });
}
