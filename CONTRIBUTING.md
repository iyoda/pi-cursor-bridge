# Contributing

Before reporting a bug or proposing a change, read the README and the [changelog](CHANGELOG.md).
Follow the [code of conduct](CODE_OF_CONDUCT.md).
Use the repository issue templates for bugs and proposals.
In a pull request, keep the checklist from the included template.
Do not publish vulnerabilities. Use the contact in [SECURITY.md](SECURITY.md).

## Setup

Node.js 22.19 or later is required. Development uses Pi 1.5.2; the offline installation check also covers Pi 1.6.0. From the repository root:

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` runs the type check, formatting check, tests, and build together.
Tests replace the SDK boundary with fakes and do not use the network, billing, login, or real file tools.

The procedure for trying inference with a real account is the [live validation checklist](docs/live-validation.md).
Do not share API keys, conversation logs, or temporary workspaces.

## Changes

- Add user-visible changes to the current version in [CHANGELOG.md](CHANGELOG.md).
- Formatting uses Prettier defaults. `npm run format` applies them.
- `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are provided by Pi. Do not add them to `dependencies`.
- Do not vendor `@cursor/sdk`. Keep it external in the build.
- Run `npm run pack:check` before publishing. It checks the tarball file list, the MIT license, the `*` peer range, and that `@cursor/sdk` stays external.
- `npm run pack:check` writes its tarball under `.pack/` without deleting other archives. Run `npm run install:check -- ./.pack/iyoda-pi-cursor-bridge-0.1.0.tgz` on the generated tarball (use the path printed by the check if the version changes). This installs into a temporary project, checks Pi's package discovery and removal, and does not use real credentials or run inference. npm may contact the registry to resolve dependencies. Append `1.6.0` to run it against Pi 1.6.0 instead of the development version.

Do not commit secrets, auth files, or `.env` files.
