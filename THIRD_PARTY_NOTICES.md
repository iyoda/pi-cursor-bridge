# Third-party notices

The original provider and adapter code in this project is licensed under MIT.
That license does not relicense dependencies or grant rights to Cursor services.

## Official Cursor SDK

This project depends on the separately installed npm package `@cursor/sdk@1.3.1`.
The build leaves `@cursor/sdk` external: SDK source and platform binaries are not
copied into this project's `dist/` or included in its npm tarball.

The SDK's published `LICENSE.md` says:

> © Anysphere Inc. All rights reserved. Use is subject to Cursor's Terms of Service.

- SDK documentation: https://cursor.com/docs/sdk/typescript
- Terms: https://cursor.com/terms-of-service
- Package: https://www.npmjs.com/package/@cursor/sdk

Users install the SDK through npm and use it under Cursor's own terms. Review
those terms before redistributing an application that embeds the SDK. This
project is an independent integration, not a Cursor-endorsed product.

Other dependencies retain their respective license notices in their packages.
