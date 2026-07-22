import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Colors ──────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  dim: "\x1b[2m",
};

function colorLevel(level: string): string {
  switch (level) {
    case "error":
      return `${C.red}${level}${C.reset}`;
    case "warn":
      return `${C.yellow}${level}${C.reset}`;
    default:
      return level;
  }
}

// ── Args ────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  return {
    tail: args.includes("--tail") || args.includes("-f"),
    all: args.includes("--all") || args.includes("-a"),
    device: getArgValue(args, ["--device", "-d"]),
    level: getArgValue(args, ["--level", "-l"]),
    prefix: getArgValue(args, ["--prefix", "-p"]),
    help: args.includes("--help") || args.includes("-h"),
  };
}

function getArgValue(args: string[], flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]) && args[i + 1]) {
      return args[i + 1];
    }
  }
  return undefined;
}

// ── Data dir resolution ─────────────────────────────────────────────
function getDataDir(): string {
  if (process.env.YEP_ANYWHERE_DATA_DIR) {
    return process.env.YEP_ANYWHERE_DATA_DIR;
  }
  return join(homedir(), ".yep-anywhere");
}

function getLogsDir(): string {
  return join(getDataDir(), "logs", "client-logs");
}

// ── Log entry type ──────────────────────────────────────────────────
interface LogEntry {
  timestamp: number;
  level: string;
  prefix: string;
  message: string;
  _receivedAt?: number;
}

// ── Parse a JSONL file ──────────────────────────────────────────────
function parseJsonl(filePath: string): LogEntry[] {
  const content = readFileSync(filePath, "utf-8");
  const entries: LogEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as LogEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// ── Format a single log entry ───────────────────────────────────────
function formatEntry(entry: LogEntry): string {
  const date = new Date(entry.timestamp);
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const level = colorLevel(entry.level);
  const prefix = entry.prefix ? `${C.gray}${entry.prefix}${C.reset}` : "";
  return `[${time}] [${level}] ${prefix} ${entry.message}`;
}

// ── List log files ──────────────────────────────────────────────────
function listLogFiles(): {
  filename: string;
  path: string;
  deviceId: string;
}[] {
  const dir = getLogsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const match = f.match(/^client-\d{4}-\d{2}-\d{2}-(.+)\.jsonl$/);
      return {
        filename: f,
        path: join(dir, f),
        deviceId: match ? match[1] : "unknown",
      };
    });
  return files;
}

// ── Filter entries ──────────────────────────────────────────────────
function filterEntries(
  entries: LogEntry[],
  level?: string,
  prefix?: string,
): LogEntry[] {
  return entries.filter((e) => {
    if (level && e.level !== level) return false;
    if (prefix && !e.prefix.includes(prefix)) return false;
    return true;
  });
}

// ── Print usage ─────────────────────────────────────────────────────
function printUsage() {
  console.log(`
用法: bun run scripts/view-client-logs.ts [选项]

选项:
  --tail, -f          实时监控新日志（类似 tail -f）
  --device, -d <id>   查看指定设备的日志
  --all, -a           查看所有设备的完整日志
  --level, -l <lvl>   按级别过滤: log, warn, error
  --prefix, -p <str>  按前缀过滤, 如 "[SecureConnection]"
  --help, -h          显示帮助

示例:
  bun run scripts/view-client-logs.ts              # 列出今日所有设备摘要
  bun run scripts/view-client-logs.ts --tail       # 实时监控
  bun run scripts/view-client-logs.ts --device abc # 查看指定设备
  bun run scripts/view-client-logs.ts --level error --tail  # 只看错误
`);
}

