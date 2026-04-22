# Claude Message Schema Analysis

## Summary

- Files scanned: 806
- Total messages: 16878
- Unique tools: 15

## Message Types

| Type | Count |
|------|-------|
| assistant | 10485 |
| user | 5441 |
| file-history-snapshot | 497 |
| queue-operation | 449 |
| system | 6 |

## Content Block Types

| Type | Count |
|------|-------|
| tool_use | 4689 |
| tool_result | 4683 |
| text | 3168 |
| thinking | 3106 |

## Tools

### Read (1392 uses)

**Input fields:**

- `file_path`: string (e.g., "/home/kgraehl/code/assetos-takehome/20251119-tech-challenge-assetos.md")
- `offset`: number | string (e.g., "[200, 220]")
- `limit`: number

### Bash (1300 uses)

**Input fields:**

- `command`: string (e.g., "ls -la /home/kgraehl/code/assetos-takehome/data/ 2>/dev/null || echo "No data directory"")
- `description`: string (e.g., "List project structure")
- `run_in_background`: boolean
- `timeout`: number

### Edit (735 uses)

**Input fields:**

- `file_path`: string (e.g., "/home/kgraehl/.claude/plans/foamy-conjuring-crane.md")
- `old_string`: string (e.g., "## Implementation Steps

### 1. Root Setup")
- `new_string`: string (e.g., "# Vite
*.local
*.timestamp-*")
- `replace_all`: boolean

### TodoWrite (343 uses)

**Input fields:**

- `todos`: array

### Grep (249 uses)

**Input fields:**

- `pattern`: string (e.g., "base64|encodeURIComponent|projectId")
- `path`: string (e.g., "/home/kgraehl/code/claude-anywhere/packages/server/src")
- `glob`: string (e.g., "*.ts")
- `output_mode`: string (e.g., "content")
- `-C`: number
- `-i`: boolean
- `head_limit`: number
- `type`: string (e.g., "ts")
- `context`: string (e.g., "-B 3 -A 3")
- `-n`: boolean
- `-A`: number
- `-B`: number

### Write (246 uses)

**Input fields:**

- `file_path`: string (e.g., "/home/kgraehl/.claude/plans/foamy-conjuring-crane.md")
- `content`: string (e.g., "packages:
  - "packages/*"
")

### Glob (231 uses)

**Input fields:**

- `pattern`: string (e.g., "**/*")
- `path`: string (e.g., "/home/kgraehl/code/assetos-takehome")

### Task (60 uses)

**Input fields:**

- `description`: string (e.g., "Explore codebase structure")
- `prompt`: string
- `subagent_type`: string (e.g., "Explore")
- `model`: string (e.g., "opus")

### ExitPlanMode (57 uses)

**Input fields:**

- `plan`: string

### AskUserQuestion (23 uses)

**Input fields:**

- `questions`: array

### WebSearch (16 uses)

**Input fields:**

- `query`: string (e.g., "Claude Code VSCode extension open source github anthropic 2025")

### WebFetch (16 uses)

**Input fields:**

- `url`: string (e.g., "https://github.com/anthropics/claude-code")
- `prompt`: string (e.g., "What does this PR propose? What's the implementation approach? Was it merged or rejected?")

### BashOutput (10 uses)

**Input fields:**

- `bash_id`: string (e.g., "b02d1e")
- `block`: boolean
- `wait_up_to`: number

### TaskOutput (6 uses)

**Input fields:**

- `task_id`: string (e.g., "b4e6bf5")
- `block`: boolean
- `timeout`: number

### KillShell (5 uses)

**Input fields:**

- `shell_id`: string (e.g., "0ea215")
