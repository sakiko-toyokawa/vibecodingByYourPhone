# Real SDK Integration Plan

## Problem Summary

The previous agent misunderstood how the Claude Agent SDK works and started ripping out the real SDK in favor of mock-only behavior. The agent claimed:

> "The @anthropic-ai/claude-agent-sdk is designed to run inside the Claude Code CLI, not as a standalone server"

**This is incorrect.** The SDK is designed to be called FROM a Node.js process, which then SPAWNS the Claude Code CLI as a subprocess. The SDK handles IPC with the subprocess internally.

## How the SDK Actually Works

```
┌─────────────────────────────────────────────────────────────┐
│  Your Node.js Server (claude-anywhere)                      │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  @anthropic-ai/claude-agent-sdk                      │   │
│  │                                                       │   │
│  │  query({                                              │   │
│  │    prompt: messageGenerator(),                       │   │
│  │    options: {                                         │   │
│  │      cwd: "/path/to/project",                        │   │
│  │      systemPrompt: { type: "preset", preset: "claude_code" },
│  │      permissionMode: "default",                      │   │
│  │      canUseTool: async (tool, input) => { ... },     │   │
│  │    }                                                  │   │
│  │  })                                                   │   │
│  │                                                       │   │
│  │  ┌───────────────────────────────────────────────┐   │   │
│  │  │  Spawns subprocess:                            │   │   │
│  │  │  claude --output-format stream-json            │   │   │
│  │  │  --input-format stream-json ...                │   │   │
│  │  └───────────────────────────────────────────────┘   │   │
│  │                                                       │   │
│  │  Communicates via stdin/stdout JSON streaming        │   │
│  │                                                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Returns: AsyncIterator<SDKMessage>                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

The SDK:
1. Spawns the `claude` CLI as a child process
2. Pipes JSON messages over stdin/stdout
3. Returns an async iterator of messages
4. Handles tool approvals via the `canUseTool` callback

## Prerequisites for Real SDK

1. **Claude Code CLI must be installed** on the machine running the server
   - Via `curl -fsSL https://claude.ai/install.sh | bash`
   - Or via `npm install -g @anthropic-ai/claude-code`

2. **Valid Claude authentication** (API key or OAuth)
   - The CLI handles this via `~/.claude` credentials
   - Or `ANTHROPIC_API_KEY` environment variable

3. **The SDK must be able to find the CLI**
   - Either in PATH (automatic)
   - Or via `pathToClaudeCodeExecutable` option

## Current Code Issues

Looking at `/packages/server/src/sdk/real.ts`:

```typescript
const iterator = query({
  prompt: queue.generator(),
  options: {
    cwd: options.cwd,
    resume: options.resumeSessionId,
    abortController,
    permissionMode: options.permissionMode ?? "default",
    canUseTool,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
  },
});
```

The code looks correct! The issue is likely:
1. Claude CLI not installed on the development machine
2. No authentication configured
3. Missing error handling for subprocess spawn failures

## Recovery Steps

### Step 1: Add CLI Detection and Better Error Messages

Create a utility to detect the Claude CLI:

```typescript
// packages/server/src/sdk/cli-detection.ts
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ClaudeCliInfo {
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export function detectClaudeCli(): ClaudeCliInfo {
  // Try to find claude in PATH
  try {
    const claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (claudePath) {
      const version = execSync(`${claudePath} --version`, { encoding: 'utf-8' }).trim();
      return { found: true, path: claudePath, version };
    }
  } catch {}

  // Check common installation locations
  const commonPaths = [
    `${process.env.HOME}/.local/bin/claude`,
    '/usr/local/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];

  for (const path of commonPaths) {
    if (existsSync(path)) {
      try {
        const version = execSync(`${path} --version`, { encoding: 'utf-8' }).trim();
        return { found: true, path, version };
      } catch {}
    }
  }

  return {
    found: false,
    error: 'Claude CLI not found. Install via: curl -fsSL https://claude.ai/install.sh | bash',
  };
}
```

### Step 2: Update Server Startup

Modify `packages/server/src/index.ts` to check for CLI on startup:

```typescript
import { detectClaudeCli } from './sdk/cli-detection.js';

const cliInfo = detectClaudeCli();
if (!cliInfo.found) {
  console.error('⚠️  Claude CLI not found!');
  console.error('   The real SDK requires Claude CLI to be installed.');
  console.error('   Install: curl -fsSL https://claude.ai/install.sh | bash');
  console.error('');
  console.error('   Starting with mock SDK instead...');
  // Fall back to mock SDK or exit
}

console.log(`✓ Claude CLI found: ${cliInfo.path} (${cliInfo.version})`);
```

