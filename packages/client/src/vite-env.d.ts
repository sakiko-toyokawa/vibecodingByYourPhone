/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Enable service worker in dev mode (default: false) */
  readonly VITE_ENABLE_SW?: string;
  /** Set to true in remote client build (requires SecureConnection for all API calls) */
  readonly VITE_IS_REMOTE_CLIENT?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Build-time version from git describe (injected by Vite define) */
declare const __APP_VERSION__: string;
