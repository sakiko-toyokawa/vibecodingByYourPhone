import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Multi-project-type support for verification.
 *
 * Detects the project type and returns appropriate verification commands.
 * This avoids the assumption that all projects are Node.js projects.
 */

export type ProjectType =
  | "nodejs"
  | "rust"
  | "go"
  | "java"
  | "python"
  | "unknown";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function detectProjectType(
  workspacePath: string,
): Promise<ProjectType> {
  if (await fileExists(path.join(workspacePath, "package.json"))) {
    return "nodejs";
  }
  if (await fileExists(path.join(workspacePath, "Cargo.toml"))) {
    return "rust";
  }
  if (await fileExists(path.join(workspacePath, "go.mod"))) {
    return "go";
  }
  if (await fileExists(path.join(workspacePath, "pom.xml"))) {
    return "java";
  }
  if (await fileExists(path.join(workspacePath, "requirements.txt"))) {
    return "python";
  }
  return "unknown";
}

export async function detectCommandsForProjectType(
  projectType: ProjectType,
  workspacePath: string,
): Promise<{ static: string[]; runtime: string[] }> {
  switch (projectType) {
    case "nodejs":
      return detectNodeCommands(workspacePath);
    case "rust":
      return {
        static: ["cargo check"],
        runtime: ["cargo test"],
      };
    case "go":
      return {
        static: ["go vet ./..."],
        runtime: ["go test ./..."],
      };
    case "java":
      return {
        static: ["mvn compile"],
        runtime: ["mvn test"],
      };
    case "python":
      return {
        static: ["python -m flake8"],
        runtime: ["python -m pytest"],
      };
    default:
      return { static: [], runtime: [] };
  }
}

async function detectNodeCommands(
  workspacePath: string,
): Promise<{ static: string[]; runtime: string[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspacePath, "package.json"), "utf-8");
  } catch {
    return { static: [], runtime: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { static: [], runtime: [] };
  }

  const scripts =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { scripts?: Record<string, unknown> }).scripts
      : undefined;
  if (!scripts) {
    return { static: [], runtime: [] };
  }

  const staticCommands: string[] = [];
  const runtimeCommands: string[] = [];

  if (typeof scripts.lint === "string") {
    staticCommands.push("pnpm run lint");
  }
  if (typeof scripts.typecheck === "string") {
    staticCommands.push("pnpm run typecheck");
  }
  if (typeof scripts.test === "string") {
    runtimeCommands.push("pnpm run test");
  }

  return { static: staticCommands, runtime: runtimeCommands };
}
