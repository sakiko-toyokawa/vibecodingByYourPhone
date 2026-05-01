import { execSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cspPlugin } from "./vite-plugin-csp";
import { reloadNotify } from "./vite-plugin-reload-notify";

// NO_FRONTEND_RELOAD: Disable HMR and use manual reload notifications instead
const noFrontendReload = process.env.NO_FRONTEND_RELOAD === "true";

// Port defaults to 3402 (base port 3400 + 2), can be overridden via VITE_PORT
const vitePort = process.env.VITE_PORT
  ? Number.parseInt(process.env.VITE_PORT, 10)
  : 3402;
const apiPort = process.env.VITE_API_PORT
  ? Number.parseInt(process.env.VITE_API_PORT, 10)
  : process.env.PORT
    ? Number.parseInt(process.env.PORT, 10)
    : 3400;

// VITE_HOST: Set to "true" to bind to all interfaces (needed in Docker containers)
const viteHost = process.env.VITE_HOST === "true" ? true : undefined;

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

export default defineConfig({
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(getGitVersion()),
  },
  plugins: [
    react(),
    tailwindcss(),
    // When HMR is disabled, use reload-notify plugin to tell backend about changes
    reloadNotify({ enabled: noFrontendReload }),
    // Content Security Policy (stricter in production, permissive in dev for HMR)
    cspPlugin({ isRemote: false }),
  ],
  resolve: {
    conditions: ["source"],
  },
  server: {
    port: vitePort,
    host: viteHost,
    allowedHosts: ["localhost", ".yepanywhere.com"],
    proxy: {
      // Allow direct access to the Vite port in development by forwarding API
      // and WebSocket traffic to the backend server.
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
    // HMR configuration for reverse proxy setup
    // When accessed through backend proxy (port 3400) or Tailscale, HMR needs to
    // connect back through the same proxy path, not directly to Vite's port
    hmr: noFrontendReload
      ? false
      : {
          // Let the client determine host/port from its current location
          // This allows HMR to work through any proxy (backend, Tailscale, etc.)
          // The backend will proxy WebSocket connections to us
        },
    // No proxy needed - backend (port 3400) proxies to us, not the other way around
    // Users access http://localhost:3400 and backend forwards non-API requests here
  },
});
