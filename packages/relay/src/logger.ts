import * as fs from "node:fs";
import * as path from "node:path";
import pino from "pino";

/**
 * Valid log levels.
 */
export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogConfig {
  /** Directory for log files */
  logDir: string;
  /** Log filename. Default: relay.log */
  logFile: string;
  /** Minimum log level for console. Default: info */
  consoleLevel: LogLevel;
  /** Minimum log level for file. Default: info */
  fileLevel: LogLevel;
  /** Also log to console. Default: true */
  logToConsole: boolean;
  /** Log to file. Default: true */
  logToFile: boolean;
  /** Use pretty printing for console. Default: true in dev */
  prettyPrint: boolean;
}

/**
 * Get the minimum (most verbose) of two log levels.
 */
function getMinLevel(a: LogLevel, b: LogLevel): LogLevel {
  const order: Record<LogLevel, number> = {
    trace: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
    fatal: 5,
    silent: 6,
  };
  return order[a] <= order[b] ? a : b;
}

/**
 * Create a logger with the given configuration.
 */
export function createLogger(config: LogConfig): pino.Logger {
  // Ensure log directory exists
  if (config.logToFile) {
    fs.mkdirSync(config.logDir, { recursive: true });
  }

  const streams: pino.StreamEntry[] = [];

  // Console stream
  if (config.logToConsole) {
    if (config.prettyPrint) {
      // Use pino-pretty for development
      const pretty = pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      });
      streams.push({
        stream: pretty,
        level: config.consoleLevel as pino.Level,
      });
    } else {
      streams.push({
        stream: process.stdout,
        level: config.consoleLevel as pino.Level,
      });
    }
  }

  // File stream
  if (config.logToFile) {
    const logPath = path.join(config.logDir, config.logFile);
    const fileStream = fs.createWriteStream(logPath, { flags: "a" });
    streams.push({
      stream: fileStream,
      level: config.fileLevel as pino.Level,
    });
  }

  // Determine minimum level across all streams (pino needs base level <= stream levels)
  const minLevel = getMinLevel(config.consoleLevel, config.fileLevel);

  if (streams.length === 0) {
    // No streams configured, use a silent logger
    return pino({ level: "silent" });
  }

  if (streams.length === 1 && streams[0]) {
    return pino({ level: streams[0].level }, streams[0].stream);
  }

  const multistream = pino.multistream(streams);
  return pino({ level: minLevel }, multistream);
}
