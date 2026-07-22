import type { Root } from "react-dom/client";

declare global {
  interface Window {
    __YEP_SERVER_URL__?: string;
    __DESKTOP_TOKEN__?: string;
    __YEP_ROOT__?: Root;
  }
}

/** Build-time version (injected by Vite define, defaults to desktop package version) */
declare const __APP_VERSION__: string;

export {};
