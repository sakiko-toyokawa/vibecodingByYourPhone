import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";

function makeSessionMeta(
  id: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      cwd,
      timestamp: new Date().toISOString(),
      ...extra,
    },
  });
}

describe("CodexSessionScanner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("discovers sessions from date-based directory structure", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id = randomUUID();
    await writeFile(
      join(dateDir, `rollout-${id}.jsonl`),
      `${makeSessionMeta(id, "/home/user/project-a")}\n{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/home/user/project-a");
    expect(projects[0].provider).toBe("codex");
    expect(projects[0].sessionCount).toBe(1);
  });

  it("groups sessions by cwd into projects", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id1 = randomUUID();
    const id2 = randomUUID();
    const id3 = randomUUID();

    // Two sessions in project-a, one in project-b
    await writeFile(
      join(dateDir, `rollout-${id1}.jsonl`),
      `${makeSessionMeta(id1, "/home/user/project-a")}\n`,
    );
    await writeFile(
      join(dateDir, `rollout-${id2}.jsonl`),
      `${makeSessionMeta(id2, "/home/user/project-a")}\n`,
    );
    await writeFile(
      join(dateDir, `rollout-${id3}.jsonl`),
      `${makeSessionMeta(id3, "/home/user/project-b")}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(2);
    const projectA = projects.find((p) => p.path === "/home/user/project-a");
    const projectB = projects.find((p) => p.path === "/home/user/project-b");
    expect(projectA?.sessionCount).toBe(2);
    expect(projectB?.sessionCount).toBe(1);
  });

  it("deduplicates mixed-slash Windows cwd variants into one project", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id1 = randomUUID();
    const id2 = randomUUID();

    await writeFile(
      join(dateDir, `rollout-${id1}.jsonl`),
      `${makeSessionMeta(id1, "C:\\Users\\kyle\\Documents\\webvam")}\n`,
    );
    await writeFile(
      join(dateDir, `rollout-${id2}.jsonl`),
      `${makeSessionMeta(id2, "c:/Users/kyle/Documents/webvam")}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("C:/Users/kyle/Documents/webvam");
    expect(projects[0].sessionCount).toBe(2);
  });

  it("parses session_meta with very large base_instructions over 64KB", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    // Simulate Codex Desktop which embeds the full system prompt (~11KB+)
    const largeInstructions = "x".repeat(80_000);
    const id = randomUUID();
    const meta = JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        cwd: "/home/user/project-large",
        timestamp: new Date().toISOString(),
        originator: "Codex Desktop",
        cli_version: "0.94.0-alpha.10",
        source: "vscode",
        model_provider: "openai",
        base_instructions: { text: largeInstructions },
      },
    });

    // Regression guard: older scanner logic only read the first 64KB.
    expect(Buffer.byteLength(meta)).toBeGreaterThan(65_536);

    await writeFile(join(dateDir, `rollout-${id}.jsonl`), `${meta}\n`);

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/home/user/project-large");
  });

  it("skips empty files", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "01", "01");
    await mkdir(dateDir, { recursive: true });
    await writeFile(join(dateDir, "rollout-empty.jsonl"), "");

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(0);
  });

  it("skips files where first line is not session_meta", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "01", "01");
    await mkdir(dateDir, { recursive: true });
    await writeFile(
      join(dateDir, "rollout-bad.jsonl"),
      '{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n',
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(0);
  });

  it("returns empty when sessions directory does not exist", async () => {
    const scanner = new CodexSessionScanner({
      sessionsDir: join(tmpdir(), `nonexistent-${randomUUID()}`),
    });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(0);
  });

  it("returns sessions for a specific project path", async () => {
    const sessionsDir = join(tmpdir(), `codex-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const dateDir = join(sessionsDir, "2026", "02", "03");
    await mkdir(dateDir, { recursive: true });

    const id1 = randomUUID();
    const id2 = randomUUID();
    await writeFile(
      join(dateDir, `rollout-${id1}.jsonl`),
      `${makeSessionMeta(id1, "/home/user/project-a")}\n`,
    );
    await writeFile(
      join(dateDir, `rollout-${id2}.jsonl`),
      `${makeSessionMeta(id2, "/home/user/project-b")}\n`,
    );

    const scanner = new CodexSessionScanner({ sessionsDir });
    const sessions = await scanner.getSessionsForProject(
      "/home/user/project-a",
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(id1);
  });
});
