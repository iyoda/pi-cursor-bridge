/** Manual, opt-in live validation only. Never loaded by the package or CI. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function smokeTools(pi: ExtensionAPI): void {
  let executions = 0;
  let denied = false;
  pi.registerTool({
    name: "smoke_echo",
    label: "Smoke echo",
    description: "Return the fixed text SMOKE_OK without performing any I/O.",
    parameters: Type.Object({}),
    async execute() {
      executions++;
      return { content: [{ type: "text", text: "SMOKE_OK" }], details: {} };
    },
  });
  pi.on("tool_call", (event) => {
    if (event.toolName === "smoke_echo" && denied)
      return { block: true, reason: "Smoke test permission denied." };
  });
  pi.registerCommand("smoke-deny", {
    description: "Toggle denial of smoke_echo (no inference)",
    handler: async (_args, ctx) => {
      denied = !denied;
      ctx.ui.notify(
        `smoke_echo denied=${denied}; executions=${executions}`,
        "info",
      );
    },
  });
  pi.registerCommand("smoke-status", {
    description: "Show smoke_echo execution count (no inference)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `smoke_echo denied=${denied}; executions=${executions}`,
        "info",
      );
    },
  });
}
