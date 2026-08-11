import { join } from "node:path";
import { ControlPlane } from "../../packages/server/src/loop/control-plane/control-plane.js";
import { RunStateStore } from "../../packages/server/src/loop/control-plane/run-state-store.js";
import { LoopRunService } from "../../packages/server/src/loop/run-service.js";
import { LoopCardStore } from "../../packages/server/src/loop/state/loop-card-store.js";
import { RunLedgerStore } from "../../packages/server/src/loop/state/run-ledger-store.js";
import type { AgentProvider } from "../../packages/server/src/sdk/providers/types.js";
import { Supervisor } from "../../packages/server/src/supervisor/Supervisor.js";
import type {
  DecisionEntry,
  FailureTag,
  VerificationPhase,
} from "../../packages/shared/src/index.js";
import type { LoopCard } from "../../packages/shared/src/loop-schema/loop-card.js";
import type { RunState } from "../../packages/shared/src/loop-schema/run-ledger.js";
import { createFakeEventBus } from "../loop-modules/fixtures/fake-event-bus.js";
import { FakeSupervisor } from "../loop-modules/fixtures/fake-supervisor.js";
import { withTempDataDir } from "../loop-modules/fixtures/temp-data-dir.js";
import { makeTestWorkspace } from "./fixtures/make-workspace.js";

export interface RuntimeEvalOptions {
  /** Task prompt given to the loop. */
  prompt: string;
  /** Workspace target: if omitted, a temp git repo is created. */
  workspacePath?: string;
  /** Static verification result. */
  lintFails?: boolean;
  /** Runtime verification result. */
  testFails?: boolean;
  /** Budget limits. */
  maxTurns?: number;
  maxRetries?: number;
  maxTimeMinutes?: number;
  /** Polling timeout in ms. */
  timeoutMs?: number;
  /** Real provider for Phase 7 full-chain runs. */
  provider?: AgentProvider;
  /** Model override from PHASE7_MODEL. */
  model?: string;
  /** Verifier chain used by the generated card. */
  verificationRequired?: VerificationPhase[];
  /** Enable intent understanding agent gate. */
  useIntentAgent?: boolean;
  /** Task type projected into the card handoff. */
  taskType?: string;
  /** Artifacts that must be present for a full-chain case to pass. */
  expectedArtifacts?: string[];
  /** Failure tags that must appear when the case intentionally fails. */
  expectedFailureTags?: FailureTag[];
  /**
   * Multi-turn script for the fake executor.
   * Each entry drives one executor turn; the collector will recommend
   * "continue" while turns remain and "stop" after the last turn.
   */
  turns?: Array<{
    result: string;
    usage?: { input_tokens: number; output_tokens: number };
  }>;
}

export interface StageCheck {
  stage:
    | "trigger"
    | "contract"
    | "assembly"
    | "execution"
    | "verification"
    | "judgment"
    | "control_decision"
    | "state_persistence";
  passed: boolean;
  score: number; // 0..1
  reason: string;
  evidence: Record<string, unknown>;
}

export interface RuntimeEvalResult {
  loopId: string;
  runId: string;
  finalState: RunState | null;
  terminal: boolean;
  elapsedMs: number;
  stateTrace: { at: string; state: RunState; turn: number }[];
  stages: StageCheck[];
  artifacts: Record<string, string | undefined>;
  failureTags: FailureTag[];
  metrics: {
    makerTokens: number;
    verifierTokens: number;
    stateLogReadMs: number;
    checkpointCount: number;
    handoffCount: number;
  };
  ledgerSummary: {
    decisions: number;
    runEntries: number;
  };
}