// ── List mode (default) ─────────────────────────────────────────────
function runList() {
  const files = listLogFiles();
  if (files.length === 0) {
    console.log("${C.yellow}还没有收到客户端日志。${C.reset}");
    console.log();
    console.log("请按以下步骤开启日志收集：");
    console.log("  1. 打开手机 App");
    console.log("  2. 进入 设置 → About");
    console.log('  3. 开启 "Connection Diagnostics"（远程日志收集）');
    console.log("  4. 确保手机已连接到服务器");
    console.log();
    console.log(`日志将保存到: ${C.cyan}${getLogsDir()}${C.reset}`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`${C.cyan}客户端日志 (${today})${C.reset}`);
  console.log(`${C.gray}数据目录: ${getDataDir()}${C.reset}`);
  console.log();

  for (const file of files) {
    const entries = parseJsonl(file.path);
    const last = entries[entries.length - 1];
    console.log(
      `${C.green}${file.deviceId}${C.reset}  (${C.gray}${file.filename}${C.reset})  ${entries.length} 条日志`,
    );
    if (last) {
      console.log(`  ${formatEntry(last)}`);
    }
    console.log();
  }

  console.log(`${C.gray}提示: 加 --tail 可实时监控新日志${C.reset}`);
}

// ── View mode ───────────────────────────────────────────────────────
function runView(deviceId?: string, level?: string, prefix?: string) {
  const files = listLogFiles();
  let targets = files;

  if (deviceId) {
    targets = files.filter((f) => f.deviceId === deviceId);
    if (targets.length === 0) {
      console.log(`${C.red}未找到设备: ${deviceId}${C.reset}`);
      console.log("可用设备:");
      for (const f of files) {
        console.log(`  ${f.deviceId}`);
      }
      return;
    }
  }

  for (const file of targets) {
    if (targets.length > 1) {
      console.log(`${C.cyan}─── ${file.deviceId} ───${C.reset}`);
    }
    const entries = filterEntries(parseJsonl(file.path), level, prefix);
    for (const entry of entries) {
      console.log(formatEntry(entry));
    }
  }
}

// ── Tail mode ───────────────────────────────────────────────────────
function runTail(deviceId?: string, level?: string, prefix?: string) {
  const files = listLogFiles();
  let targets = files;

  if (deviceId) {
    targets = files.filter((f) => f.deviceId === deviceId);
    if (targets.length === 0) {
      console.log(`${C.red}未找到设备: ${deviceId}${C.reset}`);
      return;
    }
  }

  // Track file sizes to detect new content
  const fileStates = new Map<string, { size: number; entriesCount: number }>();
  for (const file of targets) {
    const stat = statSync(file.path);
    const entries = parseJsonl(file.path);
    fileStates.set(file.path, {
      size: stat.size,
      entriesCount: entries.length,
    });
  }

  // Print existing entries first
  for (const file of targets) {
    const entries = filterEntries(parseJsonl(file.path), level, prefix);
    for (const entry of entries) {
      console.log(formatEntry(entry));
    }
  }

  if (targets.length === 0) {
    console.log(`${C.yellow}等待客户端日志...${C.reset}`);
    console.log("请确保手机 App 已开启 Diagnostics 并连接到服务器。");
  } else {
    console.log(`${C.gray}--- 实时监控中，按 Ctrl+C 退出 ---${C.reset}`);
  }

  // Poll for changes
  const interval = setInterval(() => {
    for (const file of targets) {
      const stat = statSync(file.path);
      const state = fileStates.get(file.path);
      if (!state) {
        fileStates.set(file.path, { size: stat.size, entriesCount: 0 });
        continue;
      }

      if (stat.size > state.size) {
        const entries = parseJsonl(file.path);
        const newEntries = entries.slice(state.entriesCount);
        const filtered = filterEntries(newEntries, level, prefix);
        for (const entry of filtered) {
          console.log(formatEntry(entry));
        }
        fileStates.set(file.path, {
          size: stat.size,
          entriesCount: entries.length,
        });
      }
    }

    // Check for new files
    const currentFiles = listLogFiles();
    const newFiles = currentFiles.filter(
      (f) => !targets.some((t) => t.path === f.path),
    );
    for (const file of newFiles) {
      if (deviceId && file.deviceId !== deviceId) continue;
      targets.push(file);
      const entries = filterEntries(parseJsonl(file.path), level, prefix);
      if (entries.length > 0) {
        console.log(`${C.green}─── 新设备 ${file.deviceId} ───${C.reset}`);
        for (const entry of entries) {
          console.log(formatEntry(entry));
        }
      }
      fileStates.set(file.path, {
        size: statSync(file.path).size,
        entriesCount: entries.length,
      });
    }
  }, 500);

  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("\n已退出。");
    process.exit(0);
  });
}

// ── Main ────────────────────────────────────────────────────────────
const args = parseArgs();

if (args.help) {
  printUsage();
  process.exit(0);
}

if (args.tail) {
  runTail(args.device, args.level, args.prefix);
} else if (args.all || args.device || args.level || args.prefix) {
  runView(args.all ? undefined : args.device, args.level, args.prefix);
} else {
  runList();
}
