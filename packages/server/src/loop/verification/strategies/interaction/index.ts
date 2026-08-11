import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoopCard, VerifierReport } from "@yep-anywhere/shared";
import { VerifierReportSchema } from "@yep-anywhere/shared";
import { z } from "zod";
import { extractJson } from "../../agent/parse.js";
import type {
  VerificationInput,
  VerificationStrategy,
} from "../../strategy.js";
import {
  type SubprocessOutcome,
  runCommand,
} from "../../subprocess-verifier.js";
import {
  type InteractionDependencyCheck,
  checkInteractionDependencies,
} from "./dependency-check.js";

const DEFAULT_INTERACTION_TIMEOUT_MS = 120_000;

const AgentScriptSchema = z.object({
  script: z.string().min(1),
  rationale: z.string().optional(),
  assumptions: z.array(z.string()).default([]),
});

export type GenerateInteractionScript = (
  input: VerificationInput,
  options: { url: string },
) => Promise<string>;

export type ExecuteInteractionScript = (
  script: string,
  input: VerificationInput,
  options: { url: string; timeoutMs: number },
) => Promise<SubprocessOutcome>;

export interface InteractionAgentStrategyOptions {
  config?: NonNullable<LoopCard["loop"]["verification"]["interaction"]>;
  checkDependencies?: (
    workspacePath: string,
  ) => Promise<InteractionDependencyCheck>;
  generateScript?: GenerateInteractionScript;
  executeScript?: ExecuteInteractionScript;
}

export class InteractionAgentStrategy implements VerificationStrategy {
  readonly name = "interaction_agent";
  private readonly config: NonNullable<
    LoopCard["loop"]["verification"]["interaction"]
  >;
  private readonly checkDependencies: (
    workspacePath: string,
  ) => Promise<InteractionDependencyCheck>;
  private readonly generateScript?: GenerateInteractionScript;
  private readonly executeScript: ExecuteInteractionScript;

  constructor(options: InteractionAgentStrategyOptions = {}) {
    this.config = options.config ?? {};
    this.checkDependencies =
      options.checkDependencies ?? checkInteractionDependencies;
    this.generateScript = options.generateScript;
    this.executeScript = options.executeScript ?? executeScriptWithNode;
  }

  async verify(input: VerificationInput): Promise<VerifierReport> {
    const suffix = input.turn === 1 ? "" : `-turn${input.turn}`;
    const deps = await this.checkDependencies(input.workspacePath);
    const depsRef = await input.writeEvidence(
      `interaction-deps${suffix}.json`,
      `${JSON.stringify(deps, null, 2)}\n`,
    );
    if (deps.status !== "ready") {
      return VerifierReportSchema.parse({
        verifier_phase: input.phase,
        status: "inconclusive",
        evidence_refs: [depsRef],
        unresolved_risks: [
          `${deps.message}${
            deps.installCommand ? `; install with: ${deps.installCommand}` : ""
          }`,
        ],
        recommendation: "escalate",
        confidence: 0.2,
        requires_human: true,
      });
    }

    if (!this.generateScript) {
      return VerifierReportSchema.parse({
        verifier_phase: input.phase,
        status: "inconclusive",
        evidence_refs: [depsRef],
        unresolved_risks: [
          "interaction phase requires an agent script generator, but none was provided",
        ],
        recommendation: "escalate",
        confidence: 0.1,
        requires_human: true,
      });
    }

    const url = this.config.url ?? "http://localhost:3400";
    const agentOutput = await this.generateScript(input, { url });
    const outputRef = await input.writeEvidence(
      `interaction-agent-output${suffix}.txt`,
      agentOutput,
    );
    const raw = extractJson(agentOutput);
    const parsed = raw === null ? null : AgentScriptSchema.safeParse(raw);
    if (!parsed || !parsed.success) {
      return VerifierReportSchema.parse({
        verifier_phase: input.phase,
        status: "inconclusive",
        evidence_refs: [depsRef, outputRef],
        unresolved_risks: [
          "interaction agent 輸出無法解析為合法 Playwright 腳本 JSON",
        ],
        recommendation: "escalate",
        confidence: 0.1,
        requires_human: false,
      });
    }

    const script = parsed.data.script;
    const scriptRef = await input.writeEvidence(
      `interaction-test${suffix}.mjs`,
      script.endsWith("\n") ? script : `${script}\n`,
    );
    const timeoutMs =
      this.config.timeout_ms ??
      input.timeoutMs ??
      DEFAULT_INTERACTION_TIMEOUT_MS;
    const outcome = await this.executeScript(script, input, { url, timeoutMs });
    const log = [
      `url: ${url}`,
      `outcome: ${outcome.kind}${
        outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ""
      } in ${outcome.durationMs}ms`,
      "",
      outcome.output,
    ].join("\n");
    const logRef = await input.writeEvidence(
      `interaction-output${suffix}.log`,
      log,
    );

    if (outcome.kind === "exit" && outcome.exitCode === 0) {
      return VerifierReportSchema.parse({
        verifier_phase: input.phase,
        status: "passed",
        evidence_refs: [depsRef, outputRef, scriptRef, logRef],
        unresolved_risks: parsed.data.assumptions.map(
          (assumption) => `interaction assumption: ${assumption}`,
        ),
        recommendation: "stop",
        confidence: 0.9,
        requires_human: false,
      });
    }

    if (outcome.kind === "exit") {
      return VerifierReportSchema.parse({
        verifier_phase: input.phase,
        status: "failed",
        evidence_refs: [depsRef, outputRef, scriptRef, logRef],
        unresolved_risks: [
          `interaction Playwright script exited with code ${outcome.exitCode}`,
        ],
        recommendation: "retry",
        confidence: 0.85,
        requires_human: false,
      });
    }

    return VerifierReportSchema.parse({
      verifier_phase: input.phase,
      status: "inconclusive",
      evidence_refs: [depsRef, outputRef, scriptRef, logRef],
      unresolved_risks: [
        outcome.kind === "timeout"
          ? `interaction Playwright script timed out after ${timeoutMs}ms`
          : "interaction Playwright script could not be executed",
      ],
      recommendation: "escalate",
      confidence: 0.2,
      requires_human: true,
    });
  }
}

async function executeScriptWithNode(
  script: string,
  input: VerificationInput,
  options: { url: string; timeoutMs: number },
): Promise<SubprocessOutcome> {
  const file = path.join(
    tmpdir(),
    `yep-interaction-${input.contract.intent_id}-${input.turn}-${Date.now()}.mjs`,
  );
  await writeFile(
    file,
    script.endsWith("\n") ? script : `${script}\n`,
    "utf-8",
  );
  return runCommand(`node "${file}"`, {
    cwd: input.workspacePath,
    timeoutMs: options.timeoutMs,
    env: { INTERACTION_URL: options.url },
  });
}
