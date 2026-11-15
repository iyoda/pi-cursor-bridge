import { accessSync, constants, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
/** Same chars/4 split Pi uses when a message has no reported usage. */
const ESTIMATED_CHARS_PER_TOKEN = 4;
/**
 * After execute(), close the preamble if tool-call-started never arrives and
 * no later delta starts. Each later delta restarts the wait. The same
 * deadline abandons a delta that never returns.
 */
const PREAMBLE_QUIET_MS = 1_000;

/**
 * Cancelled tool-capture runs never record SDK usage. Estimate the context
 * that will actually be sent next time: the prompt, the assistant text, and
 * tool-argument JSON. Thinking is not sent again, so it is not counted.
 * Pi treats a non-zero total as the context size and does not re-estimate
 * earlier messages, including their thinking text.
 */
function estimateCaptureUsage(
  prompt: string,
  text: string,
  calls: readonly CapturedCall[],
): TokenUsage {
  const argumentChars = calls.reduce(
    (total, call) => total + JSON.stringify(call.arguments).length,
    0,
  );
  const inputTokens = Math.ceil(prompt.length / ESTIMATED_CHARS_PER_TOKEN);
  const outputTokens = Math.ceil(
    (text.length + argumentChars) / ESTIMATED_CHARS_PER_TOKEN,
  );
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

/** Keep post-run cleanup attached when an earlier failure is the one rethrown. */
function attachCleanupCause(
  failure: unknown,
  cleanupFailure: unknown,
): unknown {
  if (
    cleanupFailure !== undefined &&
    failure instanceof Error &&
    failure.cause === undefined
  )
    failure.cause = cleanupFailure;
  return failure;
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
  const toolWaiters: (() => void)[] = [];
  let preamble = "";
  let pendingDeltas = 0;
  let drainScheduled = false;
  let preambleOpen = true;
  let armQuiet: () => void = () => {};
  let completed: CompletionResult | undefined;
  let failure: unknown;
  let cleanupFailure: unknown;
  let cancelFailed = false;
  let raced: { status?: string; error?: unknown } | undefined;
  let captured!: () => void;
  const handoff = new Promise<undefined>((resolve) => {
    captured = () => resolve(undefined);
  });
  try {
    workspace = await acquire(
      mkdtemp(join(tmpdir(), "pi-cursor-sdk-")),
      (lateWorkspace) => removePrivateWorkspace(lateWorkspace),
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
        const update = event.update;
        const include = preambleOpen;
        if (drainScheduled && update.type === "tool-call-started") {
          if (preambleOpen) {
            preambleOpen = false;
            // In-flight deltas keep a full quiet budget after the marker.
            armQuiet();
            for (const waiter of toolWaiters.splice(0)) waiter();
          }
        } else if (drainScheduled && preambleOpen) {
          armQuiet();
        }
        const delivery = (async () => {
          try {
            if (!accepting || signal.aborted || !include) return;
            deadline.refresh();
            await request.onDelta?.(event);
            if (update.type === "text-delta") preamble += update.text;
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
    if (result && typeof result === "object") raced = result;
    signal.throwIfAborted();
    if (calls.length) {
      await untilAborted(handoff, signal);
      signal.throwIfAborted();
    } else {
      finished = true;
      if (!result || result.status !== "finished")
        throw new Error(
          formatFailure(result?.error, "Cursor run did not finish."),
        );
      completed = { calls: [], text: result.result, usage: result.usage };
    }
  } catch (error) {
    failure = error;
  } finally {
    deadline.clear();
    accepting = false;
    try {
      request.releaseIdle?.();
    } catch {
      // The caller's idle release must not skip workspace cleanup.
    }
    try {
      if (!cleanupDeferred || agent)
        await cleanup(agent, run, !cleanupDeferred);
    } catch (error) {
      // A finished answer and a confirmed cancel outrank post-run cleanup.
      // A failed run keeps this error as its cause, including a retained workspace.
      cleanupFailure = error;
    }
  }
  if (failure) throw attachCleanupCause(failure, cleanupFailure);
  if (completed) return completed;
  if (cancelFailed) throw cleanupFailure ?? new Error("SDK cleanup failed");
  if (run?.status === "cancelled") {
    return {
      calls: [...calls],
      ...(preamble ? { text: preamble } : {}),
      usage: estimateCaptureUsage(request.prompt, preamble, calls),
    };
  }
  if (cleanupFailure) throw cleanupFailure;
  throw unconfirmedCancel(run, raced);

  function unconfirmedCancel(
    active: BridgeRun | undefined,
    observed: { status?: string; error?: unknown } | undefined,
  ): Error {
    const message = `not confirmed cancelled (status: ${active?.status})`;
    if (!observed?.status || observed.status === "cancelled")
      return new Error(message);
    const reason = observed.error
      ? formatFailure(observed.error)
      : `run reported ${observed.status}`;
    return new Error(`${message}: ${reason}`);
  }

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
    // execute() can run before the SDK flushes the text that precedes the
    // tool call. That text stays ahead of tool-call-started in the delta
    // stream, so keep accepting until the first marker after capture starts.
    // callId is not compared with toolCallId. One second without a later
    // delta, or a delta that never returns, closes the handoff anyway.
    // The marker restarts that second so a delta already in flight can finish.
    let quiet = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        quiet = true;
        preambleOpen = false;
        for (const waiter of toolWaiters.splice(0)) waiter();
        for (const waiter of deltaWaiters.splice(0)) waiter();
      }, PREAMBLE_QUIET_MS);
    };
    armQuiet = arm;
    arm();
    try {
      while (preambleOpen && !quiet) {
        await new Promise<void>((resolve) => {
          if (!preambleOpen || quiet) resolve();
          else toolWaiters.push(resolve);
        });
      }
      while (pendingDeltas > 0 && !quiet) {
        await new Promise<void>((resolve) => {
          deltaWaiters.push(resolve);
          if (pendingDeltas === 0 || quiet) resolve();
        });
      }
    } finally {
      clearTimeout(timer);
      armQuiet = () => {};
      preambleOpen = false;
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
        cancelFailed = true;
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
    // A failed cancel may still be using the workspace. Disposal timing out
    // after a finished or cancelled run still removes it.
    if (!cancelFailed && removeWorkspace && workspace) {
      try {
        await removePrivateWorkspace(workspace);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      const retained = cancelFailed
        ? ` (workspace retained at ${workspace})`
        : "";
      throw new AggregateError(
        errors,
        `SDK cleanup failed${retained}: ${errors.map(String).join("; ")}`,
      );
    }
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

/** Directory where the SDK writes the transcript for this temporary workspace. */
export function cursorProjectDir(workspace: string): string | undefined {
  const slug = workspace
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return undefined;
  const override = process.env.CURSOR_DATA_DIR?.trim();
  if (override) return join(override, "projects", slug);
  try {
    const home = homedir();
    if (!home.trim() || !statSync(home).isDirectory()) return undefined;
    accessSync(home, constants.W_OK);
    return join(home, ".cursor", "projects", slug);
  } catch {
    return undefined;
  }
}

async function removePrivateWorkspace(workspace: string): Promise<void> {
  const errors: unknown[] = [];
  try {
    await deleteWorkspace(workspace);
  } catch (error) {
    errors.push(error);
  }
  const transcript = cursorProjectDir(workspace);
  if (transcript && transcript !== workspace) {
    try {
      await deleteWorkspace(transcript);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `SDK workspace removal failed: ${errors.map(String).join("; ")}`,
    );
  }
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
