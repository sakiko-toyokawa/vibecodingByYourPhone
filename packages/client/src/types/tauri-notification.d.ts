/**
 * Type declarations for @tauri-apps/plugin-notification.
 * This module is only available at runtime inside the Tauri desktop app.
 * The client package does not depend on it directly to avoid coupling
 * the shared client code to Tauri-specific packages.
 */

declare module "@tauri-apps/plugin-notification" {
  export function isPermissionGranted(): Promise<boolean>;
  export function requestPermission(): Promise<
    "granted" | "denied" | "default" | "prompt"
  >;
  export function sendNotification(options: {
    title: string;
    body?: string;
  }): void;
}
