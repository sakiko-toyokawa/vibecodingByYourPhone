import re
path = 'packages/server/src/loop/run-service.ts'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()
lines = text.split('\n')

types_to_remove = ['RunSummary','LedgerSummary','ActiveRun','ExecutionOutcome','CollectorOutcome','RunExecutionContext']
for name in types_to_remove:
    sig = -1
    for i,line in enumerate(lines):
        if line.startswith(f'export interface {name}') or line.startswith(f'interface {name}'):
            sig = i; break
    if sig < 0:
        print(f'warn type {name}'); continue
    start = sig
    while start > 0:
        line = lines[start-1].strip()
        if line.startswith('/**'): start -= 1; break
        if line.startswith('*') or line == '': start -= 1
        else: break
    end = sig
    for i in range(sig+1, len(lines)):
        if lines[i].strip() == '' and i+1 < len(lines) and (lines[i+1].startswith('export') or lines[i+1].startswith('interface') or lines[i+1].startswith('/**')):
            end = i; break
        if lines[i].startswith('export ') or lines[i].startswith('interface '):
            end = i-1; break
    lines = lines[:start] + lines[end+1:]
    text = '\n'.join(lines); lines = text.split('\n')
    print(f'removed type {name}: {start+1}-{end+1}')

import_line = 'import type {\n  ActiveRun,\n  CollectorOutcome,\n  ExecutionOutcome,\n  LedgerSummary,\n  RunExecutionContext,\n  RunSummary,\n} from "./run/types.js";\n'
pos = text.find('\n} from "@yep-anywhere/shared";')
pos = text.find('\n', pos+1)
text = text[:pos+1] + import_line + text[pos+1:]
lines = text.split('\n')

helpers = ['defaultSleep','githubPromptWorkspacePath','loopRuntime','resolveExecutableCard','resolveRuntimeAssemblyContext','normalizeTurnOutput','hashNormalizedOutput','buildRetryContext','buildNextSubtaskContext','drainPolicyEscalation','buildHumanResumeContext']
for name in helpers:
    sig = -1
    for i,line in enumerate(lines):
        if line.startswith(f'function {name}') or line.startswith(f'async function {name}') or line.startswith(f'export function {name}') or line.startswith(f'export async function {name}'):
            sig = i; break
    if sig < 0:
        print(f'warn helper {name}'); continue
    start = sig
    while start > 0:
        line = lines[start-1].strip()
        if line.startswith('/**'): start -= 1; break
        if line.startswith('*') or line == '': start -= 1
        else: break
    open_line = sig
    for i in range(sig, len(lines)):
        if '{' in lines[i]: open_line = i; break
    count = 0; started = False; end = open_line
    for i in range(open_line, len(lines)):
        for ch in lines[i]:
            if ch == '{': count += 1; started = True
            elif ch == '}': count -= 1
        if started and count == 0: end = i; break
    lines = lines[:start] + lines[end+1:]
    text = '\n'.join(lines); lines = text.split('\n')
    print(f'removed helper {name}: {start+1}-{end+1}')

old_constructor = '''  constructor(deps: LoopRunServiceDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? defaultSleep;
    this.verify = deps.verifyRunFn ?? verifyRun;
    // A needs_human run keeps its active registration while it waits; the
    // control-plane calls this when a human decision terminates it (reject).
    deps.controlPlane?.onRunResolved((runId) => this.releaseRun(runId));
    // A blocked run that comes back to active continues with a new turn.
    deps.controlPlane?.onResumeRequested((signal) => {
      void this.continueRun(signal).catch((error) => {
        console.error(
          `[LoopRunService] failed to continue run ${signal.runId}:`,
          error,
        );
      });
    });
  }

  /** Release a resolved run's active registration + suspended context. */
  private releaseRun(runId: string): void {
    const active = this.state.activeByRunId.get(runId);
    if (active) {
      this.state.activeByRunId.delete(runId);
      this.state.activeByLoop.delete(active.loopId);
    }
    this.state.suspended.delete(runId);
  }'''
new_constructor = '''  constructor(deps: LoopRunServiceDeps) {
    this.deps = {
      ...deps,
      loopWatchdog: deps.loopWatchdog ?? {
        turnIdleTimeoutMs: 10 * 60 * 1000,
        turnIdleCheckIntervalMs: 30 * 1000,
        stagnationSimilarTurnsThreshold: 3,
      },
    };
    // A needs_human run keeps its active registration while it waits; the
    // control-plane calls this when a human decision terminates it (reject).
    deps.controlPlane?.onRunResolved((runId) => releaseRun(runId, this.state));
    // A blocked run that comes back to active continues with a new turn.
    deps.controlPlane?.onResumeRequested((signal) => {
      void continueRun(signal, this.deps, this.state).catch((error) => {
        console.error(
          `[LoopRunService] failed to continue run ${signal.runId}:`,
          error,
        );
      });
    });
  }'''
if old_constructor not in text:
    raise ValueError('constructor not found')
text = text.replace(old_constructor, new_constructor)
text = text.replace('void this.executeRun(active, card).catch((error) => {', 'void executeRun(active, card, this.deps, this.state).catch((error) => {')
lines = text.split('\n')

methods = ['buildLedgerSummary','executeRun','buildMemoryPacket','resolveExecutableCard','resolveRuntimeAssemblyContext','runTurns','continueRun','rebuildContext','runCollector','buildHumanFeedbackRefs','writeTurnHandoff','executeTurn','watchProcess']
for name in methods:
    sig = -1
    for i,line in enumerate(lines):
        if line.startswith(f'  {name}(') or line.startswith(f'  async {name}(') or line.startswith(f'  private {name}(') or line.startswith(f'  private async {name}('):
            sig = i; break
    if sig < 0:
        print(f'warn method {name}'); continue
    start = sig
    while start > 0:
        line = lines[start-1].strip()
        if line.startswith('/**'): start -= 1; break
        if line.startswith('*') or line == '': start -= 1
        else: break
    open_line = sig
    for i in range(sig, len(lines)):
        if '{' in lines[i]: open_line = i; break
    count = 0; started = False; end = open_line
    for i in range(open_line, len(lines)):
        for ch in lines[i]:
            if ch == '{': count += 1; started = True
            elif ch == '}': count -= 1
        if started and count == 0: end = i; break
    lines = lines[:start] + lines[end+1:]
    text = '\n'.join(lines); lines = text.split('\n')
    print(f'removed method {name}: {start+1}-{end+1}')

class_end = text.rfind('\n}')
if class_end < 0:
    raise ValueError('class end not found')
resume = '''\n  /**\n   * Resume runs that were active or retrying when the server restarted.\n   * Delegated to the turn-loop driver.\n   */\n  async resumeAfterRestart(loopId: string): Promise<void> {\n    return resumeAfterRestart(loopId, this.deps, this.state);\n  }\n'''
text = text[:class_end] + resume + text[class_end:]

with open(path, 'w', encoding='utf-8') as f:
    f.write(text)
print('done', len(text.split('\n')))
