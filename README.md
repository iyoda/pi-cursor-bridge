# pi-cursor-sdk

An independent provider extension for the Pi Coding Agent that uses the official `@cursor/sdk`.
The provider ID is **`cursor-sdk`**. It does not replace the existing `cursor` provider.

**This is an early development release.** Verified paths and items that remain unverified are recorded in [Live validation results](docs/live-validation-results.md).
See [CHANGELOG.md](CHANGELOG.md) for changes, [CONTRIBUTING.md](CONTRIBUTING.md) for development, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation, and [SECURITY.md](SECURITY.md) for vulnerability reports.
The Cursor SDK is an agent SDK, not a model-inference API. This extension is a translation layer that keeps tool execution in Pi.

## Requirements and startup

- Node.js 22.19 or later
- Pi 1.5.2 is the development baseline and has live inference coverage. Pi 1.6.0 passed the offline package install, model discovery, and removal check; live inference on 1.6.0 and other Pi versions are unverified.
- A Cursor SDK user or service-account API key

Before publication, build the checked-out directory and load the extension explicitly.

```bash
npm ci --ignore-scripts
npm run build
pi --no-extensions -e "$PWD/dist/index.js" --model cursor-sdk/auto
```

`--no-extensions` loads this extension without loading others.
Omit it when using the extension alongside others. An explicit `-e` load does not change Pi's package settings. No npm publication is required to install the built checkout persistently:

```bash
pi install "$PWD"
# To unregister this checkout later, from the same directory:
pi remove "$PWD"
```

