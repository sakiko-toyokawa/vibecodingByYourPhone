import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import {
  SESSION_COOKIE_NAME,
  createAuthRoutes,
} from "../../src/auth/routes.js";

describe("Auth routes - POST /enable", () => {
  let authService: AuthService;
  let testDir: string;
  let routes: ReturnType<typeof createAuthRoutes>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-routes-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    routes = createAuthRoutes({ authService });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function postEnable(
    body: { password: string },
    cookie?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cookie) {
      headers.Cookie = cookie;
    }

    return routes.request("/enable", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  async function postLogin(password: string): Promise<Response> {
    return routes.request("/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
  }

  it("allows unauthenticated first-time setup", async () => {
    const res = await postEnable({ password: "initial-password" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(authService.hasAccount()).toBe(true);
    await expect(authService.verifyPassword("initial-password")).resolves.toBe(
      true,
    );
  });

  it("rejects enable when auth is already enabled", async () => {
    await authService.enableAuth("current-password");

    const res = await postEnable({ password: "next-password" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Authentication is already enabled. Use change-password.",
    });
  });

  it("allows fresh setup after disabling auth without requiring prior password", async () => {
    await authService.enableAuth("current-password");
    const loginRes = await postLogin("current-password");
    const cookie = loginRes.headers.get("set-cookie");
    expect(loginRes.status).toBe(200);
    expect(cookie).toBeTruthy();

    const disableRes = await routes.request("/disable", {
      method: "POST",
      headers: {
        Cookie: cookie ?? "",
      },
    });
    expect(disableRes.status).toBe(200);
    expect(authService.isEnabled()).toBe(false);
    expect(authService.hasAccount()).toBe(false);

    const res = await postEnable({ password: "next-password" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    await expect(authService.verifyPassword("next-password")).resolves.toBe(
      true,
    );
    await expect(authService.verifyPassword("current-password")).resolves.toBe(
      false,
    );
  });
});

describe("Auth routes - cookie secure flag", () => {
  let authService: AuthService;
  let testDir: string;
  let routes: ReturnType<typeof createAuthRoutes>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-routes-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("password123");
    routes = createAuthRoutes({ authService });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("does not set Secure on HTTP login cookies", async () => {
    const res = await routes.request("http://192.168.1.139/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: "password123" }),
    });

    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).not.toContain("Secure");
  });

  it("sets Secure on HTTPS login cookies", async () => {
    const res = await routes.request("https://example.com/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: "password123" }),
    });

    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("Secure");
  });
});
