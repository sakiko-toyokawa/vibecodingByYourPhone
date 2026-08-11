import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IntentContract, LoopCard } from "@yep-anywhere/shared";
import { FileContentStrategy } from "./strategies/file-content.js";
import { FileExistenceStrategy } from "./strategies/file-existence.js";
import { InteractionAgentStrategy } from "./strategies/interaction/index.js";
import { RuleBasedStrategy } from "./strategies/rule-based.js";
import { StructuralStrategy } from "./strategies/structural/index.js";
import { SubprocessStrategy } from "./strategies/subprocess.js";
import { UnverifiedLanguageStrategy } from "./strategies/unverified-language.js";
import { selectVerificationStrategy } from "./strategy-selector.js";

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "test-loop",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/test" },
      verification: { required: ["static"] },
      persistence: { state_file: "state/test.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
      ...overrides,
    },
  } as LoopCard;
}

function makeContract(criteria: string[] = []): IntentContract {
  return {
    intent_id: "intent-test",
    source: "ui",
    raw_goal: "test task",
    task_type: {
      primary: "maintenance",
      confidence: 1,
      requires_clarification: false,
    },
    outcome: "test outcome",
    success_criteria: criteria,
    constraints: [],
    budget: {
      max_tokens: 0,
      max_time_minutes: 10,
      max_turns: 3,
      max_retries: 2,
    },
    security_level: "workspace_write",
  } as IntentContract;
}

test("selectVerificationStrategy: uses SubprocessStrategy when custom commands are specified", async () => {
  const card = makeCard({
    verification: {
      required: ["static"],
      commands: { static: ["custom-lint"], runtime: ["custom-test"] },
    },
  });
  const strategy = await selectVerificationStrategy(
    card,
    makeContract(),
    "/tmp/test",
  );
  assert.ok(strategy instanceof SubprocessStrategy);
});

test("selectVerificationStrategy: uses SubprocessStrategy for Node.js projects", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(
      join(workspacePath, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "jest" } }),
    );

    const card = makeCard({
      workspace: { strategy: "direct", path: workspacePath },
    });
    const strategy = await selectVerificationStrategy(
      card,
      makeContract(),
      workspacePath,
    );
    assert.ok(strategy instanceof SubprocessStrategy);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("selectVerificationStrategy: unknown language fails closed even with success criteria", async () => {
  const card = makeCard();
  const strategy = await selectVerificationStrategy(
    card,
    makeContract(["search-results.md exists", "found 3 candidate issues"]),
    "/tmp/test",
  );
  assert.ok(strategy instanceof UnverifiedLanguageStrategy);
});

test("selectVerificationStrategy: unknown language uses fail-closed fallback", async () => {
  const card = makeCard();
  const strategy = await selectVerificationStrategy(
    card,
    makeContract(),
    "/tmp/test",
  );
  assert.ok(strategy instanceof UnverifiedLanguageStrategy);
});

test("selectVerificationStrategy: rule 掛載 RuleBasedStrategy (P2)", async () => {
  const card = makeCard({
    verification: {
      required: ["rule"],
      rules: [
        {
          name: "no-secrets",
          pattern: "secret",
          severity: "error",
          message: "m",
          scope: "changed",
        },
      ],
    },
  });
  const strategy = await selectVerificationStrategy(
    card,
    makeContract(),
    "/tmp/test",
    "rule",
  );
  assert.ok(strategy instanceof RuleBasedStrategy);
});

test("selectVerificationStrategy: rule 無內嵌規則時仍掛 RuleBasedStrategy (workspace 規則檔由策略載入)", async () => {
  const card = makeCard({ verification: { required: ["rule"] } });
  const strategy = await selectVerificationStrategy(
    card,
    makeContract(),
    "/tmp/test",
    "rule",
  );
  assert.ok(strategy instanceof RuleBasedStrategy);
});

test("selectVerificationStrategy: structural 掛載 StructuralStrategy (P3)", async () => {
  const card = makeCard();
  const strategy = await selectVerificationStrategy(
    card,
    makeContract(),
    "/tmp/test",
    "structural",
  );
  assert.ok(strategy instanceof StructuralStrategy);
  assert.equal(strategy.name, "structural");
});

test("selectVerificationStrategy: interaction 掛載 InteractionAgentStrategy", async () => {
  const card = makeCard({
    verification: {
      required: ["interaction"],
      interaction: { enabled: true, url: "http://localhost:3400" },
    },
  });
  const strategy = await selectVerificationStrategy(
    card,
    makeContract(["user can open the dashboard"]),
    "/tmp/test",
    "interaction",
  );
  assert.ok(strategy instanceof InteractionAgentStrategy);
  assert.equal(strategy.name, "interaction_agent");
});

test("selectVerificationStrategy: 缺省 phase 维持 static 行为", async () => {
  const card = makeCard();
  const strategy = await selectVerificationStrategy(
    card,
    makeContract(),
    "/tmp/test",
  );
  assert.ok(strategy instanceof UnverifiedLanguageStrategy);
});

// --- P1: file_exists / file_contains 被消費 ---

test("selectVerificationStrategy: file_contains 釘死時用 FileContentStrategy (P1)", async () => {
  const card = makeCard({
    verification: {
      required: ["static"],
      commands: {
        file_contains: [{ file: "search-results.md", pattern: "candidate" }],
      },
    },
  });
  const strategy = await selectVerificationStrategy(
    card,
    makeContract(),
    "/tmp/test",
  );
  assert.ok(strategy instanceof FileContentStrategy);
});

test("selectVerificationStrategy: file_exists 釘死時用 FileExistenceStrategy (P1)", async () => {
  const card = makeCard({
    verification: {
      required: ["static"],
      commands: { file_exists: ["PLAN.md", "search-results.md"] },
    },
  });
  const strategy = await selectVerificationStrategy(
    card,
    makeContract(),
    "/tmp/test",
  );
  assert.ok(strategy instanceof FileExistenceStrategy);
});

test("selectVerificationStrategy: 顯式 file_exists 優先於 package.json 自動探測 (P1)", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(
      join(workspacePath, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "jest" } }),
    );
    const card = makeCard({
      workspace: { strategy: "direct", path: workspacePath },
      verification: {
        required: ["static"],
        commands: { file_exists: ["PLAN.md"] },
      },
    });
    const strategy = await selectVerificationStrategy(
      card,
      makeContract(),
      workspacePath,
    );
    assert.ok(strategy instanceof FileExistenceStrategy);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
