export type AuthorDisplayMappings = Record<string, string>;

function normalizeSource(value: unknown): string {
  if (typeof value !== "string") throw new Error("Git 作者原始名称必须是文本");
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) throw new Error("Git 作者原始名称无效");
  return normalized;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new Error("作者显示名称必须是文本");
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) throw new Error("作者显示名称无效");
  return normalized;
}

export function normalizeAuthorDisplayMappings(value: unknown): AuthorDisplayMappings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const mappings: AuthorDisplayMappings = {};
  for (const [source, display] of Object.entries(value as Record<string, unknown>)) {
    const original = normalizeSource(source);
    const key = original.toLocaleLowerCase();
    if (mappings[key] !== undefined) throw new Error(`Git 作者原始名称重复：${original}`);
    mappings[key] = normalizeDisplayName(display);
  }
  return Object.fromEntries(Object.entries(mappings).sort(([left], [right]) => left.localeCompare(right)));
}

export function parseAuthorDisplayMappings(text: string): AuthorDisplayMappings {
  const mappings: Record<string, string> = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1 || separator === trimmed.length - 1) throw new Error(`第 ${index + 1} 行应使用“原始名称 = 显示名称”格式`);
    const source = trimmed.slice(0, separator).trim();
    const display = trimmed.slice(separator + 1).trim();
    const key = normalizeSource(source).toLocaleLowerCase();
    if (mappings[key] !== undefined) throw new Error(`第 ${index + 1} 行的 Git 作者原始名称重复`);
    mappings[key] = normalizeDisplayName(display);
  }
  return normalizeAuthorDisplayMappings(mappings);
}

export function serializeAuthorDisplayMappings(value: unknown): string {
  return Object.entries(normalizeAuthorDisplayMappings(value))
    .map(([source, display]) => `${source} = ${display}`)
    .join("\n");
}

export class AuthorDisplayService {
  private readonly mappings: AuthorDisplayMappings;

  constructor(mappings: unknown) {
    this.mappings = normalizeAuthorDisplayMappings(mappings);
  }

  display(author: string): string {
    const original = author.trim();
    return this.mappings[original.toLocaleLowerCase()] ?? original;
  }

  displayMany(authors: readonly string[]): string[] {
    return [...new Set(authors.map((author) => this.display(author)).filter(Boolean))];
  }
}
