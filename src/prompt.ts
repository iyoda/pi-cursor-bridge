import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export function buildPrompt(context: TranscriptContext) {
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
    transcript: context.messages.flatMap((message): unknown[] => {
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
        case "toolResult":
          return [
            {
              role: message.role,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              content: message.content,
              isError: message.isError,
            },
          ];
      }
    }),
    tools: getCurrentTools(context.messages),
  };
}
