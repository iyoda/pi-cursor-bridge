import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const [archive, piVersion, ...extra] = process.argv.slice(2);
assert(
  archive &&
    extra.length === 0 &&
    (!piVersion || /^\d+\.\d+\.\d+$/.test(piVersion)),
  "Usage: npm run install:check -- <npm pack tarball> [Pi version]",
);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, data) => writeFileSync(path, JSON.stringify(data));
const manifest = readJson(new URL("../package.json", import.meta.url));
const expectedPi =
  piVersion ?? manifest.devDependencies["@earendil-works/pi-coding-agent"];
const published =
  "https://registry.npmjs.org/@iyoda/pi-cursor-bridge/-/pi-cursor-bridge-0.1.0.tgz";
const candidate = resolve(archive);
const root = mkdtempSync(join(tmpdir(), "pi-cursor-install-"));
try {
  const npm = process.env.npm_execpath;
  assert(npm, "Run through npm run install:check.");
  const install = (...specs) =>
    execFileSync(
      process.execPath,
      [
        npm,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        "--package-lock",
        ...specs,
      ],
      { cwd: root, stdio: "inherit", timeout: 120_000 },
    );
  writeJson(join(root, "package.json"), { private: true });
  install(
    published,
    ...Object.keys(manifest.peerDependencies).map(
      (name) => `${name}@${piVersion ?? manifest.devDependencies[name]}`,
    ),
  );
  const pkg = join(root, "node_modules", manifest.name);
  const installed = () => readJson(join(pkg, "package.json"));
  const lockEntry = () =>
    readJson(join(root, "package-lock.json")).packages[
      `node_modules/${manifest.name}`
    ];
  assert.equal(installed().name, manifest.name);
  assert.equal(installed().version, "0.1.0");
  assert.equal(lockEntry().resolved, published);
  assert.equal(
    lockEntry().integrity,
    "sha512-YrP/HaHWvS6ElQpoKidPzK8yn6IQSiVyOPjLlW65tmC1WcFBQdFkMei3HYjdnzEv5cBeRnjtUJYqTLXYHi+8lg==",
    "Unexpected published 0.1.0 tarball",
  );
  const host = join(root, "node_modules", "@earendil-works/pi-coding-agent");
  const { bin, version } = readJson(join(host, "package.json"));
  assert.equal(version, expectedPi, "Unexpected installed Pi version");
  const cli = join(host, typeof bin === "string" ? bin : bin.pi);
  const agentDir = join(root, "pi");
  const runPi = (args, input) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      input,
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        CURSOR_API_KEY: "offline-smoke-placeholder",
      },
    });
    assert.ifError(result.error);
    // A startup exception can include a whole line from Pi's minified bundle.
    const diagnostics = result.stderr
      .split("\n")
      .map((line) =>
        line.length > 500
          ? `${line.slice(0, 250)} … ${line.slice(-247)}`
          : line,
      )
      .join("\n")
      .trim();
    assert.equal(
      result.status,
      0,
      `pi ${args.join(" ")} failed (${result.signal ?? result.status}):\n${diagnostics || "(no stderr)"}`,
    );
    return result.stdout;
  };
  const offlineFlags = [
    "--offline",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ];
  const list = () => runPi([...offlineFlags, "--list-models", "cursor-sdk"]);
  const state = () => {
    const stdout = runPi(
      [...offlineFlags, "--no-tools", "--no-session", "--mode", "rpc"],
      '{"id":"offline-state","type":"get_state"}\n',
    );
    const response = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .find(({ type, id }) => type === "response" && id === "offline-state");
    assert.equal(
      response?.command,
      "get_state",
      `Missing RPC response: ${stdout}`,
    );
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  };
  const providerRow = /^cursor-sdk\s+/m;
  const auto = /^cursor-sdk\s+auto\s/m;
  assert.doesNotMatch(
    list(),
    providerRow,
    "Plugin should not load before installation",
  );
  runPi(["install", pkg]);

  const provider = "cursor-sdk";
  const modelId = "upgrade-smoke-fast";
  const settingsPath = join(agentDir, "settings.json");
  writeJson(settingsPath, {
    ...readJson(settingsPath),
    defaultProvider: provider,
    defaultModel: modelId,
    // Without the cached map, a reasoning model accepts low as-is.
    defaultThinkingLevel: "low",
    enabledModels: [`${provider}/${modelId}`],
  });
  const store = join(agentDir, "models-store.json");
  // Published 0.1.0 stored ProviderConfig rows without api/provider/baseUrl.
  // Use a test-only model ID so neither a built-in model nor Auto can pass.
  const selection = (effort) => ({
    id: "upgrade-smoke",
    params: [
      { id: "context", value: "272k" },
      { id: "fast", value: "true" },
      { id: "effort", value: effort },
    ],
    maxMode: false,
  });
  writeJson(store, {
    [provider]: {
      checkedAt: 1,
      models: [
        {
          id: modelId,
          name: "Upgrade Smoke Fast",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: "medium",
            high: "high",
            xhigh: null,
            max: null,
          },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 272000,
          maxTokens: 8192,
        },
      ],
      cursorSdkSelections: {
        [modelId]: {
          defaultSelection: selection("medium"),
          byThinking: { medium: selection("medium"), high: selection("high") },
        },
      },
    },
  });
  const settings = readFileSync(settingsPath, "utf8");
  const legacy = readFileSync(store, "utf8");
  const assertRestored = (phase) => {
    let rpcState;
    try {
      rpcState = state();
    } catch (cause) {
      throw new Error(`${phase}: could not read offline RPC state`, { cause });
    }
    const { model, thinkingLevel } = rpcState;
    assert.equal(model?.provider, provider, `${phase}: model provider`);
    assert.equal(model.id, modelId, `${phase}: saved model ID`);
    assert.equal(model.api, "cursor-sdk-api", `${phase}: model API`);
    assert.equal(
      model.baseUrl,
      "https://api2.cursor.sh",
      `${phase}: model base URL`,
    );
    assert.equal(
      thinkingLevel,
      "medium",
      `${phase}: saved Thinking level must be clamped by the cached map`,
    );
  };
  assertRestored("published package");
  // Pi does not update local-path packages. Replace the package through npm
  // while preserving the Pi registration, settings, and cache directory.
  install(candidate);
  assert.equal(installed().name, manifest.name);
  assert.equal(installed().version, manifest.version);
  const digest = createHash("sha512")
    .update(readFileSync(candidate))
    .digest("base64");
  assert.match(lockEntry().resolved, /^file:/);
  assert.equal(
    lockEntry().integrity,
    `sha512-${digest}`,
    "Candidate tarball was not installed",
  );
  assert.equal(readJson(join(host, "package.json")).version, expectedPi);
  assertRestored("candidate tarball");
  assert.equal(
    readFileSync(settingsPath, "utf8"),
    settings,
    "Saved settings changed",
  );
  assert.equal(readFileSync(store, "utf8"), legacy, "Legacy cache changed");

  // Empty and damaged cache must still leave a discoverable Auto fallback.
  for (const [label, contents] of [
    ["empty", "{}"],
    ["damaged", "{"],
  ]) {
    writeFileSync(store, contents);
    const rows = list();
    assert.match(rows, auto, `${label} cache: Auto fallback not registered`);
    assert.doesNotMatch(
      rows,
      new RegExp(`^cursor-sdk\\s+${modelId}\\s`, "m"),
      `${label} cache: stale model registered`,
    );
    assert.equal(
      readFileSync(store, "utf8"),
      contents,
      `${label} cache was overwritten`,
    );
  }
  runPi(["remove", pkg]);
  assert.doesNotMatch(list(), providerRow, "Plugin still loads after removal");
  console.log(
    `Pi ${version}: package install, offline legacy selection and Thinking across upgrade, cache fallback, and removal passed.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
