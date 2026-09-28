import { DatabaseSync } from "node:sqlite";

// Execute production SQL rather than guessing query results in a permissive mock.
export class SQLiteD1 {
  constructor() { this.sqlite = new DatabaseSync(":memory:"); }
  prepare(sql) {
    const make = (values = []) => ({
      bind: (...next) => make(next),
      run: async () => ({ meta: { changes: this.sqlite.prepare(sql).run(...values).changes } }),
      first: async () => this.sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: this.sqlite.prepare(sql).all(...values) }),
    });
    return make();
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.sqlite.close(); }
}
