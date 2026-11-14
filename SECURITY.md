# Security

## Reporting

Do not publish vulnerability details. Send them to iyoda-github@atikoro.net.
Keep the details private until a fix is ready.

Include the affected version, the steps required to reproduce the issue, and the expected impact.
Do not send API keys, session tokens, auth files, conversation logs, or the contents of a temporary workspace.

## Handling secrets

Keep API keys in Pi's credential store or in `CURSOR_API_KEY`.
This extension does not read Cursor CLI or IDE session tokens.

An SDK temporary directory can contain the conversation.
If cleanup fails, treat a leftover `pi-cursor-sdk-*` directory as private. Do not share it, and delete it after inspection.

## Supported versions

Security fixes apply to the current `0.1.0` development release.
Node.js and Pi versions follow the [README requirements](README.md#requirements-and-startup).

## Dependencies

Original code is MIT. `@cursor/sdk` is not vendored, and Cursor's terms apply separately.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
