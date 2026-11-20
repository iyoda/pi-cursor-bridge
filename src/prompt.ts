import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

const TOOL_RESULT_LIMIT = 8192;
const OMISSION =
  "\n[... historical tool output omitted from this request ...]\n";

function clipToolResult(text: string): string | undefined {
  if (Buffer.byteLength(text) <= TOOL_RESULT_LIMIT) return undefined;
  const bytes = Buffer.from(text);
  const half = Math.floor(
    (TOOL_RESULT_LIMIT - Buffer.byteLength(OMISSION)) / 2,
  );
  let head = half;
  let tail = bytes.length - half;
  // Never cut a UTF-8 code point in half.
  while ((bytes[head]! & 0xc0) === 0x80) head--;
  while ((bytes[tail]! & 0xc0) === 0x80) tail++;
  return (
    bytes.toString("utf8", 0, head) + OMISSION + bytes.toString("utf8", tail)
  );
}

export function buildPrompt(
  context: TranscriptContext,
  trimToolResults = false,
) {
  const latestUser = trimToolResults
    ? context.messages.findLastIndex((message) => message.role === "user")
    : -1;
  // Steering can insert a user message before the model has seen a tool result.
  const completedTurn =
    latestUser < 0
      ? -1
      : context.messages.findLastIndex(
          (message, index) =>
            index < latestUser &&
            message.role === "assistant" &&
            message.stopReason === "stop",
        );
  for (const message of context.messages) {
    if (
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image")
    ) {
      throw new Error(
        "This provider is text-only; image input and image tool results are not supported yet.",
      );
    }
  }
  return {
    instructions: getCurrentSystemPrompt(context.messages),
    transcript: context.messages.flatMap((message, index): unknown[] => {
      switch (message.role) {
        case "system":
          return [];
        case "user":
          return [{ role: message.role, content: message.content }];
        case "assistant":
          if (
            message.stopReason === "error" ||
            message.stopReason === "aborted"
          )
            return [];
          return [
            {
              role: message.role,
              content: message.content.flatMap((part): unknown[] => {
                if (part.type === "text")
                  return [{ type: "text", text: part.text }];
                if (part.type === "toolCall")
                  return [
                    {
                      type: "toolCall",
                      id: part.id,
                      name: part.name,
                      arguments: part.arguments,
                    },
                  ];
                return [];
              }),
            },
          ];
        case "toolResult": {
          const content = message.content;
          const clipped =
            index < completedTurn &&
            !message.isError &&
            content.every((part) => part.type === "text")
              ? clipToolResult(content.map((part) => part.text).join("\n"))
              : undefined;
          return [
            {
              role: message.role,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              content:
                clipped === undefined
                  ? content
                  : [{ type: "text", text: clipped }],
              isError: message.isError,
            },
          ];
        }
      }
    }),
    tools: getCurrentTools(context.messages),
  };
}