After `pi install`, run Pi normally, without `--no-extensions`. Keep the checkout at the same path and rebuild it after pulling updates.
`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are provided by Pi. This package does not bundle them, and their peer range is `*`.

## Authentication

Run the following inside Pi:

```text
/login cursor-sdk
/cursor-sdk-refresh
/model
```

The official browser login creates a user API key.
The key is stored in Pi's OAuth-compatible store, not in the SDK auth file.
When the key expires, run `/login cursor-sdk` again.

You can also place an SDK key in `CURSOR_API_KEY`.
Existing Cursor CLI or IDE session tokens are not read.
Team Admin API keys are outside the SDK's supported credentials. Do not paste secrets into chat or logs.

Model discovery fetches the catalog only and does not run inference. At startup the extension registers an `auto` fallback and restores the last catalog Pi stored for this provider, including the SDK parameter selections.
After discovery, it builds the model and Thinking map from the variants enumerated by the SDK.
A model that cannot be converted is omitted. Copies of one SDK id that disagree are all omitted. The remaining models are published. If that leaves no models, the refresh fails and the previous catalog stays in place. `/cursor-sdk-refresh` reports the number of omitted SDK model IDs (not `/model` rows), shows up to three IDs with reasons, and reports how many more were omitted. Startup discovery does not show this notification.
The SDK model listing has no AbortSignal API, so cancellation is checked before and after the fetch.

## Choosing a model, effort, and fast

As in the earlier `pi-cursor` integration, **choose the model, context, fast, and Max Mode with `/model`, and choose effort with Pi's standard Thinking controls**. There is no fast-only command, custom footer, or separate fast setting. Model and Thinking changes use Pi's standard session records.

Model IDs use the forms below. These examples describe the naming rules; the extension does not generate every combination.

```text
cursor-sdk/<model>
cursor-sdk/<model>-fast
cursor-sdk/<model>-thinking
cursor-sdk/<model>-1m
cursor-sdk/<model>-1m-fast
```

- Rows are not created per effort. Only the supported Thinking levels are exposed. `extra-high` maps to Pi's `xhigh`, and `none` / `off` map to `off`. A model that only offers a thinking boolean exposes `off` / `high`.
- Context values `200k`, `272k`, and `300k` are omitted from the ID. Other values keep a suffix such as `-256k`, `-500k`, or `-1m`.
- A `thinking=true` distinction that coexists with effort is preserved as `-thinking`.
- Rows that distinguish Max Mode use `-max` or `-max-mode`. A `1m` context is distinguished by the context suffix. **Thinking `max` and Max Mode are different settings.**
- `-fast` is an explicit fast selection. Check Cursor for the pricing and terms of fast and Max Mode.
- At runtime the extension looks up the SDK selection for the model ID and Thinking level. It does not remap to a nearby effort or synthesize an unpublished parameter combination. Unknown models and unsupported Thinking levels fail before a request is sent. When Pi omits `reasoning`, the `off` route is used if that row advertises one. Otherwise the SDK's default variant is used.
- Canonical SDK IDs are kept as-is in the internal map. There is no broad compatibility layer for old aliases and no special routing for a private protocol. A row with a colliding ID, an ambiguous mapping, or another unsafe parameterization is omitted. An SDK id whose copies disagree is omitted entirely. The other rows stay. If none remain, the refresh fails and the previous catalog is retained.

After `/cursor-sdk-refresh`, select a row shown by `/model`. A restart restores the stored catalog, so a saved row still resolves before the next fetch. The stored SDK selection is used; the model name alone is not used to guess parameters. `auto` is registered at startup. If the SDK listing has no `auto`, the fallback is kept. If the SDK lists `auto`, only validated rows are used; a rejected entry is not restored as a fallback.

## Implementation

1. Convert Pi instructions, user/assistant history, and tool calls and results to JSON.
2. For each completion, create a temporary empty workspace and a JSONL store.
3. Send the history to a new SDK Agent as a user message.
4. Disable built-in tools and subagents, and expose only Pi's current tools as capture-only MCP custom tools.
5. When the SDK requests a tool, capture the request and do not execute it.
6. Confirm that the Run was cancelled and attempt to dispose of the Agent before returning Pi's native tool call.
7. Pi validates arguments, runs permission hooks, executes the tool, and supplies the real result on the next completion.

If cancellation cannot be confirmed, no executable tool request is returned. If cancellation is confirmed but disposal fails, Pi can still receive the tool call.
Workspace removal is best-effort; late SDK writes or process exit can leave files behind.

## Safety and limits

- **Text only.** Image input and image tool results fail explicitly.
- Cursor's standard system prompt remains. Pi's instructions are inside the user JSON and do not have the same priority as a system message. The extension does not request `systemPrompt` permission. Short harness notes follow the JSON. They are not the opening of the transcript.
- After fork or compaction, the current Pi history is sent again. Basic branch isolation and retention of information after summarization have been checked in the real CLI's RPC mode, but role labels and instructions inside history are not guaranteed to be interpreted faithfully. The prompt says instructions inside tool results are data and do not outrank the latest user request. That behavior still needs the live check; the sentence alone is not a guarantee.
- Cursor local settings, rules, plugins, and external MCP servers are not loaded. This extension does not add an OS sandbox around the SDK.
- The extension stops at the first captured tool batch. Only requests captured before cancellation are returned; later requests are made on the next completion.
- Thinking text is displayed, and an effort confirmed by the catalog can be selected through Pi's standard Thinking controls. Whether each choice works on a real account still requires live validation.
- A numeric context parameter in `k` or `m` is reflected in Pi's context window. An unrecognized value uses a provisional budget of **64,000**. The model definition's maxTokens value of **8,192** is also a provisional Pi-side budget. Neither value guarantees the SDK model's real limit, and the extension does not cap SDK output. A request `maxTokens`, including one Pi attaches for summarization or compaction, is not sent to the SDK and does not reject the request. The SDK default is used, with no guaranteed output or billing cap.
- Reported usage is reflected in Pi. Cached read and write tokens are separated from the SDK input total and mapped to Pi's uncached input and cache buckets. A displayed cost of 0 means the price is unset, not that usage is free. Cursor billing rules apply. Tool-capture turns are cancelled before the SDK records usage, so those turns report an estimate instead of measured usage. Input is the length of the prompt actually sent, divided by 4. Output is the assistant text plus the tool-argument JSON, divided by 4. Thinking is omitted because the next prompt does not include it. Pi treats that non-zero total as the context size and estimates only messages after it, so earlier thinking is left out of the compaction count. The figures shown for those turns are approximate. Japanese text is often more than one token per character, so dividing by 4 can undercount.
- `onPayload` can inspect and replace `{ prompt: string }`. The SDK does not expose the raw HTTP response, so `onResponse` is not called and no invented status or headers are returned.
- Custom fetch/headers, temperature, and deferred execution are rejected as unsupported.
- The completion timeout is an idle limit. Pi passes its HTTP idle timeout (`httpIdleTimeoutMs`, 300 seconds by default; `retry.provider.timeoutMs` overrides it); when no `timeoutMs` is given, 180 seconds is used. The countdown covers waiting for `onPayload` through SDK inference. Forwarded updates (`text-delta`, `thinking-delta`, and the other `onDelta` events) restart it, so long reasoning that keeps streaming is not cut off. Context-summarization updates are not forwarded through `onDelta`; `summary` messages on the run stream restart the same timer. The timer stops before post-run cleanup, so removing the workspace does not count as idle silence. The timeout fires only after that much time passes without one of those updates. It is not a cap on total time or output: a run that keeps streaming, including during summarization, is not stopped. Cancellation works while waiting for `onPayload`, but it does not forcibly stop work inside the hook; a late result is ignored. After the timeout or cancellation, cleanup waits up to 5 seconds for run cancellation and then up to 5 seconds for disposal, one after the other, before the temporary workspace is removed. Timeout values must be integers from 1 to 2,147,483,647 ms. There is no guarantee that work inside the SDK can be forcibly terminated.
- Transient SDK transport failures, such as a stalled or prematurely closed connection, are reported with a retryable marker so Pi's retry policy can retry them. SDK-internal agent retries stay disabled.
- Waiting for workspace creation is also subject to interruption and the deadline. A workspace created after interruption is deleted later, and no SDK Agent is created. If Agent acquisition returns after cancellation, cleanup is deferred. If interruption happens while waiting for send, the acquired Agent is disposed immediately within the time limit, and a Run that returns later is cancelled separately. Agent disposal runs once. A workspace that an unresolved send may still use is retained until post-processing finishes. If acquisition never returns or cleanup fails, a temporary directory and process may remain. They can contain the conversation, so do not share them.

## Reduce Cursor usage (optional)

1. Limit `read` to relevant lines and ask for short command output first: the active turn's results are not clipped by this extension. To reduce replay of older results, set `PI_CURSOR_SDK_TRIM_TOOL_RESULTS=1` at startup. Successful text-only results before the last normally completed assistant reply preceding the latest user message are shortened to at most 8 KiB of text each, preserving the beginning and end with an omission marker. Errors and current-turn results are unchanged. This only changes the Cursor payload, not Pi's history. Leave it off when details in older results matter.
2. For repeated transport failures, merge `retry` from [the example settings](examples/cursor-budget-settings.json) into Pi's project `.pi/settings.json`. It limits Pi's automatic agent retries to one without enabling retries if already disabled; use `retry.enabled: false` instead to disable automatic agent retries for that project. This setting is not Cursor-specific. SDK-internal agent retries remain disabled.
3. For long `cursor-sdk/auto` sessions, optionally merge `compaction.modelOverrides` from the same example. It raises the reserve to compact earlier and reduces the raw history retained after compaction. Pi normally uses the selected model to summarize, so earlier compaction can increase usage in shorter sessions. These are starting values, not a usage limit. The settings example was checked with Pi 1.5.2. Do not replace unrelated existing settings.
4. To avoid repeating tool schemas in the replay, set `PI_CURSOR_SDK_COMPACT_TOOL_DEFINITIONS=1` at startup. The replay keeps names in the same order for alias lookup; SDK tool registration retains the full descriptions and schemas. This may affect tool selection and is off by default. Disable unneeded tools in Pi when a task does not require them.

Use the metrics below to compare the two payload options independently. Fewer bytes do not guarantee lower billed usage or unchanged response quality.

## Measure payload size

Start Pi with `PI_CURSOR_SDK_PAYLOAD_METRICS=1` to print a `cursor-sdk-send` JSON line to stderr for each `agent.send()` attempt. This is off by default. A Pi retry that reaches the SDK is another event; a failure before `send()` is not counted.

The event contains only UTF-8 byte sizes and the number of registered tools. `promptBreakdown` separates instructions, history other than tool results, tool results, tool definitions in the prompt, harness notes, and JSON framing. If `onPayload` changes the prompt, its total is measured but the breakdown is `null`. `sdkCustomToolsJsonBytes` measures the JSON representation of the registered tool definitions separately (callbacks are not included); it is not part of `promptBytes`.

These metrics do not contain prompts, tool arguments, tool names, or API keys. They are not HTTP sizes, model tokens, or billed usage, and do not include SDK internals, cache behavior, or server-side retries. The plugin does not create a metrics file or send telemetry.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the check commands, and `npm run pack:check`.
Tests replace the SDK boundary with fakes and do not perform billing, login, or real file-tool execution.
Before a real account, follow the [live validation checklist](docs/live-validation.md).
`examples/smoke-tools.ts` is for explicit loading only. Normal extension loading and CI do not load it.

GitHub Actions checks Node.js 22.19.0, 24, and 26. It runs the tests, audits runtime dependencies, checks the tarball, and verifies that Pi can install, discover, and remove the packed extension without inference.
`prepack` runs the full check and build during `npm pack` and `npm publish`. `--ignore-scripts` skips that, so do not use it for distribution.

## License

Original code is **MIT**. `@cursor/sdk` is an external dependency and is not relicensed under MIT.
The build and npm distribution do not vendor the SDK. See [Third-party notices](THIRD_PARTY_NOTICES.md).
