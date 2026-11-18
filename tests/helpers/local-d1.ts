import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Real SQLite, atomic D1-style batches, no sockets/providers/production bindings. */
export function localD1(migrate = true) {
  const sqlite = new DatabaseSync(':memory:');
  let queries = 0;
  class Statement {
    constructor(readonly sql: string, readonly values: unknown[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.sql, values); }
    execute() {
      queries++;
      const statement = sqlite.prepare(this.sql);
      const args = this.values as (string | number | null | Uint8Array)[];
      const rows = statement.all(...args).map(row => ({ ...row }));
      const meta = sqlite.prepare('SELECT changes() AS changes,last_insert_rowid() AS last_row_id').get()!;
      return { success: true, results: rows, meta: { changes: Number(meta.changes), last_row_id: Number(meta.last_row_id), duration: 0, rows_read: rows.length, rows_written: Number(meta.changes) } };
    }
    async all<T>() { return this.execute() as unknown as D1Result<T>; }
    async run<T>() { return this.execute() as unknown as D1Result<T>; }
    async first<T>(column?: string): Promise<T | null> {
      const row = this.execute().results[0]; return (row ? column ? row[column] : row : null) as T | null;
    }
    async raw<T>(options?: { columnNames?: boolean }): Promise<T[]> {
      const result = this.execute().results; const rows = result.map(row => Object.values(row));
      return (options?.columnNames && result[0] ? [Object.keys(result[0]), ...rows] : rows) as T[];
    }
  }
  const db = {
    prepare(sql: string) { return new Statement(sql); },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    async exec(sql: string) { queries++; sqlite.exec(sql); return { count: 1, duration: 0 }; },
    withSession() { return db; },
  } as unknown as D1Database;
  if (migrate) for (const file of readdirSync(resolve('migrations')).filter(file => /^\d+.*\.sql$/u.test(file)).sort()) sqlite.exec(readFileSync(resolve('migrations', file), 'utf8'));
  return { db, sqlite, close: () => sqlite.close(), queryCount: () => queries, resetQueryCount: () => { queries = 0; } };
}
