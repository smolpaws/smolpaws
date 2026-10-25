import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Execute the production migration and SQL against SQLite, including atomic batches.
export function testDatabase(): { db: D1Database; close(): void } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../../migrations/0001_managed_agents.sql', import.meta.url), 'utf8'));
  class Statement {
    private args: SQLInputValue[] = [];
    constructor(private sql: string) {}
    bind(...args: SQLInputValue[]): this { this.args = args; return this; }
    async first(column?: string): Promise<unknown> {
      const row = sqlite.prepare(this.sql).get(...this.args);
      return row ? column ? row[column] : row : null;
    }
    async all(): Promise<unknown> {
      return { success: true, results: sqlite.prepare(this.sql).all(...this.args), meta: {} };
    }
    async run(): Promise<unknown> {
      const result = sqlite.prepare(this.sql).run(...this.args);
      return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
  }
  let batches: Promise<unknown> = Promise.resolve();
  const db = {
    prepare(sql: string) { return new Statement(sql); },
    batch(statements: Statement[]) {
      const result = batches.then(async () => {
        sqlite.exec('BEGIN');
        try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      batches = result.catch(() => {});
      return result;
    },
  } as unknown as D1Database;
  return { db, close: () => sqlite.close() };
}
