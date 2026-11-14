# Live validation results

## 2026-11-13: Single tool round trip

- Environment: Node.js 26.13.0 / Pi 1.5.2 / Cursor SDK 1.3.1
- Model selection: `cursor-sdk/auto` / Pi Thinking `off`
  - The concrete model Auto selected internally was not confirmed.
- Method: Connected an in-memory Pi SDK session to the real Cursor SDK.
  Used a temporary build of `src/provider.ts` and `src/bridge.ts`.
- Authentication: Loaded existing saved credentials into memory. No login, key issuance, or auth-file update.
- Working directory: A dedicated empty directory.
- Resources: Disabled discovery of extensions, skills, prompt templates, themes, and context files.
- Tools: Pi built-in tools were disabled. Only an in-memory `smoke_echo` that returns the fixed string `SMOKE_OK` was exposed.
- Limits: At most 2 inferences, 45 seconds per SDK call, and a 100-second overall abort timer.
  Pi retry and compaction were disabled. A second execution of the same tool was denied.

### Result: passed

| Check                        | Result                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| First SDK completion         | Captured 1 tool call                                               |
| Pi tool execution            | 1                                                                  |
| Second input                 | Confirmed that it contained `toolResult` and the actual `SMOKE_OK` |
| Second SDK completion        | No tool call                                                       |
| Final response               | `SMOKE_OK`                                                         |
| Final stopReason             | `stop`                                                             |
| SDK temporary workspaces     | Both removed                                                       |
| Validation program exit code | 0                                                                  |

Usage for the second SDK completion:

- inputTokens: 5,560
- outputTokens: 161
- cacheReadTokens: 1,792
- cacheWriteTokens: 0
- totalTokens: 5,721
- reasoningTokens: 157

Usage was not returned when the first tool was captured, so the figures above are neither the total for the whole validation nor a billing amount.
Pi Thinking `off` does not guarantee that the model Auto selects internally produces zero reasoning tokens.

### Unverified at the time of this validation

See the next section for the later CLI validation.

- A tool round trip that starts by loading the extension in the real CLI (this run went through the Pi SDK)
- Permission denial, parallel requests, and interrupting inference
- fork, compaction, and handling of instructions inside history
- Individual models selected from the catalog, and each Thinking level
- Live requests on the minimum supported Node.js version

One success does not guarantee these behaviors or compatibility across every model.
Credentials and raw conversation logs are not included in this record. The temporary validation program and logs were deleted after the run.

## 2026-11-13: Real CLI JSON / RPC mode

- Environment: Node.js 26.13.0 / Pi CLI 1.5.2 / Cursor SDK 1.3.1
- Model selection: `cursor-sdk/auto` / Thinking `off`
- Target: Started the real `pi` CLI as a child process.
  Loaded `dist/index.js` and `examples/smoke-tools.ts` with `-e`.
- Validated both a one-shot JSON-mode launch and continued operation in RPC mode.
  This did not call the SDK's `createAgentSession()` directly.
- Used a dedicated empty workspace and a temporary Pi settings directory.
  The existing key was passed to the child process through the environment. The auth file was not copied or updated.
- `--offline` stops catalog fetches and similar work at startup, but the validation inference was a live request.
  Disabled extension discovery, MCP, built-in tools, skills, prompt templates, themes, and context files.
- Pi automatic retry and automatic compaction were disabled.
  A temporary guard extension was set to interrupt the 4th turn, and the RPC driver also limited the total number of turns.
  Waiting for a response had a 65-second deadline, and the one-shot JSON launch had an 85-second deadline.
  The normal cases finished within 3 turns, and the guard did not stop a run.

### Result: all 7 items passed

| Item                                     | Operation and check                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI JSON tool round trip                 | 2 turns, 1 tool result, no error, final response `SMOKE_OK`, `stop`, exit code 0                                                                                                            |
| CLI RPC permission denial                | Requested the tool after `/smoke-deny`. 1 error tool result and 0 executions. Explained the denial, then `stop`, with no retry                                                              |
| CLI RPC two tool requests                | After `new_session`, requested the tool twice. 2 tool results, 2 executions, no error, final response `TWO_OK`. Finished in 3 turns, one call at a time                                     |
| CLI RPC interrupt inference              | Sent `abort` after receiving the first text or thinking delta. Final stop reason `aborted`, 0 tool results                                                                                  |
| CLI RPC request again after interruption | Requested again in the same session and confirmed `RECOVERY_OK` and `stop`                                                                                                                  |
| CLI RPC fork                             | Forked just before the second user message. The session ID changed, and the other branch's marker was absent from the current history. Returned only the original marker and `stop`         |
| CLI RPC compaction                       | The `compact` command generated a real summary. Confirmed that the compaction entry was recorded, and the following request returned the marker that was supposed to be retained and `stop` |

A temporary setting used `keepRecentTokens: 1` so that compaction would occur even in a small test conversation.
RPC conversation turns totaled 11. That is in addition to the 2 JSON turns and a summarization inference separate from the normal turns.
This is not a billing cap, and it does not guarantee how many times the SDK processes a request internally.

`pi-cursor-sdk-*` directories created after validation started and still present at the end-of-run temporary-area check: 0.
The CLI child process was stopped. Temporary settings, temporary sessions, the driver, and logs were deleted after validation.

### Still unverified

- Real key input in the interactive TUI (Escape, the `/fork` selection screen, the `/compact` display, and similar controls)
- Parallel tool calls in the same batch (this run executed the two requests one at a time)
- Live behavior when interrupting during tool execution, or when cleanup fails
- Evaluation of instructions inside history
- Live requests for individual models other than `auto`, for each Thinking level, and on the minimum supported Node.js

This success confirms the basic path for this environment and model selection. It is not a guarantee for every model or every session.
