import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { Config } from "./config";
import { repoKey } from "./config";
import { anyPolls, eventsForSession, lastPoll, lastSession, type SessionRow } from "./db";
import { reportFromSession } from "./telemetry";

export const LOCK_PATH = join(process.cwd(), "data", "samasara.lock");

export function lockPid(): number | null {
  try {
    const raw = readFileSync(LOCK_PATH, "utf8").trim();
    const pid = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isSamasaraProcess(pid: number): boolean {
  if (!processIsAlive(pid)) return false;
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    const script = resolve(import.meta.dir, "index.ts");
    const runsThisScript = argv.some((arg) => arg !== "" && resolve(cwd, arg) === script);
    return runsThisScript && (argv.includes("start") || argv.includes("_daemon"));
  } catch {
    return false;
  }
}

export function applicationStatus(config: Config, db: Database) {
  const pid = lockPid();
  const running = pid != null && isSamasaraProcess(pid);
  return {
    daemon: { running, pid: running ? pid : null, staleLockPid: running ? null : pid },
    pollIntervalSeconds: config.pollIntervalSeconds,
    hasPolls: anyPolls(db),
    repos: config.repos.map((repo) => {
      const key = repoKey(repo);
      const session = lastSession(db, key);
      return {
        ...repo,
        ignoreChecks: repo.ignoreChecks ?? [],
        repo: key,
        poll: lastPoll(db, key),
        session: session ? {
          id: session.id,
          outcome: session.outcome,
          start_sha: session.start_sha,
          started_at: session.started_at,
          ended_at: session.ended_at,
        } : null,
      };
    }),
  };
}

export function healReport(config: Config, db: Database, session: SessionRow) {
  const logPath = join(config.logDir, `${session.id}.omp.jsonl`);
  const events = eventsForSession(db, session.id);
  const report = reportFromSession({ session, events });
  if (report.reasoning != null && report.patch != null) return report;
  const ompJsonl = existsSync(logPath) ? readFileSync(logPath, "utf8") : null;
  return ompJsonl ? reportFromSession({ session, events, ompJsonl }) : report;
}
