# P2: Offline prompt payload comparison

Run this from the repository after installing its dependencies:

```sh
P2_SAVINGS_REPORT=1 npm test -- --reporter=verbose tests/savings-benchmark.test.ts
```

The `P2_SAVINGS` line contains only aggregate values as JSON. The test does not print it unless `P2_SAVINGS_REPORT` is set to `1`.

The benchmark uses a real Pi session and bridge, replacing only the Cursor SDK Agent with a test double. The fixture has six user turns. Each turn makes a predetermined tool call and then responds to its result. The fixture includes five long successful results, one error result, and eight tools with long descriptions and schemas. The history includes Japanese text, emoji, and characters that require JSON escaping. Pi retries and auto-compaction are disabled. The benchmark compares each option independently against the baseline: clipping old successful results (`oldResultsCap`) and reducing in-prompt tool definitions to names (`compactSchema`).

- `attempts`: calls to the fake Agent's `send()`, matched one-to-one with the bridge's measurement events.
- `promptBytes`: total UTF-8 bytes of prompts passed to `send()`. `historyBytes`, `toolResultsBytes`, and `promptToolsBytes` measure selected parts of the prompts.
- `sdkCustomToolsJsonBytes`: total UTF-8 bytes of the serialized SDK custom tool registrations across attempts. This is measured separately from prompts and is not network traffic.
- `savedPromptBytes` / `savedPromptPercent`: the reduction in prompt bytes and the percentage saved relative to the baseline.

For each send, the test verifies that the current result and error results remain intact, and that other results not eligible for clipping, Pi's original history, and the SDK tool registrations are unchanged. The report contains no prompt or result text, tool arguments, or keys. No live inference is performed; model quality, time to first text, SDK-reported usage, and billing are not measured.
