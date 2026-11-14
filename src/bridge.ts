import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLocalAgentStore } from "@cursor/sdk";
import {
  abortAfter,
  COMPLETION_TIMEOUT_ERROR,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_COMPLETION_TIMEOUT_MS,
  formatFailure,
  untilAborted,
  validateTimeout,
} from "./async.js";
import type {
  AgentOptions,
  SDKAgent,
  Run,
  ModelSelection,
  SDKCustomTool,
  TokenUsage,
} from "@cursor/sdk";
import type { Tool } from "@earendil-works/pi-ai";

export interface CompletionRequest {
  apiKey: string;
  model: ModelSelection;
  prompt: string;
  tools: Tool[];
  signal?: AbortSignal;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  onDelta?: NonNullable<Parameters<SDKAgent["send"]>[1]>["onDelta"];
  /** Restarts the caller's idle timer. Summary updates are not forwarded through onDelta. */
  refreshIdle?: () => void;
  /** Stops the caller's idle timer before post-run cleanup. */
  releaseIdle?: () => void;
}
export type BridgeRun = Pick<
  Run,
  "wait" | "cancel" | "status" | "usage" | "stream"
>;
export interface BridgeAgent {
  send(
    message: string,
    options?: Parameters<SDKAgent["send"]>[1],
  ): Promise<BridgeRun>;
  [Symbol.asyncDispose](): Promise<void>;
}
export interface CompletionDependencies {
  createAgent(options: AgentOptions): Promise<BridgeAgent>;
}
export interface CapturedCall {
  id: string;
  name: string;
  arguments: Record<string, import("@cursor/sdk").SDKJsonValue>;
}
export interface CompletionResult {
  calls: CapturedCall[];
  text?: string;
  usage?: TokenUsage;
}
export async function runCompletion(
  request: CompletionRequest,
  deps: CompletionDependencies,
): Promise<CompletionResult> {
  request.signal?.throwIfAborted();
  const timeoutMs = request.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
  const cleanupMs = request.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  validateTimeout(timeoutMs);
  validateTimeout(cleanupMs);
  const deadline = abortAfter(
    timeoutMs,
    COMPLETION_TIMEOUT_ERROR,
    request.signal,
  );
  const { signal } = deadline;
  let workspace: string | undefined;
  let agent: BridgeAgent | undefined;
  let run: BridgeRun | undefined;
  let finished = false;
  let accepting = true;
  let cleanupDeferred = false;
  let disposal: Promise<void> | undefined;
  const calls: CapturedCall[] = [];
  const releases: (() => void)[] = [];
  const deltaWaiters: (() => void)[] = [];
  let preamble = "";
  let pendingDeltas = 0;
  let drainScheduled = false;
  let captured!: () => void;
  const handoff = new Promise<undefined>((resolve) => {
    captured = () => resolve(undefined);
  });
  try {
    workspace = await acquire(
      mkdtemp(join(tmpdir(), "pi-cursor-sdk-")),
      (lateWorkspace) => deleteWorkspace(lateWorkspace),
    );
    signal.throwIfAborted();
    const customTools: Record<string, SDKCustomTool> = Object.fromEntries(
      request.tools.map((tool, index) => [
        `pi_tool_${index}`,
        {
          description: `${tool.name}: ${tool.description}`,
          inputSchema: JSON.parse(JSON.stringify(tool.parameters)),
          execute(
            args: CapturedCall["arguments"],
            context: { toolCallId?: string },
          ) {
            if (!accepting || signal.aborted)
              return Promise.reject(new Error("Cursor run is closed."));
            calls.push({
              id: context.toolCallId ?? `pi-sdk-${calls.length}`,
              name: tool.name,
              arguments: args,
            });
            if (!drainScheduled) {
              drainScheduled = true;
              void textBeforeTools().catch(() => captured());
            }
            return new Promise<never>((_resolve, reject) => {
              releases.push(() =>
                reject(
                  new Error("Execution delegated to Pi; SDK run cancelled."),
                ),
              );
            });
          },
        },
      ]),
    );
    signal.throwIfAborted();
    const creation = deps.createAgent({
      apiKey: request.apiKey,
      model: request.model,
      tools: request.tools.length ? ["mcp"] : [],
      mcpServers: {},
      agents: {},
      local: {
        cwd: workspace,
        settingSources: [],
        enableAgentRetries: false,
        customTools,
        store: new JsonlLocalAgentStore(join(workspace, "state")),
      },
    });
    agent = await acquire(creation, (lateAgent) => cleanup(lateAgent));
    signal.throwIfAborted();
    const sending = agent.send(request.prompt, {
      onDelta: (event) => {
        pendingDeltas += 1;
        const delivery = (async () => {
          try {
            if (!accepting || signal.aborted) return;
            deadline.refresh();
            await request.onDelta?.(event);
            if (event.update.type === "text-delta") {
              preamble += event.update.text;
            }
          } finally {
            pendingDeltas -= 1;
            if (pendingDeltas === 0) {
              for (const waiter of deltaWaiters.splice(0)) waiter();
            }
          }
        })();
        return delivery;
      },
    });
    const owner = agent;
    const active = await acquire(sending, (lateRun) => cleanup(owner, lateRun));
    run = active;
    observeSummaries(active);
    const result = await untilAborted(
      Promise.race([run.wait(), handoff]),
      signal,
    );
    signal.throwIfAborted();
    if (calls.length) {
      await untilAborted(handoff, signal);
      signal.throwIfAborted();
    } else {
      finished = true;
      if (result?.status !== "finished")
        throw new Error(
          formatFailure(result?.error, "Cursor run did not finish."),
        );
      return { calls: [], text: result.result, usage: result.usage };
    }
  } finally {
    deadline.clear();
    accepting = false;
    try {
      request.releaseIdle?.();
    } catch {
      // The caller's idle release must not skip workspace cleanup.
    }
    if (!cleanupDeferred || agent) await cleanup(agent, run, !cleanupDeferred);
  }
  if (!run || run.status !== "cancelled") {
    throw new Error(`not confirmed cancelled (status: ${run?.status})`);
  }
  return {
    calls: [...calls],
    ...(preamble ? { text: preamble } : {}),
    usage: run.usage,
  };

  function observeSummaries(active: BridgeRun): void {
    // onDelta does not receive summary updates. The run stream keeps the
    // idle limit alive during context summarization.
    void (async () => {
      try {
        for await (const message of active.stream()) {
          if (!accepting || signal.aborted) return;
          if (message.type !== "summary") continue;
          deadline.refresh();
          try {
            request.refreshIdle?.();
          } catch {
            // Caller idle refresh must not stop summary observation.
          }
        }
      } catch {
        // Observation must not change the completion result.
      }
    })();
  }

  async function textBeforeTools(): Promise<void> {
    // Tool execution and text delivery run concurrently. Yield once so a
    // preamble delta already queued beside execute() can enter onDelta,
    // then wait for that delivery. Later text belongs to the cancelled run.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    while (pendingDeltas > 0) {
      await new Promise<void>((resolve) => {
        deltaWaiters.push(resolve);
        if (pendingDeltas === 0) resolve();
      });
    }
    captured();
  }

  async function acquire<T>(
    operation: Promise<T>,
    onLate: (value: T) => Promise<void>,
  ): Promise<T> {
    try {
      return await untilAborted(operation, signal);
    } catch (error) {
      if (signal.aborted) {
        cleanupDeferred = true;
        void operation
          .then(onLate, () => cleanup(agent))
          .catch(() => {
            // Late cleanup failure retains the private workspace; no tool calls escape.
          });
      }
      throw error;
    }
  }

  async function cleanup(
    owner?: BridgeAgent,
    activeRun?: BridgeRun,
    removeWorkspace = true,
  ): Promise<void> {
    const errors: unknown[] = [];
    if (activeRun && !finished) {
      try {
        const cancellation = activeRun.cancel();
        for (const release of releases) release();
        await bounded(cancellation, cleanupMs);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const release of releases) release();
    if (owner) {
      try {
        disposal ??= bounded(
          Promise.resolve().then(() => owner[Symbol.asyncDispose]()),
          cleanupMs,
        );
        await disposal;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `SDK cleanup failed (workspace retained at ${workspace}): ${errors.map(String).join("; ")}`,
      );
    if (removeWorkspace && workspace) await deleteWorkspace(workspace);
  }
}

const workspaceRemoval = {
  recursive: true,
  force: true,
  // The SDK store can write state/*.ndjson again while rmdir is in progress.
  maxRetries: 5,
  retryDelay: 20,
} as const;

// Captured at load so replacing global setTimeout cannot leave a retry pending.
const realSetTimeout = setTimeout;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

async function deleteWorkspace(path: string): Promise<void> {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      await rm(path, { ...workspaceRemoval });
      return;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      const retryable =
        code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!retryable || attempt >= 20 || Date.now() - started >= 1_000) {
        throw error;
      }
      attempt += 1;
      await delay(Math.min(50 * attempt, 200));
    }
  }
}

async function bounded<T>(operation: Promise<T>, ms: number): Promise<T> {
  const deadline = abortAfter(ms, "SDK cleanup timed out.");
  try {
    return await untilAborted(operation, deadline.signal);
  } finally {
    deadline.clear();
  }
}
