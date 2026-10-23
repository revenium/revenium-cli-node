const { execFileSync } = require("node:child_process");
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const { resolve, join } = require("node:path");

const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
const meteringBin = "dist/claude-code/cli/index.js";
const npmCli = process.env.npm_execpath;

const publicDocs = [];
const forbiddenPathFragments = ["claude-code/ticket/", "claude-code/commands/ticket."];
const forbiddenSymbols = [
  "installTicketGateHook",
  "uninstallTicketGateHook",
  "ticketGateAssociateCommand",
  "ticketLaunchCommand",
  "ticketSwitchCommand",
  "ticketStatusCommand",
  "ticketIdRegex",
  "TICKET_BLOCK_POLICY",
  "REVENIUM_TICKET_REGEX",
  "REVENIUM_TICKET_BLOCK_POLICY",
];
const forbiddenFlags = [
  "--install-ticket-gate",
  "--skip-ticket-gate",
  "--ticket-id-regex",
  "--ticket-block-policy",
];

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function findInternalOnlyPaths(dirRoot, allowedPublicDocs) {
  const relativeToDirRoot = (path) => path.slice(dirRoot.length + 1);
  return [
    ...filesUnder(resolve(dirRoot, "docs"))
      .map(relativeToDirRoot)
      .filter((path) => !allowedPublicDocs.includes(path)),
    ...filesUnder(resolve(dirRoot, "enterprise")).map(relativeToDirRoot),
  ];
}

if (require.main === module) {
  if (!npmCli) {
    throw new Error("npm_execpath is unavailable; run this check through npm run verify:public");
  }

  const relativeToRoot = (path) => path.slice(root.length + 1);
  const internalOnlyPaths = findInternalOnlyPaths(root, publicDocs);

  if (internalOnlyPaths.length > 0) {
    throw new Error(
      `internal-only paths are in the public tree:\n  ${internalOnlyPaths.join("\n  ")}`,
    );
  }

  if (!existsSync(dist)) {
    throw new Error("dist is missing; run npm run build before this check");
  }

  const built = filesUnder(dist).filter((path) => /\.(js|cjs|mjs|d\.ts|sh)$/.test(path));

  if (built.length === 0) {
    throw new Error(
      "dist contains no build output; the build did not produce a publishable tree",
    );
  }

  const symbolHits = built.flatMap((path) => {
    const contents = readFileSync(path, "utf8");
    return forbiddenSymbols
      .filter((symbol) => contents.includes(symbol))
      .map((symbol) => `${symbol} in ${relativeToRoot(path)}`);
  });

  if (symbolHits.length > 0) {
    throw new Error(`forbidden symbols reached the build:\n  ${symbolHits.join("\n  ")}`);
  }

  const packOutput = execFileSync(
    process.execPath,
    [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: root, encoding: "utf8" },
  );
  const packedPaths = (JSON.parse(packOutput)[0]?.files ?? []).map((file) => file.path);
  const pathHits = packedPaths.filter((path) =>
    forbiddenPathFragments.some((fragment) => path.includes(fragment)),
  );

  if (pathHits.length > 0) {
    throw new Error(`forbidden paths reached the tarball:\n  ${pathHits.join("\n  ")}`);
  }

  const help = execFileSync(process.execPath, [resolve(root, meteringBin), "--help"], {
    encoding: "utf8",
    timeout: 30000,
  });
  const flagHits = forbiddenFlags.filter((flag) => help.includes(flag));

  if (flagHits.length > 0) {
    throw new Error(`forbidden flags are exposed by the CLI: ${flagHits.join(", ")}`);
  }

  console.log(
    `Verified public build: ${built.length} files, ${packedPaths.length} packed, no internal-only docs, forbidden symbols, paths or flags`,
  );
}

module.exports = {
  filesUnder,
  findInternalOnlyPaths,
  publicDocs,
  forbiddenPathFragments,
  forbiddenSymbols,
  forbiddenFlags,
};
