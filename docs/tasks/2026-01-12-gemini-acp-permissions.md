# Gemini ACP Permission Handling

## Executive Summary

Wire Gemini CLI's `requestPermission` ACP calls to yepanywhere's existing approval UI. Gemini executes its own tools internally but asks us for permission on sensitive operations.

## Key Discovery

Gemini uses a **hybrid model** - not the pure "client executes tools" model we originally assumed:

| Operation Type | Who Executes | Permission Required |
|----------------|--------------|---------------------|
| `read_file`, `list_directory`, `glob`, `search_file_content` | Gemini CLI | No |
| `write_file`, `replace` | Gemini CLI | Yes - `requestPermission` |
| `run_shell_command` | Gemini CLI | Yes - `requestPermission` |
| `web_fetch`, `google_web_search` | Gemini CLI | TBD (probably no) |

**Implication**: We don't need to implement tool handlers. Just handle `requestPermission`.

## Gemini's Built-in Tools

From user testing, Gemini CLI has these internal tools:

```
File Operations:
- list_directory    - View files and folders
- read_file         - Read file contents
- write_file        - Create or overwrite a file
- replace           - Surgically replace text within a file

Search & Navigation:
- search_file_content  - Fast grep-like search
- glob                 - Find files by name patterns

Execution & Web:
- run_shell_command   - Execute bash commands
- google_web_search   - Search the internet
- web_fetch           - Fetch URL content

Specialized:
- delegate_to_agent   - Hand off to codebase_investigator agent
- save_memory         - Remember user preferences
```

## Permission Request Format

When Gemini wants to do something sensitive, it sends:

```typescript
// ACP RequestPermissionRequest
{
  sessionId: "200da149-0a09-48c1-86d6-bd99fe3b4f2d",
  options: [
    { kind: "allow_always", name: "Allow All Edits", optionId: "proceed_always" },
    { kind: "allow_once", name: "Allow", optionId: "proceed_once" },
    { kind: "reject_once", name: "Reject", optionId: "cancel" }
  ],
  toolCall: {
    kind: "edit",  // or "command" for shell
    title: "Writing to test.txt",
    toolCallId: "write_file-1768220366439",
    status: "pending",
    locations: [{ path: "/home/user/project/test.txt" }],
    content: [
      { type: "diff", path: "test.txt", oldText: "", newText: "test123" }
    ]
  }
}
```

## Current State (Phase 1)

In `packages/server/src/sdk/providers/acp/client.ts:129-137`:

```typescript
requestPermission: async (params): Promise<RequestPermissionResponse> => {
  this.log.debug({ params }, "ACP permission request (cancelling - Phase 1)");
  return { outcome: { outcome: "cancelled" } };  // Always rejects
}
```

This immediately returns `cancelled` - no waiting, no UI. That's why writes fail.

## Implementation Plan

### Step 1: Add Permission Request Callback to ACPClient

**File**: `packages/server/src/sdk/providers/acp/client.ts`

```typescript
// New types
export type PermissionRequestCallback = (
  request: RequestPermissionRequest
) => Promise<RequestPermissionResponse>;

export class ACPClient {
  // ... existing fields ...

  private onPermissionRequest: PermissionRequestCallback | null = null;

  /**
   * Set callback for permission requests.
   * The callback should surface the request to UI and wait for user response.
   * Returns a promise that resolves when user decides.
   */
  setPermissionRequestCallback(callback: PermissionRequestCallback): void {
    this.onPermissionRequest = callback;
  }

  private createClientHandlers(): Client {
    return {
      sessionUpdate: async (params) => {
        this.onSessionUpdate?.(params);
      },

      requestPermission: async (params): Promise<RequestPermissionResponse> => {
        this.log.debug({ params }, "ACP permission request received");

        if (this.onPermissionRequest) {
          // Wait for user to decide - no timeout, waits forever
          return this.onPermissionRequest(params);
        }

        // No handler configured - deny by default
        this.log.warn("No permission handler configured, cancelling");
        return { outcome: { outcome: "cancelled" } };
      },
    };
  }
}
```

### Step 2: Wire Provider to Process Approval Flow

**File**: `packages/server/src/sdk/providers/gemini-acp.ts`

The provider needs to convert ACP permission requests to yepanywhere's `InputRequest` format and wait for responses.

