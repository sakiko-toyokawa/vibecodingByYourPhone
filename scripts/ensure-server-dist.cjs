const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const serverDist = path.join(rootDir, "packages", "server", "dist");
const requiredFiles = ["index.js", "server.js", "services-init.js"];

function check() {
  if (!fs.existsSync(serverDist)) {
    console.error(`\nERROR: Server dist not found at ${serverDist}`);
    console.error("The bundled server has not been compiled.");
    console.error("\nRun the following command to compile and bundle:");
    console.error(
      "  pnpm --filter @yep-anywhere/server build && pnpm build:bundle\n",
    );
    process.exit(1);
  }

  for (const file of requiredFiles) {
    const filePath = path.join(serverDist, file);
    if (!fs.existsSync(filePath)) {
      console.error(`\nERROR: Server dist is missing required file: ${file}`);
      console.error(`Expected at: ${filePath}`);
      console.error("\nRun the following command to recompile:");
      console.error(
        "  pnpm --filter @yep-anywhere/server build && pnpm build:bundle\n",
      );
      process.exit(1);
    }
  }

  console.log(`Server dist verified: ${serverDist}`);
}

check();
