import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceOptions {
  /** If true, the `lint` script exits 1. */
  lintFails?: boolean;
  /** If true, the `test` script exits 1. */
  testFails?: boolean;
}

export async function makeTestWorkspace(
  options: WorkspaceOptions = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yep-loop-runtime-"));

  const lintExit = options.lintFails ? 1 : 0;
  const testExit = options.testFails ? 1 : 0;

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "loop-runtime-target",
        version: "1.0.0",
        scripts: {
          lint: `node -e "process.exit(${lintExit})"`,
          test: `node -e "process.exit(${testExit})"`,
        },
      },
      null,
      2,
    ),
  );

  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, ".verifier"), { recursive: true });
  await writeFile(
    join(dir, "src", "index.js"),
    "export function answer() { return 42; }\n",
  );
  await writeFile(
    join(dir, "src", "index.ts"),
    'export function describeAnswer(): string {\n  return "The answer is 42";\n}\n',
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(dir, ".verifier", "rules.json"),
    `${JSON.stringify(
      {
        version: 1,
        rules: [
          {
            name: "no-hardcoded-secrets",
            pattern: "secret",
            severity: "error",
            message: "Detected a likely hardcoded secret",
            suggestion: "Move the value to environment configuration",
            scope: "changed",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await writeFile(
    join(dir, "README.md"),
    "# Sample target workspace for loop runtime evaluation\n",
  );

  // Initialize git so diff / worktree checks work.
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "eval@test.com"], {
    cwd: dir,
  });
  await execFileAsync("git", ["config", "user.name", "Eval"], { cwd: dir });
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });

  return dir;
}
