import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ALL_PROVIDERS,
  type ProviderName,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import { AiEditService } from "../services/ai-edit-service.js";
import type { IEventBus } from "../watcher/IEventBus.js";
import { resolveFilePath } from "./files.js";

interface EditorRoutesDeps {
  scanner: ProjectScanner;
  eventBus?: IEventBus;
  serverSettingsService?: ServerSettingsService;
}

interface WriteFileBody {
  path: string;
  content: string;
}

interface AiEditBody {
  path: string;
  instruction: string;
  content?: string;
  selectedText?: string;
  provider?: string;
  model?: string;
}

interface EditorTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: string;
}

const aiEditService = new AiEditService();

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

function joinRelativePath(parent: string, name: string): string {
  return normalizeRelativePath(parent ? `${parent}/${name}` : name);
}

function isProviderName(value: string | undefined): value is ProviderName {
  return !!value && ALL_PROVIDERS.includes(value as ProviderName);
}

export function createEditorRoutes(deps: EditorRoutesDeps): Hono {
  const routes = new Hono();

  routes.get("/:projectId/tree", async (c) => {
    const projectId = c.req.param("projectId");
    const relativePath = c.req.query("path") ?? "";

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const directoryPath = resolveFilePath(project.path, relativePath);
    if (!directoryPath) {
      return c.json({ error: "Invalid directory path" }, 400);
    }

    let directoryStats: Awaited<ReturnType<typeof stat>>;
    try {
      directoryStats = await stat(directoryPath);
    } catch {
      return c.json({ error: "Directory not found" }, 404);
    }

    if (!directoryStats.isDirectory()) {
      return c.json({ error: "Path is not a directory" }, 400);
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });
    const treeEntries = await Promise.all(
      entries.map(async (entry): Promise<EditorTreeEntry> => {
        const entryRelativePath = joinRelativePath(relativePath, entry.name);
        const entryPath = resolveFilePath(project.path, entryRelativePath);
        if (!entryPath) {
          throw new Error(`Failed to resolve entry path for ${entry.name}`);
        }

        const entryStats = await stat(entryPath);
        return {
          name: entry.name,
          path: entryRelativePath,
          type: entry.isDirectory() ? "directory" : "file",
          size: entryStats.size,
          mtime: entryStats.mtime.toISOString(),
        };
      }),
    );

    treeEntries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return c.json({
      path: normalizeRelativePath(relativePath),
      entries: treeEntries,
    });
  });

  routes.post("/:projectId/files/write", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    let body: WriteFileBody;
    try {
      body = await c.req.json<WriteFileBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.path || typeof body.content !== "string") {
      return c.json({ error: "path and content are required" }, 400);
    }

    const normalizedPath = normalizeRelativePath(body.path);
    const filePath = resolveFilePath(project.path, normalizedPath);
    if (!filePath) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    let existed = true;
    try {
      await stat(filePath);
    } catch {
      existed = false;
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body.content, "utf-8");

    deps.eventBus?.emit({
      type: "file-change",
      provider: project.provider,
      path: filePath,
      relativePath: normalizedPath,
      changeType: existed ? "modify" : "create",
      timestamp: new Date().toISOString(),
      fileType: "other",
    });

    return c.json({
      path: normalizedPath,
      saved: true,
    });
  });

  routes.post("/:projectId/ai-edit", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    let body: AiEditBody;
    try {
      body = await c.req.json<AiEditBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.path || !body.instruction) {
      return c.json({ error: "path and instruction are required" }, 400);
    }

    if (body.provider !== undefined && !isProviderName(body.provider)) {
      return c.json({ error: "Invalid provider" }, 400);
    }

    const normalizedPath = normalizeRelativePath(body.path);
    const filePath = resolveFilePath(project.path, normalizedPath);
    if (!filePath) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    const fileContent =
      typeof body.content === "string"
        ? body.content
        : await readFile(filePath, "utf-8");

    const newSessionDefaults =
      deps.serverSettingsService?.getSetting("newSessionDefaults");
    const model =
      body.model && body.model !== "default"
        ? body.model
        : newSessionDefaults?.model && newSessionDefaults.model !== "default"
          ? newSessionDefaults.model
          : undefined;
    const globalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;
    const provider =
      body.provider ??
      newSessionDefaults?.provider ??
      project.provider ??
      undefined;

    try {
      const result = await aiEditService.suggestEdit({
        projectPath: project.path,
        filePath: normalizedPath,
        fileContent,
        instruction: body.instruction,
        selectedText: body.selectedText,
        provider,
        model,
        globalInstructions,
      });

      return c.json({
        path: normalizedPath,
        provider: result.provider,
        model: result.model,
        content: result.content,
        structuredPatch: result.structuredPatch,
        diffHtml: result.diffHtml,
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "AI edit request failed",
        },
        500,
      );
    }
  });

  return routes;
}
