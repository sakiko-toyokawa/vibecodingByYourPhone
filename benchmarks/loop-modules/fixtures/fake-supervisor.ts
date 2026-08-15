import {
  EXECUTOR_SUMMARY_BEGIN,
  EXECUTOR_SUMMARY_END,
} from "../../../packages/server/src/loop/assembly/runtime-input.js";
import type { Process } from "../../packages/server/src/supervisor/Process.js";
import type { Supervisor } from "../../packages/server/src/supervisor/Supervisor.js";

export interface FakeSupervisorCall {
  method: "start" | "resume";
  role: "executor" | "collector";
  sessionId: string | null;
  text: string;
}

export interface FakeSupervisorOptions {
  /** When true, every new process emits a successful result immediately. */
  autoSucceed?: boolean;
  /** Fixed session id to return; defaults to a random id. */
  sessionId?: string;
  /**
   * Multi-turn script: array of results to emit across executor turns.
   * Each entry is used for one executor invocation; the last entry is final.
   * When set, autoSucceed is ignored.
   */
  turns?: Array<{
    result: string;
    usage?: { input_tokens: number; output_tokens: number };
  }>;
}

export class FakeSupervisor {
  readonly calls: FakeSupervisorCall[] = [];
  autoSucceed = false;
  private listener: ((event: unknown) => void) | null = null;
  private readonly defaultSessionId: string;
  private readonly turns?: FakeSupervisorOptions["turns"];
  private executorTurn = 0;

  constructor(options: FakeSupervisorOptions = {}) {
    this.defaultSessionId = options.sessionId ?? `fake-session-${Date.now()}`;
    this.autoSucceed = options.autoSucceed ?? false;
    this.turns = options.turns;
  }

  async startSession(
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    const sessionId = this.defaultSessionId;
    const role: FakeSupervisorCall["role"] = message.text.includes(
      "Collector input bundle",
    )
      ? "collector"
      : "executor";
    this.calls.push({
      method: "start",
      role,
      sessionId: null,
      text: message.text,
    });
    return this.makeProcess(sessionId, role);
  }

  async resumeSession(
    sessionId: string,
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    this.calls.push({
      method: "resume",
      role: "executor",
      sessionId,
      text: message.text,
    });
    return this.makeProcess(sessionId, "executor");
  }

  private makeProcess(
    sessionId: string,
    role: FakeSupervisorCall["role"],
  ): Process {
    return {
      sessionId,
      subscribe: (listener: (event: unknown) => void) => {
        this.listener = listener;
        queueMicrotask(() => {
          listener({
            type: "message",
            message: { type: "assistant", content: "working on it" },
          });
          if (role === "collector") {
            const hasMoreTurns = this.turns
              ? this.executorTurn < this.turns.length
              : false;
            listener({
              type: "message",
              message: {
                type: "result",
                subtype: "success",
                result: JSON.stringify({
                  collector_phase: "review",
                  status: "passed",
                  evidence_refs: [],
                  unresolved_risks: [],
                  recommendation: hasMoreTurns ? "continue" : "stop",
                  confidence: 0.7,
                  requires_human: false,
                  summary: "collector summary",
                }),
                is_error: false,
                usage: { input_tokens: 10, output_tokens: 5 },
              },
            });
          } else if (this.turns) {
            const turn = this.turns[this.executorTurn] ?? this.turns.at(-1);
            if (turn) {
              listener({
                type: "message",
                message: {
                  type: "result",
                  subtype: "success",
                  result: turn.result,
                  is_error: false,
                  usage: turn.usage ?? { input_tokens: 10, output_tokens: 5 },
                },
              });
            }
            this.executorTurn += 1;
          } else if (this.autoSucceed) {
            listener({
              type: "message",
              message: {
                type: "result",
                subtype: "success",
                result: [
                  "turn report text",
                  EXECUTOR_SUMMARY_BEGIN,
                  "- 已完成：turn completed",
                  "- 風險：none",
                  "- 文件：none",
                  EXECUTOR_SUMMARY_END,
                ].join("\n"),
                is_error: false,
                usage: { input_tokens: 10, output_tokens: 5 },
              },
            });
          }
        });
        return () => {};
      },
      terminate: (reason: string) => {
        this.listener?.({ type: "terminated", reason });
      },
      abort: async () => {},
      respondToInput: () => {},
      // run-service 的心跳每 4 分钟 queueMessage 一次; 假进程 no-op 即可,
      // 缺了会在长 settle 的用例里抛 TypeError。
      queueMessage: () => {},
    } as unknown as Process;
  }
}

export function asSupervisor(fake: FakeSupervisor): Supervisor {
  return fake as unknown as Supervisor;
}
