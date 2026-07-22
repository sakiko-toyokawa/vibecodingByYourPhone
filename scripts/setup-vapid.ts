#!/usr/bin/env npx tsx
/**
 * VAPID Key Setup Script
 *
 * Generates VAPID (Voluntary Application Server Identification) keys for Web Push.
 * Keys are stored in ~/.yep-anywhere/vapid.json and reused across server restarts.
 *
 * Usage:
 *   pnpm setup-vapid           # Generate keys (skips if already exist)
 *   pnpm setup-vapid --force   # Regenerate keys (overwrites existing)
 */

import {
  generateVapidKeys,
  getDataDir,
  getVapidFilePath,
  loadVapidKeys,
} from "../packages/server/src/push/vapid.js";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force") || args.includes("-f");

  const dataDir = getDataDir();
  const vapidFile = getVapidFilePath();

  console.log("VAPID Key Setup");
  console.log(`  Data directory: ${dataDir}`);
  console.log(`  Key file: ${vapidFile}`);
  console.log();

  // Check for existing keys
  const existingKeys = await loadVapidKeys();

  if (existingKeys && !force) {
    console.log("VAPID keys already exist.");
    console.log();
    console.log(`  Public key: ${existingKeys.publicKey.slice(0, 20)}...`);
    console.log(`  Subject: ${existingKeys.subject}`);
    console.log();
    console.log(
      "Use --force to regenerate keys (will invalidate existing push subscriptions).",
    );
    return;
  }

  if (existingKeys && force) {
    console.log("Regenerating keys (--force specified)...");
    console.log(
      "WARNING: This will invalidate all existing push subscriptions!",
    );
    console.log();
  } else {
    console.log("Generating new VAPID keys...");
  }

  const keys = await generateVapidKeys();

  console.log("VAPID keys generated successfully!");
  console.log();
  console.log(`  Public key: ${keys.publicKey.slice(0, 20)}...`);
  console.log(`  Subject: ${keys.subject}`);
  console.log();
  console.log(`Keys saved to: ${vapidFile}`);
}

main().catch((error) => {
  console.error("Failed to setup VAPID keys:", error);
  process.exit(1);
});
