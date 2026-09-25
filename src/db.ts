import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { Config } from "./config";

export type PollRow = {
  id: number;
  repo: string;
  sha: string | null;
  result: string;
  duration_ms: number;
  at: number;
};

export type SessionRow = {
  id: number;
  repo: string;
  ref: string;
  start_sha: string;
  end_sha: string | null;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  failure_class: string | null;
  reproduced: number | null;
  oracle_json: string | null;
  files_json: string | null;
  attempts: number;
  tokens_in: number;
  tokens_out: number;
  sandbox_s: number;
  error: string | null;
};

export type EventRow = {
  id: number;
  session_id: number;
  at: number;
  event: string;
  payload_json: string;
};

export type LandRow = {
  id: number;
  session_id: number;
  repo: string;
  sha: string;
  at: number;
};

export type TelemetryTotals = {
  sessions: number;
  attempts: number;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
};

export type FinishFields = {
  end_sha?: string | null;
  outcome?: string;
  failure_class?: string | null;
  reproduced?: number | null;
  oracle_json?: string | null;
  files_json?: string | null;
  attempts?: number;
  tokens_in?: number;
  tokens_out?: number;
  sandbox_s?: number;
  error?: string | null;
};

const FINISH_COLS = new Set([
  "end_sha",
  "outcome",
  "failure_class",
  "reproduced",
  "oracle_json",
  "files_json",
  "attempts",
  "tokens_in",
  "tokens_out",
  "sandbox_s",
  "error",
]);

export function openDb(config: Config): Database {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.exec("pragma journal_mode = WAL");
  db.exec(`
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  sha TEXT,
  result TEXT NOT NULL, -- green|red|pending|api_error|no_rollup
  duration_ms INTEGER NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  start_sha TEXT NOT NULL,
  end_sha TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT, -- landed|reverted|gave_up|head_moved|not_reproduced|denied_policy|budget|error
  failure_class TEXT,
  reproduced INTEGER, -- 0|1|null
  oracle_json TEXT,
  files_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  sandbox_s INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS lands (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  at INTEGER NOT NULL
);
`);
  return db;
}

export function insertPoll(
  db: Database,
  row: { repo: string; sha: string | null; result: string; duration_ms: number; at?: number },
): void {
  db.prepare("INSERT INTO polls (repo, sha, result, duration_ms, at) VALUES (?, ?, ?, ?, ?)").run(
    row.repo,
    row.sha,
    row.result,
    row.duration_ms,
    row.at ?? Date.now(),
  );
}

export function beginSession(db: Database, repo: string, ref: string, start_sha: string): number {
  const result = db
    .prepare(
      "INSERT INTO sessions (repo, ref, start_sha, started_at, attempts, tokens_in, tokens_out, sandbox_s) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
    )
    .run(repo, ref, start_sha, Date.now());
  return Number(result.lastInsertRowid);
}

export function finishSession(db: Database, id: number, fields: FinishFields): void {
  const sets = ["ended_at = ?"];
  const vals: unknown[] = [Date.now()];
  for (const [key, value] of Object.entries(fields)) {
    if (!FINISH_COLS.has(key)) continue;
    sets.push(`${key} = ?`);
    vals.push(value);
  }
  vals.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function appendEvent(db: Database, sessionId: number, event: string, payload: unknown): void {
  db.prepare("INSERT INTO events (session_id, at, event, payload_json) VALUES (?, ?, ?, ?)").run(
    sessionId,
    Date.now(),
    event,
    JSON.stringify(payload ?? {}),
  );
}

export function insertLand(
  db: Database,
  row: { session_id: number; repo: string; sha: string; at?: number },
): void {
  db.prepare("INSERT INTO lands (session_id, repo, sha, at) VALUES (?, ?, ?, ?)").run(
    row.session_id,
    row.repo,
    row.sha,
    row.at ?? Date.now(),
  );
}

export function activeSession(db: Database, repo: string): SessionRow | null {
  return (
    (db
      .prepare("SELECT * FROM sessions WHERE repo = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(repo) as SessionRow | undefined) ?? null
  );
}

export function lastSession(db: Database, repo: string): SessionRow | null {
  return (
    (db.prepare("SELECT * FROM sessions WHERE repo = ? ORDER BY id DESC LIMIT 1").get(repo) as
      | SessionRow
      | undefined) ?? null
  );
}

export function lastPoll(db: Database, repo: string): PollRow | null {
  return (
    (db.prepare("SELECT * FROM polls WHERE repo = ? ORDER BY id DESC LIMIT 1").get(repo) as
      | PollRow
      | undefined) ?? null
  );
}

export function anyPolls(db: Database): boolean {
  return db.prepare("SELECT 1 AS n FROM polls LIMIT 1").get() != null;
}

export function landsToday(db: Database, repo: string): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const row = db.prepare("SELECT COUNT(*) AS n FROM lands WHERE repo = ? AND at >= ?").get(repo, midnight) as {
    n: number;
  };
  return row.n;
}

export function staleActiveSessions(db: Database, maxAgeMs: number): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions WHERE ended_at IS NULL AND started_at < ?")
    .all(Date.now() - maxAgeMs) as SessionRow[];
}

export function recentPolls(db: Database, limit = 15): PollRow[] {
  return db.prepare("SELECT * FROM polls ORDER BY id DESC LIMIT ?").all(limit) as PollRow[];
}

export function recentSessions(db: Database, limit = 10, beforeId?: number): SessionRow[] {
  if (beforeId != null) {
    return db.prepare("SELECT * FROM sessions WHERE id < ? ORDER BY id DESC LIMIT ?").all(beforeId, limit) as SessionRow[];
  }
  return db.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT ?").all(limit) as SessionRow[];
}

export function telemetryTotals(db: Database): TelemetryTotals {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS sessions,
         COALESCE(SUM(attempts), 0) AS attempts,
         COALESCE(SUM(tokens_in), 0) AS tokens_in,
         COALESCE(SUM(tokens_out), 0) AS tokens_out,
         COALESCE(SUM(
           CASE
             WHEN ended_at IS NOT NULL AND ended_at >= started_at
             THEN ended_at - started_at
             ELSE 0
           END
         ), 0) AS duration_ms
       FROM sessions`,
    )
    .get() as TelemetryTotals;
}

export function priorPushedSessions(
  db: Database,
  repo: string,
  beforeSessionId: number,
  limit = 6,
): SessionRow[] {
  return db
    .prepare(
      `SELECT s.*
       FROM sessions s
       WHERE s.repo = ?
         AND s.id < ?
         AND s.outcome != 'reverted'
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.session_id = s.id AND e.event = 'pushed'
         )
       ORDER BY s.id DESC
       LIMIT ?`,
    )
    .all(repo, beforeSessionId, limit) as SessionRow[];
}

export function sessionById(db: Database, id: number): SessionRow | null {
  return (db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined) ?? null;
}

export function eventsForSession(db: Database, sessionId: number): EventRow[] {
  return db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id ASC").all(sessionId) as EventRow[];
}

export function recentLands(db: Database, limit = 10): LandRow[] {
  return db.prepare("SELECT * FROM lands ORDER BY id DESC LIMIT ?").all(limit) as LandRow[];
}