function makeLoopCard(
  workspacePath: string,
  options: RuntimeEvalOptions,
): LoopCard {
  const id = `eval-${Date.now()}`;
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      handoff: {
        default_task_type: options.taskType ?? "maintenance",
        task: options.prompt,
      },
      workspace: {
        strategy: "direct",
        path: workspacePath,
      },
      verification: {
        required: options.verificationRequired ?? ["static", "runtime"],
      },
      runtime: options.provider
        ? {
            provider: options.provider.name,
            model: options.model,
          }
        : undefined,
      intent_understanding: options.useIntentAgent
        ? { use_agent: true }
        : undefined,
      persistence: {
        state_file: `state/${id}.json`,
      },
      stop_rules: {
        max_turns: options.maxTurns ?? 3,
        max_retries: options.maxRetries ?? 2,
        max_time_minutes: options.maxTimeMinutes ?? 10,
      },
    },
  };
}

function isTerminal(state: RunState): boolean {
  return ["complete", "failed", "budget_limited", "needs_human"].includes(
    state,
  );
}

export async function runRuntimeEvaluation(
  options: RuntimeEvalOptions,
): Promise<RuntimeEvalResult> {
  return withTempDataDir(async (dataDir) => {
    const workspacePath =
      options.workspacePath ??
      (await makeTestWorkspace({
        lintFails: options.lintFails,
        testFails: options.testFails,
      }));

    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();

    const runLedgerStore = new RunLedgerStore({ dataDir });
    const runStateStore = new RunStateStore({ dataDir });
    const { bus: eventBus, events } = createFakeEventBus();

    const controlPlane = new ControlPlane({
      runStateStore,
      runLedgerStore,
      eventBus,
    });

    const supervisor = options.provider
      ? new Supervisor({ provider: options.provider, eventBus })
      : options.turns
        ? new FakeSupervisor({ turns: options.turns })
        : new FakeSupervisor({ autoSucceed: true });
    const runService = new LoopRunService({
      supervisor: supervisor as never,
      loopCardStore,
      runLedgerStore,
      runStateStore,
      controlPlane,
      sleep: async () => {},
    });

    const card = makeLoopCard(workspacePath, options);
    await loopCardStore.createLoop(card);

    const start = Date.now();
    const run = await runService.startRun(card.loop.id, "manual");
    const runId = run.run_id;
    const loopId = card.loop.id;
    console.error(`[phase7] run started: ${runId} loop=${loopId}`);

    const stateTrace: RuntimeEvalResult["stateTrace"] = [];
    const deadline = start + (options.timeoutMs ?? 60_000);

    while (Date.now() < deadline) {
      const state = controlPlane.currentStateOf(runId);
      const record = state ? await controlPlane.getRunState(loopId) : null;
      if (state) {
        stateTrace.push({
          at: new Date().toISOString(),
          state,
          turn: record?.turn ?? 0,
        });
        if (
          stateTrace.length === 1 ||
          stateTrace.at(-2)?.state !== stateTrace.at(-1)?.state
        ) {
          console.error(
            `[phase7] state=${state} turn=${record?.turn ?? 0} elapsedMs=${Date.now() - start}`,
          );
        }
        if (isTerminal(state)) break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const finalState = controlPlane.currentStateOf(runId) ?? null;
    await waitForRunArtifacts(
      runLedgerStore,
      runId,
      options.expectedArtifacts ?? [],
      10_000,
    );
    const elapsedMs = Date.now() - start;

    // Read ledger and artifacts.
    const decisionEntries = await runLedgerStore.readDecisionEntries(runId);
    const runEntriesRaw = await runLedgerStore.readUri(`ledger://${runId}`);
    const runEntryCount = runEntriesRaw
      ? runEntriesRaw.trim().split("\n").length
      : 0;

    const artifactNames = await runLedgerStore.listArtifacts(runId);
    const artifacts: Record<string, string | undefined> = {};
    for (const name of artifactNames) {
      artifacts[name] = await runLedgerStore.readArtifact(runId, name);
    }

    const stateLogStart = performance.now();
    const stateEvents = await runStateStore.readEvents(loopId);
    const stateLogReadMs = performance.now() - stateLogStart;
    const { makerTokens, verifierTokens } = sumTokenUsage(artifacts);
    const failureTags = [
      ...new Set<FailureTag>(
        decisionEntries.flatMap((entry) => entry.failure_tags ?? []),
      ),
    ];

    const stages = evaluateStages({
      finalState,
      runId,
      loopId,
      artifacts,
      decisionEntries,
      events,
      stateTrace,
      options,
    });

    return {
      loopId,
      runId,
      finalState,
      terminal: finalState ? isTerminal(finalState) : false,
      elapsedMs,
      stateTrace,
      stages,
      artifacts,
      failureTags,
      metrics: {
        makerTokens,
        verifierTokens,
        stateLogReadMs,
        checkpointCount: stateEvents.filter(
          (event) => event.type === "checkpoint",
        ).length,
        handoffCount: artifactNames.filter(
          (name) => name === "human-report.md" || name === "machine-state.json",
        ).length,
      },
      ledgerSummary: {
        decisions: decisionEntries.length,
        runEntries: runEntryCount,
      },
    };
  });
}

/** Wait for ledger/handoff writes that complete after the terminal state. */
async function waitForRunArtifacts(
  store: RunLedgerStore,
  runId: string,
  expectedArtifacts: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = await store.readEntry(runId);
    const names = await store.listArtifacts(runId);
    const complete =
      entry !== null && expectedArtifacts.every((name) => names.includes(name));
    if (complete || Date.now() >= deadline) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function safeJsonParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function evaluateStages(ctx: {
  finalState: RunState | null;
  runId: string;
  loopId: string;
  artifacts: Record<string, string | undefined>;
  decisionEntries: DecisionEntry[];
  events: { type: string; data?: unknown }[];
  stateTrace: RuntimeEvalResult["stateTrace"];
  options: RuntimeEvalOptions;
}): StageCheck[] {
  const stages: StageCheck[] = [];

  // 1. trigger
  stages.push({
    stage: "trigger",
    passed: ctx.runId.length > 0,
    score: ctx.runId.length > 0 ? 1 : 0,
    reason: ctx.runId.length > 0 ? "Run was created" : "Run was not created",
    evidence: { runId: ctx.runId },
  });

  // 2. contract
  const intentArtifact = ctx.artifacts["intent-contract.json"];
  stages.push({
    stage: "contract",
    passed: !!intentArtifact,
    score: intentArtifact ? 1 : 0,
    reason: intentArtifact
      ? "Intent contract artifact was persisted"
      : "Intent contract artifact missing",
    evidence: { hasIntentContract: !!intentArtifact },
  });

  // 3. assembly
  const runtimeInput = ctx.artifacts["runtime-input-bundle.json"];
  stages.push({
    stage: "assembly",
    passed: !!runtimeInput,
    score: runtimeInput ? 1 : 0,
    reason: runtimeInput
      ? "Runtime input bundle was assembled"
      : "Runtime input bundle missing",
    evidence: { hasRuntimeInputBundle: !!runtimeInput },
  });

  // 4. execution
  const hasActive = ctx.stateTrace.some((s) => s.state === "active");
  const hasComplete = ctx.stateTrace.some(
    (s) => s.state === "complete" || s.turn > 0,
  );
  stages.push({
    stage: "execution",
    passed: hasComplete,
    score: hasComplete ? 1 : hasActive ? 0.5 : 0,
    reason: hasComplete
      ? "Execution turn completed"
      : hasActive
        ? "Execution started but did not complete"
        : "Execution did not reach active state",
    evidence: { stateTransitions: ctx.stateTrace.map((s) => s.state) },
  });

  // 5. verification
  const verifierReportKeys = Object.keys(ctx.artifacts).filter(
    (n) => n.startsWith("verifier-report") && !n.includes("turn"),
  );
  const latestVerifiers = safeJsonParse(
    ctx.artifacts[
      verifierReportKeys.find((n) => n.startsWith("verifier-reports")) ?? ""
    ],
  ) as Array<{ status: string }> | undefined;
  const anyHardFailed = latestVerifiers?.some((r) => r.status === "failed");
  const anyUnverified = latestVerifiers?.some((r) => r.status === "unverified");
  const allPassed = latestVerifiers?.every((r) => r.status === "passed");
  const hasVerifierReports = verifierReportKeys.length > 0;
  stages.push({
    stage: "verification",
    passed: hasVerifierReports && !anyHardFailed && !anyUnverified,
    score: !hasVerifierReports ? 0 : allPassed ? 1 : 0.5,
    reason: !hasVerifierReports
      ? "No verifier reports found"
      : allPassed
        ? "All verifier reports passed"
        : anyUnverified
          ? "Verifier reports produced but some phases could not be verified"
          : "Verifier reports produced but some phases failed",
    evidence: { verifierStatuses: latestVerifiers?.map((r) => r.status) },
  });

  // 6. judgment
  const judgment = safeJsonParse(ctx.artifacts["judgment-report.json"]) as
    | { overall?: string; next_action?: string }
    | undefined;
  const judgmentPassed = !!judgment && judgment.overall === "passed";
  stages.push({
    stage: "judgment",
    passed: judgmentPassed,
    score: judgment ? (judgmentPassed ? 1 : 0.5) : 0,
    reason: judgment
      ? `Judgment overall=${judgment.overall ?? "unknown"}, next_action=${judgment.next_action ?? "unknown"}`
      : "Judgment report missing",
    evidence: { judgment },
  });

  // 7. control decision
  const finalDecision = ctx.decisionEntries.at(-1);
  const successStates = new Set<RunState>(["complete"]);
  const acceptableTerminal = new Set<RunState>([
    "complete",
    "needs_human",
    "budget_limited",
    "failed",
  ]);
  const decisionScore = ctx.finalState
    ? successStates.has(ctx.finalState)
      ? 1
      : acceptableTerminal.has(ctx.finalState)
        ? 0.5
        : 0
    : 0;
  stages.push({
    stage: "control_decision",
    passed: decisionScore === 1,
    score: decisionScore,
    reason: ctx.finalState
      ? `Control plane reached final state ${ctx.finalState}; last decision=${finalDecision?.decision ?? "none"}`
      : "Control plane did not reach a final state",
    evidence: {
      finalState: ctx.finalState,
      lastDecision: finalDecision?.decision,
    },
  });

  // 8. state persistence
  const hasStateFile = ctx.events.some((e) => e.type === "loop-state-changed");
  stages.push({
    stage: "state_persistence",
    passed: hasStateFile,
    score: hasStateFile ? 1 : 0,
    reason: hasStateFile
      ? "loop-state-changed events were emitted and persisted"
      : "No loop-state-changed events observed",
    evidence: { eventTypes: ctx.events.map((e) => e.type) },
  });

  return stages;
}

function sumTokenUsage(artifacts: Record<string, string | undefined>): {
  makerTokens: number;
  verifierTokens: number;
} {
  let makerTokens = 0;
  let verifierTokens = 0;
  for (const [name, content] of Object.entries(artifacts)) {
    if (!content) {
      continue;
    }
    if (name.startsWith("runtime-events")) {
      makerTokens += sumRuntimeEventTokens(content);
    } else if (
      /(collector|verifier-agent|interaction-agent)-usage/.test(name)
    ) {
      verifierTokens += sumUsageJson(content);
    }
  }
  return { makerTokens, verifierTokens };
}

function sumRuntimeEventTokens(content: string): number {
  let total = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as {
        message?: {
          type?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
      };
      const usage = event.message?.usage;
      if (usage) {
        total += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      }
    } catch {
      // Corrupt benchmark artifact lines are ignored.
    }
  }
  return total;
}

function sumUsageJson(content: string): number {
  try {
    const usage = JSON.parse(content) as {
      input_tokens?: number;
      output_tokens?: number;
      tokens?: number;
    };
    return (
      (usage.tokens ?? 0) +
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0)
    );
  } catch {
    return 0;
  }
}
