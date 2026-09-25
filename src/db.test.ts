import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { telemetryTotals } from "./db";

test("telemetry totals aggregate usage and completed duration", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE sessions (
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        attempts INTEGER NOT NULL,
        tokens_in INTEGER NOT NULL,
        tokens_out INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES (1000, 3500, 2, 120, 40);
      INSERT INTO sessions VALUES (4000, NULL, 1, 20, 10);
    `);

    expect(telemetryTotals(db)).toEqual({
      sessions: 2,
      attempts: 3,
      tokens_in: 140,
      tokens_out: 50,
      duration_ms: 2500,
    });
  } finally {
    db.close();
  }
});
