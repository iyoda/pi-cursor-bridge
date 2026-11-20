import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const [archive, piVersion, ...extra] = process.argv.slice(2);
assert(
  archive &&
    extra.length === 0 &&
    (!piVersion || /^\d+\.\d+\.\d+$/.test(piVersion)),
  "Usage: npm run install:check -- <npm pack tarball> [Pi version]",
);
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const expectedPi =
  piVersion ?? manifest.devDependencies["@earendil-works/pi-coding-agent"];
const root = mkdtempSync(join(tmpdir(), "pi-cursor-install-"));
try {
  const npm = process.env.npm_execpath;
  assert(npm, "Run through npm run install:check.");
  execFileSync(
    process.execPath,
    [
      npm,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      resolve(archive),
      ...Object.keys(manifest.peerDependencies).map(
        (name) => `${name}@${piVersion ?? manifest.devDependencies[name]}`,
      ),
    ],
    { cwd: root, stdio: "inherit", timeout: 120_000 },
  );
  const pkg = join(root, "node_modules", manifest.name);
  const host = join(root, "node_modules", "@earendil-works/pi-coding-agent");
  const { bin, version } = JSON.parse(
    readFileSync(join(host, "package.json"), "utf8"),
  );
  assert.equal(version, expectedPi, "Unexpected installed Pi version");
  const cli = join(host, typeof bin === "string" ? bin : bin.pi);
  const pi = (...args) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        PI_CODING_AGENT_DIR: join(root, "pi"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        CURSOR_API_KEY: "offline-smoke-placeholder",
      },
    });
  const list = () =>
    pi(
      "--offline",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--list-models",
      "cursor-sdk/auto",
    );
  const auto = /^cursor-sdk\s+auto\s/m;
  assert.doesNotMatch(
    list(),
    auto,
    "Plugin should not load before installation",
  );
  pi("install", pkg);
  assert.match(
    list(),
    auto,
    "Installed package did not register cursor-sdk/auto",
  );
  pi("remove", pkg);
  assert.doesNotMatch(list(), auto, "Plugin still loads after removal");
  console.log(
    `Pi ${version}: package install, model discovery, and removal passed.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
