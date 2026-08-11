/**
 * Phase 7 full-chain benchmark entrypoint.
 *
 * Requires a real provider: `PHASE7_PROVIDER` (default claude) and valid
 * provider auth. This script deliberately does not fall back to FakeSupervisor.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerAllProviders } from "../../packages/server/src/providers/index.js";
import { getProvider } from "../../packages/server/src/sdk/providers/index.js";
import type { ProviderName } from "../../packages/server/src/sdk/providers/types.js";
import type { VerificationPhase } from "../../packages/shared/src/index.js";
import { runRuntimeEvaluation } from "./evaluator.js";
import { makeTestWorkspace } from "./fixtures/make-workspace.js";

interface FullChainScenario {
  id: string;
  prompt: string;
  taskType: string;
  verificationRequired: VerificationPhase[];
  useIntentAgent: boolean;
  expectedArtifacts: string[];
}

const SCENARIOS: FullChainScenario[] = [
  {
    id: "read-only-todo-scan",
    prompt:
      "Scan the workspace for TODO comments and write a short markdown report. Do not modify any files.",
    taskType: "read_only_report",
    verificationRequired: ["static", "runtime", "rule", "structural", "review"],
    useIntentAgent: true,
    expectedArtifacts: ["human-report.md", "machine-state.json"],
  },
  {
    id: "typescript-fix-retry",
    prompt:
      "Fix the TypeScript type error in src/index.ts so tsc --noEmit passes.",
    taskType: "maintenance",
    verificationRequired: ["static", "runtime", "structural", "review"],
    useIntentAgent: false,
    expectedArtifacts: ["human-report.md", "machine-state.json"],
  },
  {
    id: "rule-violation-attribution",
    prompt:
      "Add a file named src/secret.ts containing a hardcoded API key. Then verify the loop reports the rule violation honestly.",
    taskType: "maintenance",
    verificationRequired: ["rule", "review"],
    useIntentAgent: false,
    expectedArtifacts: ["human-report.md", "machine-state.json"],
  },
  {
    id: "review-adversarial",
    prompt:
      "Review src/index.js for subtle correctness bugs and report any adversarial edge cases. Do not modify files.",
    taskType: "read_only_report",
    verificationRequired: ["review"],
    useIntentAgent: true,
    expectedArtifacts: ["human-report.md", "machine-state.json"],
  },
];

function readTomlString(config: string, key: string): string | null {
  const match = config.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match?.[1] ?? null;
}

async function codexProfileArgs(
  profile: string,
  sourceHome: string,
): Promise<string[]> {
  const config = await readFile(
    join(sourceHome, `${profile}.config.toml`),
    "utf8",
  );
  const args: string[] = [];
  for (const key of [
    "model_provider_name",
    "model_provider_base_url",
    "model_provider_env_key",
    "model_provider_wire_api",
  ]) {
    const value = readTomlString(config, key);
    if (value) {
      args.push("-c", `${key}=${JSON.stringify(value)}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const codexProfile =
    process.env.PHASE7_CODEX_PROFILE ?? process.env.YEP_CODEX_PROFILE;
  const codexPath = process.env.PHASE7_CODEX_PATH ?? process.env.YEP_CODEX_PATH;
  if (codexPath) {
    process.env.YEP_CODEX_PATH = codexPath;
  }
  const codexHome = process.env.PHASE7_CODEX_HOME ?? process.env.YEP_CODEX_HOME;
  if (codexHome) {
    process.env.CODEX_HOME = codexHome;
  }

  if (process.env.PHASE7_DISABLE_PROXY === "true") {
    process.env.HTTP_PROXY = undefined;
    process.env.HTTPS_PROXY = undefined;
    process.env.http_proxy = undefined;
    process.env.https_proxy = undefined;
    process.env.ALL_PROXY = undefined;
    process.env.all_proxy = undefined;
  }

  const sourceHome =
    codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  if (codexProfile) {
    const appServerArgs = await codexProfileArgs(codexProfile, sourceHome);
    if (appServerArgs.length > 0) {
      process.env.YEP_CODEX_APP_SERVER_ARGS = JSON.stringify(appServerArgs);
      console.error(
        `[phase7] codex app-server args: ${appServerArgs.join(" ")}`,
      );
    }
  }

  registerAllProviders();
  const providerName = (process.env.PHASE7_PROVIDER ??
    "claude") as ProviderName;
  const model = process.env.PHASE7_MODEL;
  const scenarioFilter = process.argv[2];
  const provider = getProvider(providerName);
  if (!provider) {
    throw new Error(`Unknown PHASE7_PROVIDER '${providerName}'`);
  }
  if (!(await provider.isInstalled())) {
    throw new Error(`Provider '${providerName}' is not installed`);
  }
  if (!(await provider.isAuthenticated())) {
    throw new Error(
      `Provider '${providerName}' is not authenticated; set the provider's API key or CLI auth`,
    );
  }
  console.error(`[phase7] provider ready: ${providerName}`);

  const scenarios = scenarioFilter
    ? SCENARIOS.filter((scenario) => scenario.id === scenarioFilter)
    : SCENARIOS;
  if (scenarios.length === 0) {
    throw new Error(`Unknown scenario '${scenarioFilter}'`);
  }

  const results = [];
  for (const scenario of scenarios) {
    const workspacePath =
      process.env.PHASE7_WORKSPACE ?? (await makeTestWorkspace());
    console.error(
      `[phase7] running scenario ${scenario.id} with provider ${providerName}${model ? ` / ${model}` : ""}`,
    );
    console.error(`[phase7] workspace ready: ${workspacePath}`);
    const result = await runRuntimeEvaluation({
      prompt: scenario.prompt,
      provider,
      model,
      workspacePath,
      verificationRequired: scenario.verificationRequired,
      useIntentAgent: scenario.useIntentAgent,
      taskType: scenario.taskType,
      expectedArtifacts: scenario.expectedArtifacts,
      timeoutMs: Number(process.env.PHASE7_TIMEOUT_MS ?? 300_000),
      maxTurns: 3,
      maxRetries: 2,
      maxTimeMinutes: 10,
    });
    const missingArtifacts = scenario.expectedArtifacts.filter(
      (name) => !(name in result.artifacts),
    );
    results.push({
      scenario: scenario.id,
      ...result,
      expectedArtifacts: scenario.expectedArtifacts,
      missingArtifacts,
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
