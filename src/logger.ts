import type { Logger } from "./types";

const SECRET_KEYS = /(password|secret|accesskey|authorization|signature|token|credential)/i;
const MAX_LOG_ENTRIES = 800;
const MAX_STRING_LENGTH = 2_000;
const VERBOSE_TRANSFER_MESSAGES = new Set([
  "Attachment download started",
  "Attachment Vault write started",
  "Attachment Vault write completed",
  "Attachment download completed",
  "S3 response received",
  "S3 download hash verification started",
  "S3 download hash verification completed",
  "S3 download chunk completed",
  "Public attachment WebDAV request"
]);

export type LogLevel = "debug" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  details?: unknown;
}

/**
 * A full remote import can involve thousands of attachment transport events.
 * Keep the bounded diagnostic log useful by evicting those per-object traces
 * before phase summaries, HTTP timings, warnings, and errors.
 */
function isVerboseTransferEntry(entry: LogEntry): boolean {
  if (VERBOSE_TRANSFER_MESSAGES.has(entry.message)) return true;
  if (/^(GET|HEAD|PUT|DELETE) S3 object$/.test(entry.message)) return true;
  if (entry.message !== "Sync progress advanced") return false;
  const phase = entry.details && typeof entry.details === "object" && "phase" in entry.details
    ? (entry.details as { phase?: unknown }).phase
    : undefined;
  return typeof phase === "string" && phase.includes("附件");
}

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEYS.test(key)) return "[redacted]";
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === "string") return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, item]) => [entryKey, redact(item, entryKey)]));
  }
  return value;
}

export function parseLogEntries(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LogEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Partial<LogEntry>;
    if (typeof candidate.timestamp !== "string" || !["debug", "warn", "error"].includes(candidate.level ?? "") || typeof candidate.message !== "string") return [];
    return [{ timestamp: candidate.timestamp, level: candidate.level as LogLevel, message: candidate.message, ...(candidate.details === undefined ? {} : { details: redact(candidate.details) }) }];
  }).slice(-MAX_LOG_ENTRIES);
}

export class PluginLogger implements Logger {
  private readonly records: LogEntry[];
  private persistTimer: number | undefined;

  constructor(
    private readonly enabled: () => boolean = () => true,
    initialEntries: readonly LogEntry[] = [],
    private readonly onPersist?: (entries: readonly LogEntry[]) => void
  ) {
    this.records = parseLogEntries(initialEntries);
  }

  debug(message: string, details?: unknown): void {
    this.record("debug", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.record("warn", message, details);
  }

  error(message: string, details?: unknown): void {
    this.record("error", message, details);
  }

  entries(): readonly LogEntry[] {
    return this.records;
  }

  exportText(context?: unknown): string {
    return JSON.stringify({
      format: 1,
      exportedAt: new Date().toISOString(),
      context: redact(context),
      entries: this.records
    }, null, 2);
  }

  flush(): void {
    if (this.persistTimer !== undefined) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.onPersist?.([...this.records]);
  }

  private record(level: LogLevel, message: string, details?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: message.length > MAX_STRING_LENGTH ? `${message.slice(0, MAX_STRING_LENGTH)}…` : message,
      ...(details === undefined ? {} : { details: redact(details) })
    };
    this.records.push(entry);
    while (this.records.length > MAX_LOG_ENTRIES) {
      const verboseIndex = this.records.findIndex(isVerboseTransferEntry);
      this.records.splice(verboseIndex < 0 ? 0 : verboseIndex, 1);
    }
    const consoleDetails = entry.details;
    if (this.enabled()) {
      if (level === "debug") console.debug(`[Oldeng Team Core] ${entry.message}`, consoleDetails);
      else if (level === "warn") console.warn(`[Oldeng Team Core] ${entry.message}`, consoleDetails);
      else console.error(`[Oldeng Team Core] ${entry.message}`, consoleDetails);
    }
    this.schedulePersist(level !== "debug");
  }

  private schedulePersist(immediate: boolean): void {
    if (!this.onPersist) return;
    if (immediate) {
      this.flush();
      return;
    }
    if (this.persistTimer !== undefined) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = undefined;
      this.onPersist?.([...this.records]);
    }, 400);
  }
}
