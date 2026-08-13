const { chmodSync, copyFileSync, mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const assets = [
  {
    source: resolve(root, "src/claude-code/ticket/hooks/ticket-gate.sh"),
    destination: resolve(root, "dist/claude-code/ticket/hooks/ticket-gate.sh"),
    mode: 0o755,
  },
];

for (const asset of assets) {
  mkdirSync(dirname(asset.destination), { recursive: true });
  copyFileSync(asset.source, asset.destination);
  chmodSync(asset.destination, asset.mode);
}