```typescript
private async *runSession(
  client: ACPClient,
  options: StartSessionOptions,
  queue: MessageQueue,
  signal: AbortSignal,
): AsyncIterableIterator<SDKMessage> {

  // Map to track pending permission requests
  const pendingPermissions = new Map<string, {
    resolve: (response: RequestPermissionResponse) => void;
    acpRequest: RequestPermissionRequest;
  }>();

  // Set up permission request handler
  client.setPermissionRequestCallback(async (acpRequest) => {
    const toolCallId = acpRequest.toolCall.toolCallId;

    // Create promise that will be resolved when user responds
    return new Promise<RequestPermissionResponse>((resolve) => {
      pendingPermissions.set(toolCallId, { resolve, acpRequest });

      // Convert to yepanywhere InputRequest format
      const inputRequest = this.convertToInputRequest(acpRequest, sessionId);

      // Emit as SDKMessage so Process can handle it
      // This is tricky - we need to signal the approval request
      // through the message stream
    });
  });

  // ... rest of session loop ...
}

/**
 * Convert ACP permission request to yepanywhere InputRequest.
 */
private convertToInputRequest(
  acpRequest: RequestPermissionRequest,
  sessionId: string,
): InputRequest {
  const toolCall = acpRequest.toolCall;

  // Determine tool name from ACP toolCall.kind
  let toolName: string;
  let toolInput: unknown;

  if (toolCall.kind === "edit") {
    // File edit operation
    toolName = "Write";  // or "Edit" - matches Claude's tool names
    toolInput = {
      path: toolCall.locations?.[0]?.path,
      content: toolCall.content,
    };
  } else if (toolCall.kind === "command") {
    toolName = "Bash";
    toolInput = {
      command: toolCall.title,  // May need to extract actual command
    };
  } else {
    toolName = toolCall.title ?? "Unknown";
    toolInput = toolCall.content;
  }

  return {
    id: toolCall.toolCallId,
    sessionId,
    type: "tool-approval",
    prompt: toolCall.title ?? `${toolName} operation`,
    toolName,
    toolInput,
    timestamp: new Date().toISOString(),
  };
}
```

### Step 3: Handle User Response

When user clicks approve/deny in the UI, we need to resolve the pending promise:

```typescript
/**
 * Called when user responds to a permission request.
 */
respondToPermission(
  toolCallId: string,
  approved: boolean,
  optionId?: string,  // e.g., "proceed_always" for allow all
): void {
  const pending = this.pendingPermissions.get(toolCallId);
  if (!pending) {
    this.log.warn({ toolCallId }, "No pending permission for toolCallId");
    return;
  }

  const { resolve, acpRequest } = pending;

  if (approved) {
    // Find the matching option ID
    const selectedOptionId = optionId ??
      acpRequest.options.find(o => o.kind === "allow_once")?.optionId ??
      "proceed_once";

    resolve({
      outcome: {
        outcome: "proceeded",
        optionId: selectedOptionId,
      }
    });
  } else {
    resolve({
      outcome: { outcome: "cancelled" }
    });
  }

  this.pendingPermissions.delete(toolCallId);
}
```

### Step 4: Permission Mode Support

Map yepanywhere's permission modes to auto-approve behavior:

```typescript
private shouldAutoApprove(
  acpRequest: RequestPermissionRequest,
  permissionMode: PermissionMode,
): boolean {
  const kind = acpRequest.toolCall.kind;

  switch (permissionMode) {
    case "bypassPermissions":  // yolo mode
      return true;

    case "acceptEdits":  // auto-edit mode
      return kind === "edit";

    case "plan":
      // Only auto-approve reads, but Gemini doesn't ask for read permission
      return false;

    case "default":
    default:
      return false;
  }
}
```

## Mapping ACP to Existing UI

### Tool Approval Dialog

Current yepanywhere shows:
- Tool name (e.g., "Write", "Bash")
- Tool input details
- Approve / Deny buttons

ACP provides:
- `toolCall.title` - Human-readable description ("Writing to test.txt")
- `toolCall.kind` - Operation type ("edit", "command")
- `toolCall.content` - Rich details (diffs, command text)
- `toolCall.locations` - Affected file paths
- `options` - Available choices including "Allow All"

### Enhanced UI Opportunity

ACP's diff format is richer than what we show for Claude:

