import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type InteractionDependencyStatus = "ready" | "missing" | "unsupported";

export interface InteractionDependencyCheck {
  status: InteractionDependencyStatus;
  message: string;
  installCommand?: string;
}

const PLAYWRIGHT_PACKAGES = ["@playwright/test", "playwright"];

export function inferPlaywrightInstallCommand(workspacePath: string): string {
  if (existsSync(path.join(workspacePath, "pnpm-lock.yaml"))) {
    return "pnpm add -D @playwright/test playwright";
  }
  if (existsSync(path.join(workspacePath, "yarn.lock"))) {
    return "yarn add -D @playwright/test playwright";
  }
  if (existsSync(path.join(workspacePath, "bun.lockb"))) {
    return "bun add -d @playwright/test playwright";
  }
  return "npm install -D @playwright/test playwright";
}

export async function checkInteractionDependencies(
  workspacePath: string,
): Promise<InteractionDependencyCheck> {
  if (!workspacePath || workspacePath.startsWith("managed://")) {
    return {
      status: "unsupported",
      message: "interaction verification requires a local workspace path",
    };
  }

  let parsed: {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  try {
    parsed = JSON.parse(
      await readFile(path.join(workspacePath, "package.json"), "utf-8"),
    );
  } catch {
    return {
      status: "missing",
      message: "workspace package.json was not found or could not be read",
      installCommand: inferPlaywrightInstallCommand(workspacePath),
    };
  }

  const deps = { ...parsed.dependencies, ...parsed.devDependencies };
  if (PLAYWRIGHT_PACKAGES.some((name) => Object.hasOwn(deps, name))) {
    return { status: "ready", message: "Playwright dependency is configured" };
  }

  return {
    status: "missing",
    message: "Playwright test dependency is not installed",
    installCommand: inferPlaywrightInstallCommand(workspacePath),
  };
}
