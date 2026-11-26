import { expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  runCompletion,
  type BridgeRun,
  type SendMetrics,
} from "../src/bridge.js";
import type { ProviderDependencies } from "../src/provider.js";
import { withOfflinePiSession } from "./offline-session.js";

const turns = [0, 1, 2, 3, 4, 5];
const errorTurn = 4;
const resultText = (turn: number) =>
  `先${turn}:` + '結果🙂"\\\n'.repeat(2400) + ":末";
const callId = (turn: number) => `benchmark-call-${turn}`;
const schemaText = "説明🙂: 合成データの項目と制約。".repeat(24);
const tools = Array.from({ length: 8 }, (_, index) => ({
  name: `synthetic_${index}`,
  label: `Synthetic ${index}`,
  description: schemaText,
  parameters: {
    type: "object",
    properties: {
      turn: { type: "integer", description: schemaText },
      filter: { type: "string", description: schemaText },
    },
    required: ["turn"],
  },
  async execute(_id: string, args: { turn: number }) {
    return {
      content: content(args.turn),
      details: null,
      isError: args.turn === errorTurn,
    };
  },
}));
const toolDefinitions = tools.map(({ name, description, parameters }) => ({
  name,
  description,
  parameters,
}));
const content = (turn: number) => [
  { type: "text" as const, text: resultText(turn) },
];

const modes = {
  baseline: {},
  oldResultsCap: { trimToolResults: true },
  compactSchema: { compactToolDefinitions: true },
} satisfies Record<string, ProviderDependencies["savings"]>;
type Mode = keyof typeof modes;
type Replay = {
  instructions?: string;
  transcript: {
    role: string;
    toolCallId?: string;
    toolName?: string;
    content: unknown;
    isError?: boolean;
  }[];
  tools: { name: string }[];
};
const utf8 = (value: string) => Buffer.byteLength(value, "utf8");
const jsonBytes = (value: unknown) => utf8(JSON.stringify(value) ?? "");

