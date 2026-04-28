const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const bundleRoot = path.join(rootDir, "dist", "npm-package3");
const requiredFiles = [
  "package.json",
  path.join("dist", "index.js"),
  path.join("dist", "server.js"),
  path.join("dist", "services-init.js"),
  path.join("client-dist", "index.html"),
];
const requiredPackages = [
  "hono",
  "@hono/node-server",
  "@hono/node-ws",
  "pino",
  "zod",
  "ws",
  "ioredis",
  "bcrypt",
  "@anthropic-ai/claude-agent-sdk",
  "@openai/codex-sdk",
  "awilix",
  "diff",
  "marked",
  "proper-lockfile",
];

function packagePath(nodeModulesRoot, packageName) {
  return packageName
    .split("/")
    .filter(Boolean)
    .reduce((current, segment) => path.join(current, segment), nodeModulesRoot);
}

function check() {
  if (!fs.existsSync(bundleRoot)) {
    console.error(`\nERROR: Desktop bundle not found at ${bundleRoot}`);
    console.error("Run `pnpm build:bundle` before building the desktop app.\n");
    process.exit(1);
  }

  const missing = [];

  for (const relativePath of requiredFiles) {
    const fullPath = path.join(bundleRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      missing.push(relativePath);
    }
  }

  const nodeModulesRoot = path.join(bundleRoot, "node_modules");
  for (const packageName of requiredPackages) {
    const fullPath = packagePath(nodeModulesRoot, packageName);
    if (!fs.existsSync(fullPath)) {
      missing.push(path.join("node_modules", ...packageName.split("/")));
    }
  }

  if (missing.length > 0) {
    console.error("\nERROR: Desktop bundle is incomplete.");
    console.error(`Checked bundle root: ${bundleRoot}`);
    console.error("Missing required paths:");
    for (const entry of missing) {
      console.error(`  - ${entry}`);
    }
    console.error("\nRebuild with: pnpm build:bundle\n");
    process.exit(1);
  }

  console.log(`Desktop bundle verified: ${bundleRoot}`);
}

check();
