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
}
