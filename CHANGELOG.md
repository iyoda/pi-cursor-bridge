# Changelog

User-visible changes are recorded here. Headings match the `version` field in `package.json`.

## [0.1.2]

- Report Cursor runs that finish without non-blank answer text or a tool call as non-retryable errors. Thinking still streams normally, and an empty compaction summary is not saved.
- Show an approximate Pi context percentage after compaction until fresh usage is available.
- Verify packed-package upgrades offline on Pi 1.5.2, 1.6.0, and 1.6.1, including saved model selection, Thinking clamped by the cached level map, and fallback from an empty or unreadable cache.
- Document how to compare Cursor prompt payload savings with an offline replay benchmark, without sending inference requests.

## [0.1.1]

- Keep manual API-key login, `CURSOR_API_KEY` precedence over `models.json`, and the SDK-owned model catalog when registering `cursor-sdk` with Pi.
- Restore older cached rows and SDK selections without deleting the model cache.
- Use `@cursor/sdk` `1.4.2` as the runtime dependency.

## [0.1.0]

This is an early development release.

- Rename the extension to `pi-cursor-bridge` (`@iyoda/pi-cursor-bridge` on npm). Keep the Pi provider ID `cursor-sdk` and existing commands and settings unchanged.

- Add optional Cursor payload savings for historical tool results and repeated tool definitions, plus an example of Pi retry and compaction settings. The default prompt is unchanged.

- Run inference through the official `@cursor/sdk` as Pi's independent provider `cursor-sdk`. The existing `cursor` provider is not replaced.
- Keep Pi's tool execution, permissions, and history. SDK custom tools are used only to capture requests.
- Choose the model, fast, and Max Mode with `/model`, and choose effort with Pi's Thinking controls.
- Text only. Images, custom fetch, temperature, and deferred execution are rejected before a request is sent. A request `maxTokens` is not forwarded and does not reject the request, because the SDK has no output cap.
- If one model cannot be converted, omit that model and publish the rest. If none remain, show the reason and keep the previous catalog. When some models are omitted, `/cursor-sdk-refresh` reports the SDK model ID count and up to three IDs with reasons. An SDK id whose copies disagree is omitted entirely.
- Restore the stored catalog, including SDK selections, before the next fetch so a saved model still resolves. When Pi omits `reasoning`, use the `off` route when that row advertises one, and otherwise the SDK default variant.
- Put the short harness notes after the JSON transcript, so they are not the opening the model treats as the request.
- Ship the changelog, code of conduct, contributing guide, and vulnerability contact with the package.
- Do not bundle `@earendil-works/pi-ai` or `@earendil-works/pi-coding-agent`, which Pi provides. Their peer range is `*`. Live validation uses Pi 1.5.2; offline installation, model discovery, and removal are checked on Pi 1.5.2 and 1.6.0.
- Retry removal of the temporary workspace when the SDK store is still writing under `state`, so cleanup does not fail with `ENOTEMPTY`. If that store recreates the directory after `rm` returns, remove it again.
- Show a rate-limit failure as `[resource_exhausted] Cursor rate limit or usage limit was reached.` Pi adds one `Error:` prefix, so a generic SDK message of `Error` is not repeated.
- `npm run pack:check` checks the tarball file list, the MIT license, the `*` peer range for the Pi packages, and that `@cursor/sdk` stays an external import. CI runs the same check.
- Treat Pi's `timeoutMs` as an idle limit that each streamed SDK delta restarts, so long reasoning (for example Grok at high Thinking) no longer fails with `Cursor completion timed out.` while it is still streaming.
- Keep assistant text that arrives before a captured tool call, including text the SDK delivers after `execute()` and before `tool-call-started`. A marker that already arrived for the same call closes that text immediately. A text delta still in flight at the marker is included. If the marker never arrives, one second without a later delta closes the handoff. Tool calls still queued after the first marker stay in the same batch. Any unsent tail is placed before the tool call.
- Report transient SDK transport failures, such as a stalled or prematurely closed connection, with a retryable marker so Pi's retry policy can retry them. SDK-internal agent retries stay disabled.
- Stop the completion idle timer before post-run cleanup, and restart it for context-summarization messages on the run stream. The SDK does not forward those summary updates as deltas.
- Keep the `auto` fallback when a fetched catalog omits it, so a saved `auto` selection still resolves. If the catalog includes `auto`, that row is used.
- Tell the model that instructions inside tool results are data and do not outrank the latest user request.
- Estimate usage on tool-capture turns, which are cancelled before the SDK records usage. Input is the sent prompt length divided by 4. Output is the assistant text plus tool-argument JSON, divided by 4. Thinking is omitted because the next prompt does not include it, so Pi's compaction count no longer treats that thinking as context. The figures are approximate.