async function measure(mode: Mode) {
  const metrics: SendMetrics[] = [];
  const observed: SendMetrics[] = [];
  const preservation: boolean[] = [];
  const toolDefinitionsMatch: boolean[] = [];
  const expectedReplayTools =
    mode === "compactSchema"
      ? tools.map(({ name }) => ({ name }))
      : toolDefinitions;
  const checkResults = (replay: Replay, turn: number, followUp: boolean) => {
    const results = replay.transcript.filter(
      ({ role }) => role === "toolResult",
    );
    return (
      results.length === turn + Number(followUp) &&
      results.every((result, index) => {
        if (
          result.toolCallId !== callId(index) ||
          result.toolName !== tools[0]!.name ||
          result.isError !== (index === errorTurn)
        )
          return false;
        if (mode !== "oldResultsCap" || index === turn || index === errorTurn)
          return isDeepStrictEqual(result.content, content(index));
        const text = (result.content as { text: string }[])[0]?.text;
        return (
          typeof text === "string" &&
          text.includes("historical tool output omitted") &&
          text.startsWith(`先${index}:`) &&
          text.endsWith(":末") &&
          !text.includes("�") &&
          utf8(text) <= 8192
        );
      })
    );
  };

  await withOfflinePiSession(
    "pi-cursor-p2-",
    {
      savings: modes[mode],
      measurePayload: true,
      listModels: async () => [],
      login: async () => {
        throw new Error("Offline benchmark cannot log in");
      },
      complete: (request) =>
        runCompletion(request, {
          noteSend: (event) => {
            metrics.push(event);
          },
          async createAgent(options) {
            const registered = options.local?.customTools ?? {};
            return {
              async send(prompt, opts) {
                const turn = Math.floor(observed.length / 2);
                const followUp = observed.length % 2 === 1;
                const newline = prompt.indexOf("\n");
                const json = prompt.slice(0, newline);
                const replay = JSON.parse(json) as Replay;
                const instructionsBytes = jsonBytes(replay.instructions);
                const promptToolsBytes = jsonBytes(replay.tools);
                const historyBytes = replay.transcript
                  .filter(({ role }) => role !== "toolResult")
                  .reduce((sum, msg) => sum + jsonBytes(msg), 0);
                const toolResultsBytes = replay.transcript
                  .filter(({ role }) => role === "toolResult")
                  .reduce((sum, msg) => sum + jsonBytes(msg), 0);
                observed.push({
                  promptBytes: utf8(prompt),
                  promptBreakdown: {
                    instructionsBytes,
                    historyBytes,
                    toolResultsBytes,
                    promptToolsBytes,
                    harnessNotesBytes: utf8(prompt.slice(newline + 1)),
                    framingBytes:
                      utf8(json) +
                      1 -
                      instructionsBytes -
                      historyBytes -
                      toolResultsBytes -
                      promptToolsBytes,
                  },
                  sdkCustomToolsJsonBytes: jsonBytes(registered),
                  toolCount: Object.keys(registered).length,
                });
                preservation.push(checkResults(replay, turn, followUp));
                toolDefinitionsMatch.push(
                  isDeepStrictEqual(replay.tools, expectedReplayTools) &&
                    toolDefinitions.every(
                      ({ name, description, parameters }, index) => {
                        const tool = registered[`pi_tool_${index}`];
                        return (
                          tool?.description === `${name}: ${description}` &&
                          isDeepStrictEqual(tool.inputSchema, parameters)
                        );
                      },
                    ),
                );

                let status: BridgeRun["status"] = followUp
                  ? "finished"
                  : "running";
                if (!followUp) {
                  const id = callId(turn);
                  const tool = registered.pi_tool_0;
                  if (!tool)
                    throw new Error("Missing synthetic tool registration");
                  void Promise.resolve(
                    tool.execute({ turn }, { toolCallId: id }),
                  ).catch(() => {});
                  await opts?.onDelta?.({
                    update: {
                      type: "tool-call-started",
                      callId: id,
                      modelCallId: id,
                      toolCall: { type: "shell", args: { command: "true" } },
                    },
                  });
                }
                const run: BridgeRun = {
                  get status() {
                    return status;
                  },
                  async cancel() {
                    status = "cancelled";
                  },
                  async wait() {
                    if (!followUp) return new Promise<never>(() => {});
                    return {
                      id: callId(turn),
                      status: "finished",
                      result: "完了🙂".repeat(500),
                    };
                  },
                  usage: undefined,
                  async *stream() {},
                };
                return run;
              },
              async [Symbol.asyncDispose]() {},
            };
          },
        }),
    },
    async ({ directory, runtime }) => {
      // The shared fixture supplies the isolated runtime; this session needs custom tools.
      const settings = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "合成ケース。",
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRuntime: runtime,
        model: runtime.getModel("cursor-sdk", "auto")!,
        thinkingLevel: "off",
        noTools: "builtin",
        tools: tools.map(({ name }) => name),
        customTools: tools,
        settingsManager: settings,
        resourceLoader,
        sessionManager: SessionManager.inMemory(directory),
      });
      try {
        for (const turn of turns) {
          await session.prompt(`手順${turn}: ${"合成会話🙂".repeat(500)}`);
          expect(session.messages.at(-1)).toMatchObject({
            role: "assistant",
            stopReason: "stop",
          });
        }
        const retained = session.messages.filter(
          (message): message is ToolResultMessage =>
            message.role === "toolResult",
        );
        expect(retained).toHaveLength(turns.length);
        expect(
          retained.every(
            (result, index) =>
              result.toolCallId === callId(index) &&
              result.isError === (index === errorTurn) &&
              isDeepStrictEqual(result.content, content(index)),
          ),
        ).toBe(true);
      } finally {
        session.dispose();
      }
    },
  );
  expect(observed).toHaveLength(turns.length * 2);
  expect(metrics).toHaveLength(observed.length);
  expect(metrics).toEqual(observed);
  expect(preservation, `${mode}: tool result preservation`).toEqual(
    observed.map(() => true),
  );
  expect(toolDefinitionsMatch, `${mode}: replay and registered tools`).toEqual(
    observed.map(() => true),
  );
  expect(metrics.every(({ toolCount }) => toolCount === tools.length)).toBe(
    true,
  );
  const totals = {
    attempts: metrics.length,
    promptBytes: 0,
    historyBytes: 0,
    toolResultsBytes: 0,
    promptToolsBytes: 0,
    sdkCustomToolsJsonBytes: 0,
  };
  for (const event of metrics) {
    totals.promptBytes += event.promptBytes;
    totals.historyBytes += event.promptBreakdown!.historyBytes;
    totals.toolResultsBytes += event.promptBreakdown!.toolResultsBytes;
    totals.promptToolsBytes += event.promptBreakdown!.promptToolsBytes;
    totals.sdkCustomToolsJsonBytes += event.sdkCustomToolsJsonBytes;
  }
  return totals;
}

it("benchmarks independent replay savings at the offline SDK send boundary", async () => {
  const baseline = await measure("baseline");
  const oldResultsCap = await measure("oldResultsCap");
  const compactSchema = await measure("compactSchema");
  const saved = (variant: typeof baseline) =>
    baseline.promptBytes - variant.promptBytes;
  expect(saved(oldResultsCap)).toBeGreaterThan(0);
  expect(saved(compactSchema)).toBeGreaterThan(0);
  expect(oldResultsCap).toEqual({
    ...baseline,
    promptBytes: baseline.promptBytes - saved(oldResultsCap),
    toolResultsBytes: baseline.toolResultsBytes - saved(oldResultsCap),
  });
  expect(compactSchema).toEqual({
    ...baseline,
    promptBytes: baseline.promptBytes - saved(compactSchema),
    promptToolsBytes: baseline.promptToolsBytes - saved(compactSchema),
  });
  if (process.env.P2_SAVINGS_REPORT === "1") {
    const report = (variant: typeof baseline) => ({
      ...variant,
      savedPromptBytes: saved(variant),
      savedPromptPercent: Number(
        ((100 * saved(variant)) / baseline.promptBytes).toFixed(2),
      ),
    });
    console.info(
      `P2_SAVINGS ${JSON.stringify({ baseline: report(baseline), oldResultsCap: report(oldResultsCap), compactSchema: report(compactSchema) })}`,
    );
  }
});