```typescript
{
  type: "diff",
  path: "test.txt",
  oldText: "original content",
  newText: "updated content"
}
```

Could render this as a proper diff view in the approval dialog.

## Architecture Integration

```
┌─────────────────────────────────────────────────────────────────┐
│                        Yepanywhere                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Process    │    │ GeminiACP    │    │  ACPClient   │      │
│  │              │◄───│  Provider    │◄───│              │      │
│  │ handleTool-  │    │              │    │ requestPerm- │      │
│  │ Approval()   │    │ convertTo-   │    │ ission()     │      │
│  │              │    │ InputRequest │    │              │      │
│  └──────┬───────┘    └──────────────┘    └──────┬───────┘      │
│         │                                        │              │
│         │ InputRequest                           │ JSON-RPC     │
│         ▼                                        ▼              │
│  ┌──────────────┐                         ┌──────────────┐      │
│  │   UI/SSE     │                         │    stdio     │      │
│  │  (client)    │                         │              │      │
│  └──────┬───────┘                         └──────┬───────┘      │
└─────────┼────────────────────────────────────────┼──────────────┘
          │                                        │
          │ User clicks                            │
          │ Approve/Deny                           │
          ▼                                        ▼
    ┌──────────────┐                    ┌──────────────────────┐
    │   Browser    │                    │  gemini --exp-acp    │
    │              │                    │                      │
    └──────────────┘                    │  write_file()        │
                                        │  run_shell_command() │
                                        └──────────────────────┘
```

## Testing Checklist

### Manual Testing

1. **Write file approval**
   ```
   User: Create a file called test.txt with "hello world"
   Expected: Approval dialog appears with file path and content diff
   Action: Click Approve
   Expected: File is created, Gemini confirms success
   ```

2. **Write file denial**
   ```
   User: Create a file called secret.txt with password
   Expected: Approval dialog appears
   Action: Click Deny
   Expected: Gemini reports operation was cancelled
   ```

3. **Shell command approval**
   ```
   User: Run "ls -la" in the current directory
   Expected: Approval dialog with command
   Action: Click Approve
   Expected: Command output shown
   ```

4. **Allow All behavior**
   ```
   User: Create three files: a.txt, b.txt, c.txt
   Action: Click "Allow All Edits" on first approval
   Expected: Remaining file writes auto-approve
   ```

5. **Permission mode: bypassPermissions**
   ```
   Set session to yolo mode
   User: Create and run a script
   Expected: All operations auto-approve
   ```

6. **Permission mode: acceptEdits**
   ```
   Set session to auto-edit mode
   User: Write a file and run a command
   Expected: Write auto-approves, command prompts
   ```

### Edge Cases

- [ ] Session terminated while permission pending
- [ ] User disconnects/reconnects during pending approval
- [ ] Multiple concurrent permission requests (queue them)
- [ ] Very large file diffs (truncation?)
- [ ] Binary file writes

## Open Questions

1. **toolCall.kind values**: We've seen `"edit"`. What about shell commands? Is it `"command"` or something else?

2. **Allow All scope**: When user clicks "Allow All Edits", does it persist for:
   - Just this turn?
   - The entire session?
   - Need to track in Process state?

3. **Diff rendering**: Should we parse and render the diff nicely, or just show JSON?

4. **Error feedback**: If Gemini's internal write fails after we approve, do we see that error?

## Files to Modify

| File | Changes |
|------|---------|
| `acp/client.ts` | Add `setPermissionRequestCallback`, update `requestPermission` handler |
| `gemini-acp.ts` | Wire permission callback, convert to InputRequest, handle responses |
| `Process.ts` | May need to accept permission requests from provider (currently only from Claude SDK) |

## Success Criteria

- [ ] File writes work with approval
- [ ] Shell commands work with approval
- [ ] Deny cancels the operation (Gemini sees it was rejected)
- [ ] Permission modes (yolo, auto-edit) auto-approve appropriately
- [ ] "Allow All" works for the session/turn
- [ ] Multiple pending approvals queue correctly
- [ ] Session termination cleans up pending approvals

## Next Steps

1. Implement Step 1 (callback in ACPClient)
2. Test with simple write - verify we receive the request
3. Implement Step 2 (wire to InputRequest)
4. Test end-to-end with UI
5. Add permission mode support
6. Document any new toolCall.kind values discovered