### Step 3: Add Proper Error Handling in RealClaudeSDK

The SDK can throw errors if:
- CLI not found
- Authentication fails
- Process spawn fails

Update `real.ts` to handle these:

```typescript
async startSession(options: StartSessionOptions): Promise<StartSessionResult> {
  const queue = new MessageQueue();
  const abortController = new AbortController();

  queue.push(options.initialMessage);

  try {
    const iterator = query({
      prompt: queue.generator(),
      options: {
        cwd: options.cwd,
        resume: options.resumeSessionId,
        abortController,
        permissionMode: options.permissionMode ?? "default",
        canUseTool: /* ... */,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
      },
    });

    return {
      iterator: this.wrapIterator(iterator),
      queue,
      abort: () => abortController.abort(),
    };
  } catch (error) {
    // Handle common errors
    if (error instanceof Error) {
      if (error.message.includes('Claude Code executable not found')) {
        throw new Error(
          'Claude CLI not installed. Run: curl -fsSL https://claude.ai/install.sh | bash'
        );
      }
      if (error.message.includes('SPAWN_ERROR')) {
        throw new Error(`Failed to spawn Claude CLI: ${error.message}`);
      }
    }
    throw error;
  }
}
```

### Step 4: Add E2E Tests with Real SDK

Create a new test file that uses actual Claude tokens:

```typescript
// packages/server/test/e2e/real-sdk.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { detectClaudeCli } from '../../src/sdk/cli-detection.js';
import { RealClaudeSDK } from '../../src/sdk/real.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

describe('Real SDK E2E', () => {
  let sdk: RealClaudeSDK;
  let testDir: string;

  beforeAll(() => {
    const cliInfo = detectClaudeCli();
    if (!cliInfo.found) {
      console.log('Skipping real SDK tests - CLI not installed');
      return;
    }

    // Create a temp directory for the test project
    testDir = mkdtempSync(join(tmpdir(), 'claude-anywhere-e2e-'));
    
    // Create a simple file to test against
    writeFileSync(join(testDir, 'test.txt'), 'Hello from test file');
    
    sdk = new RealClaudeSDK();
  });

  afterAll(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('should start a session and receive messages', async () => {
    const cliInfo = detectClaudeCli();
    if (!cliInfo.found) {
      return; // Skip if CLI not installed
    }

    const { iterator, queue, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: { text: 'Say "hello test" and nothing else' },
      permissionMode: 'bypassPermissions', // For E2E tests only
    });

    const messages: any[] = [];
    
    // Collect messages with a timeout
    const timeout = setTimeout(() => abort(), 30000);
    
    try {
      for await (const message of iterator) {
        messages.push(message);
        console.log('Message:', message.type, message.subtype);
        
        // Stop after we get a result
        if (message.type === 'result') {
          break;
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    // We should have received at least init + assistant + result
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].type).toBe('system');
    expect(messages[0].subtype).toBe('init');
  }, 60000); // 60s timeout for real API call

  it('should handle tool approval callbacks', async () => {
    const cliInfo = detectClaudeCli();
    if (!cliInfo.found) {
      return;
    }

    const toolRequests: any[] = [];

    const { iterator, abort } = await sdk.startSession({
      cwd: testDir,
      initialMessage: { text: 'Read the file test.txt' },
      permissionMode: 'default', // Will trigger approval
      onToolApproval: async (toolName, input, opts) => {
        toolRequests.push({ toolName, input });
        // Auto-approve for test
        return { behavior: 'allow' };
      },
    });

    const messages: any[] = [];
    const timeout = setTimeout(() => abort(), 60000);
    
    try {
      for await (const message of iterator) {
        messages.push(message);
        if (message.type === 'result') break;
      }
    } finally {
      clearTimeout(timeout);
    }

    // Should have triggered at least one tool approval for FileRead
    expect(toolRequests.length).toBeGreaterThan(0);
  }, 90000);
});
```

### Step 5: Add Development Mode Detection

Allow switching between mock and real SDK:

```typescript
// packages/server/src/config.ts
export function loadConfig() {
  const useMockSdk = process.env.USE_MOCK_SDK === 'true';
  
  return {
    // ...existing config
    useMockSdk,
  };
}
```

Update the scripts:
```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "dev:mock": "USE_MOCK_SDK=true tsx src/dev-mock.ts",
    "dev:real": "tsx src/index.ts",
    "test:e2e:real": "REAL_SDK_TESTS=true vitest run test/e2e"
  }
}
```

