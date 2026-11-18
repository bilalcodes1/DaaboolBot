/** Best-effort bounded deduplication within one Worker isolate; no persistent data. */
export class UpdateDeduplicator {
  private readonly entries = new Map<number, { expires: number; task: Promise<void>; pending: boolean }>();

  constructor(private readonly capacity = 2000, private readonly ttl = 24 * 60 * 60_000) {}

  async run(id: number, work: () => Promise<void>): Promise<void> {
    const now = Date.now();
    for (const [key, value] of this.entries) {
      if (!value.pending && value.expires <= now) this.entries.delete(key);
    }
    const existing = this.entries.get(id);
    if (existing) return existing.task;
    if (this.entries.size >= this.capacity) {
      for (const [key, value] of this.entries) {
        if (!value.pending) { this.entries.delete(key); break; }
      }
      // Backpressure instead of evicting an in-flight update and sending it twice.
      if (this.entries.size >= this.capacity) throw new Error('Update capacity reached');
    }
    const entry = { expires: now + this.ttl, task: Promise.resolve(), pending: true };
    // Queue work so the entry exists before a second simultaneous invocation.
    entry.task = Promise.resolve().then(work).then(() => {
      entry.pending = false;
      entry.expires = Date.now() + this.ttl;
    }).catch(error => {
      this.entries.delete(id);
      throw error;
    });
    this.entries.set(id, entry);
    return entry.task;
  }
}
