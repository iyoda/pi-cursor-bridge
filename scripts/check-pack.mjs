import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const destination = ".pack";
const expectedName = "@iyoda/pi-cursor-bridge";
const archiveStem = expectedName.slice(1).replace("/", "-");
const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
if (name !== expectedName) throw new Error(`Expected package ${expectedName}.`);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run through npm run pack:check.");
mkdirSync(destination, { recursive: true });
execFileSync(
  process.execPath,
  [npm, "pack", "--pack-destination", destination],
  {
    stdio: "inherit",
  },
);
const archive = join(destination, `${archiveStem}-${version}.tgz`);
const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("package/") && !line.endsWith("/"))
  .map((line) => line.slice("package/".length))
  .sort();
const expected = [
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "dist/index.d.ts",
  "dist/index.js",
  "docs/live-validation-results.md",
  "docs/live-validation.md",
  "docs/p2-offline-savings.md",
  "examples/smoke-tools.ts",
  "examples/cursor-budget-settings.json",
  "package.json",
].sort();
const missing = expected.filter((path) => !entries.includes(path));
const extra = entries.filter((path) => !expected.includes(path));
if (missing.length || extra.length) {
  console.error("Tarball file list does not match the published set.");
  if (missing.length) console.error(`Missing: ${missing.join(", ")}`);
  if (extra.length) console.error(`Unexpected: ${extra.join(", ")}`);
  process.exit(1);
}

const manifest = JSON.parse(
  execFileSync("tar", ["-xOf", archive, "package/package.json"], {
    encoding: "utf8",
  }),
);
if (
  manifest.name !== expectedName ||
  basename(archive) !== `${archiveStem}-${manifest.version}.tgz`
) {
  console.error(`Expected the ${expectedName} package and tarball.`);
  process.exit(1);
}
const peers = manifest.peerDependencies ?? {};
const dependencies = manifest.dependencies ?? {};
if (manifest.license !== "MIT" || manifest.private === true) {
  console.error("Published package must stay MIT and public.");
  process.exit(1);
}
for (const name of [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
]) {
  if (peers[name] !== "*" || dependencies[name]) {
    console.error(`${name} must be a peer dependency with range *.`);
    process.exit(1);
  }
}
if (!dependencies["@cursor/sdk"]) {
  console.error("@cursor/sdk must remain a runtime dependency.");
  process.exit(1);
}

const bundle = execFileSync("tar", ["-xOf", archive, "package/dist/index.js"], {
  encoding: "utf8",
});
if (
  !bundle.includes('from "@cursor/sdk"') &&
  !bundle.includes("from '@cursor/sdk'")
) {
  console.error(
    "dist/index.js does not import @cursor/sdk as an external module.",
  );
  process.exit(1);
}
if (bundle.includes("node_modules/@cursor/sdk") || bundle.length > 200_000) {
  console.error("dist/index.js looks like it vendors @cursor/sdk.");
  process.exit(1);
}

console.log(`${archive}: ${entries.length} files, @cursor/sdk stays external.`);