### Step 6: Project Scanner Fix

The project scanner likely needs to point to the actual `~/.claude/projects` directory:

```typescript
// packages/server/src/projects/scanner.ts
import { homedir } from 'os';
import { join } from 'path';

export class ProjectScanner {
  private projectsDir: string;

  constructor(options?: { projectsDir?: string }) {
    this.projectsDir = options?.projectsDir ?? join(homedir(), '.claude', 'projects');
  }
  
  // ...
}
```

## Testing Strategy

### Unit Tests (Mock SDK)
- Test the Supervisor process management
- Test the SSE streaming
- Test the message queue
- Test the session reader

### Integration Tests (Mock SDK)
- Test API routes with mock responses
- Test client-server communication
- Test reconnection handling

### E2E Tests (Real SDK)
- Optional, requires Claude CLI and API key
- Skip if prerequisites not met
- Use `bypassPermissions` for automation
- Small, focused prompts to minimize token usage

### E2E Test Environment Variables
```bash
# .env.test
ANTHROPIC_API_KEY=your-key-here
REAL_SDK_TESTS=true
```

## Migration Checklist

- [ ] Add CLI detection utility
- [ ] Update server startup to check for CLI
- [ ] Add proper error handling in RealClaudeSDK
- [ ] Update config to support mock/real mode switching
- [ ] Fix project scanner to use real `~/.claude/projects`
- [ ] Add E2E test file for real SDK
- [ ] Update package.json scripts
- [ ] Add documentation for prerequisites
- [ ] Test on a machine with Claude CLI installed

## Reference: Claude Code Viewer Integration

The `claude-code-viewer` project has a working integration. Key patterns:

1. **CLI Detection** (`ClaudeCode.ts`):
   - Uses `which -a claude` to find CLI
   - Supports `CLAUDE_CODE_VIEWER_CC_EXECUTABLE_PATH` override
   - Gets version with `claude --version`

2. **SDK Selection** (`ClaudeCode.ts`):
   - Supports both `@anthropic-ai/claude-agent-sdk` (newer) and `@anthropic-ai/claude-code` (older)
   - Chooses based on CLI version

3. **Message Generator Pattern** (`createMessageGenerator.ts`):
   - Creates an async generator that yields user messages
   - Allows queuing messages while Claude is working

## Questions to Answer

1. Is Claude CLI installed on the development machine?
   ```bash
   which claude
   claude --version
   ```

2. Is Claude authenticated?
   ```bash
   claude auth status
   # or check ~/.claude/ for credentials
   ```

3. Can we run a simple CLI test?
   ```bash
   echo '{"text": "say hello"}' | claude --output-format stream-json
   ```

---

## Executive Summary

### The Problem
The previous agent incorrectly believed the SDK must run "inside" Claude Code. It started replacing the real SDK with mock-only code.

### The Truth
The SDK spawns Claude Code as a subprocess. Your Node.js server calls the SDK, which spawns `claude` CLI, and streams messages back.

### What's Actually Working
Looking at the code, the `RealClaudeSDK` class in `real.ts` is actually correctly structured! The integration pattern matches `claude-code-viewer`.

### What's Missing
1. **CLI detection** - The server doesn't check if Claude CLI exists before trying to use it
2. **Error handling** - Spawn failures aren't caught gracefully
3. **E2E tests** - No tests that verify the real SDK works

### Immediate Actions

1. **Verify your setup** (on your laptop):
   ```bash
   which claude          # Should show path
   claude --version      # Should show version
   claude auth status    # Should show authenticated
   ```

2. **Run the real server** (not the mock):
   ```bash
   cd packages/server
   pnpm dev              # This runs index.ts with RealClaudeSDK
   # NOT pnpm dev:mock   # This runs dev-mock.ts with MockClaudeSDK
   ```

3. **Check the console** for errors - if Claude CLI isn't found, you'll see spawn errors

4. **Add CLI detection** as a first line of defense (code provided above)

### Files to Modify

| File | Change |
|------|--------|
| `src/sdk/cli-detection.ts` | NEW - Add CLI detection utility |
| `src/index.ts` | Add startup check for CLI |
| `src/sdk/real.ts` | Add better error handling |
| `test/e2e/real-sdk.e2e.test.ts` | NEW - Add real SDK tests |

### Don't Panic
The mock SDK is fine for UI development and testing. The real SDK integration is structurally correct - it just needs:
1. Better error messages when Claude CLI isn't available
2. A clear development workflow (mock for UI work, real for integration)
3. E2E tests to verify real SDK works
