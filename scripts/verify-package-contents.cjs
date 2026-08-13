const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const hookPath = "dist/claude-code/ticket/hooks/ticket-gate.sh";
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("npm_execpath is unavailable; run this check through npm run verify:package");
}

const output = execFileSync(
  process.execPath,
  [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: root, encoding: "utf8" },
);
const packResult = JSON.parse(output)[0];
const hook = packResult?.files?.find((file) => file.path === hookPath);

if (!hook) {
  throw new Error(`${hookPath} is missing from the npm package`);
}

if ((hook.mode & 0o111) === 0) {
  throw new Error(`${hookPath} is not executable in the npm package`);
}

const source = readFileSync(resolve(root, "src/claude-code/ticket/hooks/ticket-gate.sh"));
const built = readFileSync(resolve(root, hookPath));

if (!source.equals(built)) {
  throw new Error(`${hookPath} does not match the tracked source asset`);
}

console.log(`Verified executable package asset: ${hookPath}`);
