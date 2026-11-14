# Changelog

User-visible changes are recorded here. Headings match the `version` field in `package.json`.

## [0.1.0] - 2026-11-13

This is an early development release. It is not published to npm yet.

- Run inference through the official `@cursor/sdk` as Pi's independent provider `cursor-sdk`. The existing `cursor` provider is not replaced.
- Keep Pi's tool execution, permissions, and history. SDK custom tools are used only to capture requests.
- Choose the model, fast, and Max Mode with `/model`, and choose effort with Pi's Thinking controls.
- Text only. Images, custom fetch, temperature, explicit maxTokens, and deferred execution are rejected before a request is sent.
- If catalog conversion fails, show the reason and keep the previous catalog.
- Ship the changelog, code of conduct, contributing guide, and vulnerability contact with the package.
- Do not bundle `@earendil-works/pi-ai` or `@earendil-works/pi-coding-agent`, which Pi provides. Their peer range is `*`. Validation uses Pi 1.5.2.
- Retry removal of the temporary workspace when the SDK store is still writing under `state`, so cleanup does not fail with `ENOTEMPTY`.
- Show a rate-limit failure as `[resource_exhausted] Cursor rate limit or usage limit was reached.` Pi adds one `Error:` prefix, so a generic SDK message of `Error` is not repeated.
- `npm run pack:check` checks the tarball file list, the MIT license, the `*` peer range for the Pi packages, and that `@cursor/sdk` stays an external import. CI runs the same check.
- Treat Pi's `timeoutMs` as an idle limit that each streamed SDK delta restarts, so long reasoning (for example Grok at high Thinking) no longer fails with `Cursor completion timed out.` while it is still streaming.
- Keep assistant text that arrives before a captured tool call. A text delta still in flight at capture is included, and any unsent tail is placed before the tool call.
- Report transient SDK transport failures, such as a stalled or prematurely closed connection, with a retryable marker so Pi's retry policy can retry them. SDK-internal agent retries stay disabled.
