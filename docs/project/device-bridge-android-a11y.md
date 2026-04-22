# Android Agent Control: Accessibility Tree + CLI Skill

## Goal

Add structured UI understanding to Android devices so AI agents can efficiently interact with them — without screenshots, without MCP, without vision models. Modeled after the [chromeos-testbed](~/code/chromeos-testbed) pattern: a CLI that agents invoke directly, backed by an on-device daemon.

The streaming infrastructure (device-bridge, WebRTC, H.264) handles **human** remote viewing. This layer handles **agent** control: fast accessibility tree snapshots, element-by-reference actions, text search, all over the existing APK's TCP connection.

## Prior Art / References

- **[iPhone-MCP](https://github.com/blitzdotdev/iPhone-mcp)** (cloned to `~/code/references/iPhone-mcp`) — iOS agent control via WebDriverAgent (physical) and custom `ax-scan` Objective-C daemon (simulator). Grid-based accessibility probing, ~250ms quarter-screen. Good architecture reference, but MCP-based.
- **[mobile-mcp](https://github.com/mobile-next/mobile-mcp)** — Cross-platform (iOS+Android), accessibility snapshots for LLMs. Most polished of the MCP projects.
- **[Android-MCP (CursorTouch)](https://github.com/CursorTouch/Android-MCP)** — Lightweight, uses ADB + Android Accessibility API.
- **[Android-Mobile-MCP](https://github.com/erichung9060/Android-Mobile-MCP)** — Another MCP server bridging AI agents to Android.
- **[mcp-android-server-python](https://github.com/nim444/mcp-android-server-python)** — Python MCP server using uiautomator2.
- **[chromeos-testbed](~/code/chromeos-testbed)** — Our own ChromeOS agent control. Uses CDP + `chrome.automation` for the desktop accessibility tree. Bash CLI + on-device Python handler. **The direct model for this work.**

All the above Android projects shell out to `adb` per command (slow). Our APK already has a persistent TCP connection — we can do much better.

## Android Accessibility APIs

| Method | Latency | Root Required | Limitations |
|--------|---------|---------------|-------------|
| `adb shell uiautomator dump` | ~1-3s | No | Slow (spawns process), fails on animated UIs, XML output |
| **UiAutomation** (in-process, via app_process) | ~50-100ms | No | Needs reflection to obtain instance from shell user context |
| **AccessibilityService** (installed APK) | ~50-100ms | No | Requires user to manually enable in Settings |
| `adb shell dumpsys activity top` | ~200ms | No | Very limited — view hierarchy only, no accessibility labels |

We use **UiAutomation** because `DeviceServer.java` already runs as shell user via `app_process` and already uses reflection for `SurfaceControl` and `InputManager`. This is the same approach uiautomator2 and scrcpy use.

## What Changes

### 1. Extend DeviceServer.java

Add `UiAutomation` access via reflection. The shell user (`app_process`) can create a `UiAutomation` instance by connecting to the accessibility manager service directly — no Instrumentation needed.

New control commands:

```json
{"cmd": "snapshot", "maxDepth": 10}
{"cmd": "find", "text": "Sign In", "role": "button"}
{"cmd": "action", "ref": 5, "action": "click"}
{"cmd": "action", "ref": 3, "action": "setText", "text": "user@example.com"}
{"cmd": "info"}
{"cmd": "apps"}
{"cmd": "launch", "package": "com.example.app"}
```

Key Java APIs (all available to shell user):

```java
// Obtain UiAutomation via reflection (same technique as uiautomator2-server)
UiAutomation uiAutomation = /* reflection on UiAutomationConnection */;
AccessibilityNodeInfo root = uiAutomation.getRootInActiveWindow();

// Walk tree
node.getClassName()           // "android.widget.Button"
node.getText()                // "Sign In"
node.getContentDescription()  // accessibility label
node.getBoundsInScreen(rect)  // screen coordinates
node.isClickable()
node.isEditable()
node.isScrollable()
node.getChildCount()

// Perform actions by node reference
node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,
    Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "hello") });
node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
```

### 2. Protocol Extension: Query Responses

Currently 0x03 control messages are fire-and-forget. Queries need responses. Two options:

**Option A (simple):** Reuse 0x03 for both. Commands that are queries (`snapshot`, `find`, `info`, `apps`) send a 0x03 response back. The Go/CLI side knows which commands expect responses based on the command name.

**Option B (explicit):** Add 0x04 as a query/response type:

```
Query (sidecar → device):   [0x04][len u32 LE][JSON]
Response (device → sidecar): [0x04][len u32 LE][JSON]
```

Option A is simpler and doesn't break the existing protocol — the sidecar just starts reading a response after sending certain commands. Go with Option A.

### 3. CLI: `bin/android-agent`

A standalone CLI (bash wrapper + TypeScript/Go core) that manages its own ADB forward and speaks the binary framing protocol directly to the device APK. **Independent of the bridge sidecar** — an agent can use this without any streaming session active.

```
CLI (on Mac) → adb forward tcp:27183 tcp:27183 → DeviceServer APK (on device)
```

#### Commands

```bash
# Accessibility tree
android-agent snapshot                        # Full UI tree (compact format)
android-agent snapshot --depth 3              # Limited depth
android-agent find "Sign In" --role button    # Find elements by text/role
android-agent find "Settings" --nth 2         # Select Nth match

# Actions by reference (from snapshot output)
android-agent tap 5                           # Tap element ref #5
android-agent tap "Sign In"                   # Tap by text match (auto-find + tap)
android-agent type 3 "user@example.com"       # Type into ref #3
android-agent swipe 5 down                    # Swipe element down
android-agent action 5 longClick              # Long click ref #5
android-agent scroll 4 down                   # Scroll container

# Actions by coordinates (fallback)
android-agent tap-xy 540 960                  # Raw coordinate tap

# Text input
android-agent key back                        # Hardware key
android-agent key enter
android-agent text "hello world"              # Type text (no target element)

# Screen
android-agent screenshot                      # Returns file path
android-agent screenshot --scale 0.5          # Downscaled

# App management
android-agent launch com.example.app          # Launch by package
android-agent apps                            # List installed apps
android-agent current                         # Current foreground app

# Device info
android-agent devices                         # List connected devices
android-agent info                            # Screen size, API level, etc.
```

#### Output Format (LLM-Friendly)

Compact indented tree with refs, like chromeos-testbed's `desktop-tree`:

```
[0] FrameLayout {0,0 1080x2400}
  [1] LinearLayout {0,100 1080x200}
    [2] Button "Sign In" {400,120 280x60} clickable focused
    [3] EditText "Email" {100,120 280x60} editable text=""
  [4] RecyclerView {0,200 1080x2200} scrollable
    [5] TextView "Item 1" {0,200 1080x100}
    [6] TextView "Item 2" {0,300 1080x100}
```

Elements get stable refs per snapshot. Agent says `android-agent tap 2` to tap "Sign In".

JSON output available with `--json` flag for programmatic use.

### 4. Skill Definition

A markdown skill file that agents reference from their CLAUDE.md:

```markdown
# Android Agent Skill

Control Android devices (emulators and physical) for testing and automation.

## Quick Start
1. `android-agent snapshot` — see what's on screen
2. Find element by ref number or text
3. `android-agent tap <ref>` or `android-agent tap "Button Text"`
4. `android-agent snapshot` — verify result

## Workflow: snapshot → act → snapshot
```

### 5. Diff Snapshots (Future Enhancement)

After an action, return what changed rather than the full tree. Dramatically reduces tokens for the LLM:

```bash
android-agent tap 2
# output: action applied, 3 nodes changed:
#   [2] Button "Sign In" → removed
#   [7] ProgressBar "Loading..." {400,120 280x60} (new)
#   [1] LinearLayout → children changed
```

## Performance Comparison

| | Existing projects (Android-MCP etc.) | Our approach |
|---|---|---|
| **Transport** | Shell out to `adb` per command (~200ms spawn overhead) | Persistent TCP connection via APK (~10ms per query) |
| **Snapshot speed** | `adb shell uiautomator dump` (~1-3s, fails on animations) | `UiAutomation.getRootInActiveWindow()` in-process (~50-100ms) |
| **Input** | `adb shell input tap` (spawns process) | `InputManager.injectInputEvent()` via reflection (<10ms, already working) |
| **Protocol** | MCP (JSON-RPC over stdio, requires MCP client setup) | Plain CLI (any agent, any shell) |
| **Integration** | Requires MCP config per agent | Drop a skill file, reference from CLAUDE.md |

## Implementation Phases

### Phase 1 — UiAutomation in DeviceServer.java

1. Add `UiAutomation` access via reflection (mirror uiautomator2-server's approach)
2. Implement `snapshot` command: walk `AccessibilityNodeInfo` tree → compact JSON
3. Implement `find` command: text/role matching with regex support
4. Implement `action` command: click, setText, scroll, longClick by node reference
5. Add query response support to the protocol (0x03 with response)

Test: `adb forward` + manual TCP client to verify responses.

### Phase 2 — CLI (`bin/android-agent`)

1. Build CLI that manages ADB forward and speaks binary protocol
2. Implement all commands: snapshot, find, tap, type, key, screenshot, launch, etc.
3. Compact tree output format (indented, with refs)
4. `--json` flag for programmatic output
5. `--device` flag for multi-device support (defaults to first connected)

Test: Run against emulator, verify snapshot output, tap-by-ref workflow.

### Phase 3 — Skill + Agent Integration

1. Write skill definition markdown
2. Add reference from project CLAUDE.md
3. Test with Claude Code: can it navigate an app using only the CLI?
4. Iterate on output format based on what the agent struggles with

### Phase 4 — Enhancements

- Diff snapshots (return changes after actions)
- Targeted queries (find without full tree walk)
- Element watching (notify when element appears/disappears)
- `android-agent wait "Loading"` — block until element appears
- Batch commands (`android-agent do tap 2, wait "Welcome", screenshot`)

## File Locations

| Component | Path |
|-----------|------|
| APK source | `packages/android-device-server/app/src/main/java/com/yepanywhere/DeviceServer.java` |
| Binary framing | `packages/device-bridge/internal/conn/framing.go` |
| CLI | `bin/android-agent` (new) |
| Skill definition | `skills/android-agent.md` (new) |
| This doc | `docs/project/device-bridge-android-a11y.md` |
