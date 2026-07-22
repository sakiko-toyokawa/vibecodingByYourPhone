/**
 * Device detection utilities.
 *
 * This module provides centralized device/capability detection for consistent
 * behavior across the app. Different detection methods serve different purposes:
 *
 * - isMobileDevice(): User agent based - for API capability checks (e.g., Notification API)
 * - hasCoarsePointer(): Input method based - for touch vs mouse interaction behavior
 * - Viewport width: Use useSidebarWidth/useViewportWidth hooks for layout decisions
 */

/**
 * Detect if we're on a mobile device based on user agent.
 *
 * Use this for checking device capabilities that are hardware/OS specific,
 * such as APIs that don't work on mobile browsers (e.g., `new Notification()`).
 *
 * Note: This is NOT the same as touch detection or viewport width.
 * A desktop can have a touch screen, and mobile devices can have large viewports.
 */
export function isMobileDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  const ua = navigator.userAgent.toLowerCase();

  const mobileKeywords = [
    "android",
    "webos",
    "iphone",
    "ipad",
    "ipod",
    "blackberry",
    "windows phone",
  ];

  return mobileKeywords.some((keyword) => ua.includes(keyword));
}

/**
 * Detect if the device has a coarse pointer (touch screen as primary input).
 *
 * Use this for input behavior decisions, like whether Enter should send
 * a message or add a newline. A desktop with a touch screen will return
 * true if touch is the primary input method.
 *
 * This uses CSS media query `(pointer: coarse)` which detects the PRIMARY
 * pointing device. For detecting ANY touch capability, use hasTouchCapability().
 */
export function hasCoarsePointer(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Detect if the device has any touch capability.
 *
 * Use this when you need to know if touch events might occur, regardless
 * of whether touch is the primary input method. Useful for adding touch
 * event listeners alongside mouse events.
 */
export function hasTouchCapability(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  return (
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0 ||
    // @ts-expect-error - msMaxTouchPoints is IE/Edge legacy
    navigator.msMaxTouchPoints > 0
  );
}

/**
 * Parsed user agent information.
 */
export interface ParsedUserAgent {
  browser: string;
  os: string;
}

/**
 * Parse a user agent string to extract browser and OS information.
 *
 * Returns human-readable browser and OS names. Falls back to "Unknown"
 * if parsing fails.
 */
export function parseUserAgent(ua: string): ParsedUserAgent {
  const uaLower = ua.toLowerCase();

  // Detect OS
  let os = "Unknown";
  if (uaLower.includes("android")) {
    const match = ua.match(/Android\s*([\d.]+)?/i);
    os = match?.[1] ? `Android ${match[1]}` : "Android";
  } else if (uaLower.includes("iphone") || uaLower.includes("ipad")) {
    const match = ua.match(/OS\s*([\d_]+)/i);
    const version = match?.[1]?.replace(/_/g, ".");
    os = uaLower.includes("ipad") ? "iPadOS" : "iOS";
    if (version) os += ` ${version}`;
  } else if (uaLower.includes("mac os x") || uaLower.includes("macos")) {
    const match = ua.match(/Mac OS X\s*([\d_.]+)?/i);
    const version = match?.[1]?.replace(/_/g, ".");
    os = version ? `macOS ${version}` : "macOS";
  } else if (uaLower.includes("windows")) {
    const match = ua.match(/Windows NT\s*([\d.]+)?/i);
    const ntVersion = match?.[1];
    // Map NT versions to Windows versions
    const windowsVersions: Record<string, string> = {
      "10.0": "Windows 10/11",
      "6.3": "Windows 8.1",
      "6.2": "Windows 8",
      "6.1": "Windows 7",
    };
    os = ntVersion ? (windowsVersions[ntVersion] ?? "Windows") : "Windows";
  } else if (uaLower.includes("linux")) {
    os = "Linux";
  } else if (uaLower.includes("cros")) {
    os = "Chrome OS";
  }

  // Detect browser (order matters - check specific browsers before generic ones)
  let browser = "Unknown";
  if (uaLower.includes("edg/")) {
    const match = ua.match(/Edg\/([\d.]+)/);
    browser = match?.[1] ? `Edge ${match[1]}` : "Edge";
  } else if (uaLower.includes("opr/") || uaLower.includes("opera")) {
    const match = ua.match(/(?:OPR|Opera)\/([\d.]+)/i);
    browser = match?.[1] ? `Opera ${match[1]}` : "Opera";
  } else if (uaLower.includes("firefox/")) {
    const match = ua.match(/Firefox\/([\d.]+)/i);
    browser = match?.[1] ? `Firefox ${match[1]}` : "Firefox";
  } else if (
    uaLower.includes("safari/") &&
    !uaLower.includes("chrome") &&
    !uaLower.includes("chromium")
  ) {
    const match = ua.match(/Version\/([\d.]+)/i);
    browser = match?.[1] ? `Safari ${match[1]}` : "Safari";
  } else if (uaLower.includes("chrome/") || uaLower.includes("chromium/")) {
    const match = ua.match(/(?:Chrome|Chromium)\/([\d.]+)/i);
    browser = match?.[1] ? `Chrome ${match[1]}` : "Chrome";
  }

  return { browser, os };
}
