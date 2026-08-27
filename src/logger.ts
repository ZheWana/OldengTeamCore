import type { Logger } from "./types";

const SECRET_KEYS = /(password|secret|accesskey|authorization|signature|import)/i;

function redact(value: unknown): unknown {
  if (typeof value === "string") return value.length > 3 ? "[redacted]" : "[redacted]";
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? "[redacted]" : redact(item)]));
  }
  return value;
}

export class PluginLogger implements Logger {
  constructor(private readonly enabled: () => boolean = () => true) {}

  debug(message: string, details?: unknown): void {
    if (this.enabled()) console.debug(`[Team Core] ${message}`, redact(details));
  }

  warn(message: string, details?: unknown): void {
    console.warn(`[Team Core] ${message}`, redact(details));
  }

  error(message: string, details?: unknown): void {
    console.error(`[Team Core] ${message}`, redact(details));
  }
}
