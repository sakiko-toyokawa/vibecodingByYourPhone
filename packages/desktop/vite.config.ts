import { execSync } from "node:child_process";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

function getGitVersion(): string {
  try {
    return execSync("git describe --tags --always", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .replace(/^v/, "");
  } catch {
    return "dev";
  }
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(getGitVersion()),
  },
  resolve: {
    alias: {
      "@yep-anywhere/client/desktop": path.resolve(
        __dirname,
        "../client/src/desktop.tsx",
      ),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
