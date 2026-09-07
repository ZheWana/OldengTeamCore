/** Serializes plugin-data mutations so unrelated writers cannot overwrite each other. */
export class SerializedPluginData {
  private current: Record<string, unknown>;
  private pending: Promise<void> = Promise.resolve();

  constructor(initial: unknown, private readonly save: (data: Record<string, unknown>) => Promise<void>) {
    this.current = initial && typeof initial === "object" && !Array.isArray(initial)
      ? { ...(initial as Record<string, unknown>) }
      : {};
  }

  update(fields: object): Promise<void> {
    const snapshot: Record<string, unknown> = { ...fields };
    const write = this.pending.then(async () => {
      this.current = { ...this.current, ...snapshot };
      await this.save({ ...this.current });
    });
    this.pending = write.catch(() => undefined);
    return write;
  }

  /** Remove retired local-only fields during a schema migration. */
  remove(keys: readonly string[]): Promise<void> {
    const unique = [...new Set(keys)];
    const write = this.pending.then(async () => {
      const next = { ...this.current };
      for (const key of unique) delete next[key];
      this.current = next;
      await this.save({ ...this.current });
    });
    this.pending = write.catch(() => undefined);
    return write;
  }
}
