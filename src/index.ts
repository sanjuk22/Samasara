import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { Config } from "./config";
import {
  addRepoIgnore,
  addTrackedRepo,
  configFilePath,
  editConfigFile,
  ignoreChecksFor,
  loadConfig,
  readRepoConfig,
  removeRepoIgnore,
  removeTrackedRepo,
  repoKey,
} from "./config";
import { insertPoll, openDb, recentSessions, sessionById } from "./db";
import { pollRepo, resolveGithubToken } from "./github";
import { notifyHuman } from "./notify";
import { runSession } from "./session";
import { formatHealReport } from "./telemetry";
import { applicationStatus, healReport, isSamasaraProcess, LOCK_PATH, lockPid, processIsAlive } from "./management";
import { startDashboard } from "./dashboard";
import { flushMonitoringOutbox } from "./observability";

const USAGE = `usage: bun src/index.ts <start|stop|once|status|telemetry|dashboard|notify-test|repo>
  start
  stop
  telemetry [sessionId]
  dashboard
  repo ls
  repo add <owner/name>
  repo rm <owner/name>
  repo ignore <owner/name> <pattern>
  repo unignore <owner/name> <pattern>`;

export async function tick(
  config: Config,
  db: Database,
  token: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const monitoring = await flushMonitoringOutbox(db);
  if (monitoring.error) console.error(`monitoring flush deferred ${monitoring.error}`);
  for (const repo of config.repos) {
    const key = repoKey(repo);
    const t0 = Date.now();
    try {
      const ignore = ignoreChecksFor(config, repo);
      const polled = await pollRepo(token, repo, config.ref, ignore);
      const { sha, result, ignored } = polled;
      insertPoll(db, { repo: key, sha, result, duration_ms: Date.now() - t0 });
      const ignoreNote = ignored.length > 0 ? ` ignore=${ignored.join(";")}` : "";
      console.log(`${key} ${result} ${sha}${ignoreNote}`);
      if (result === "red") {
        let healSha = sha;
        let originalRed = polled.red;
        let ompSessionId: string | null = null;
        let previousWork: string | null = null;
        for (let iteration = 1; iteration <= config.maxHealIterations; iteration++) {
          const ran = await runSession({
            config,
            db,
            token,
            repo,
            sha: healSha,
            originalRed,
            iteration,
            ompSessionId,
            work: previousWork,
            force: opts.force,
          });
          if (ran.kind !== "iterate") break;
          healSha = ran.sha;
          originalRed = ran.red;
          ompSessionId = ran.ompSessionId;
          previousWork = ran.work;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      insertPoll(db, { repo: key, sha: null, result: "api_error", duration_ms: Date.now() - t0 });
      console.error(`${key} api_error ${msg.slice(0, 200)}`);
    }
  }
}

function printStatus(config: Config, db: Database): void {
  const status = applicationStatus(config, db);
  const { daemon } = status;
  if (daemon.running) {
    console.log(`daemon=running pid=${daemon.pid}`);
  } else if (daemon.staleLockPid != null) {
    console.log(`daemon=stopped stale_lock_pid=${daemon.staleLockPid}`);
  } else {
    console.log("daemon=stopped");
  }
  if (!status.hasPolls) {
    console.log("no polls yet");
    return;
  }
  for (const { repo, poll, session: sess } of status.repos) {
    const pollPart = poll
      ? `poll=${poll.result} sha=${poll.sha ?? "-"} at=${new Date(poll.at).toISOString()}`
      : "poll=none";
    const sessPart = sess
      ? `session=${sess.outcome ?? "running"} start_sha=${sess.start_sha} ended_at=${sess.ended_at ? new Date(sess.ended_at).toISOString() : "-"}`
      : "session=none";
    console.log(`${repo} ${pollPart} ${sessPart}`);
  }
}


function printTelemetry(config: Config, db: Database, sessionId?: number): void {
  if (sessionId != null) {
    const sess = sessionById(db, sessionId);
    if (!sess) {
      console.log(`session ${sessionId} not found`);
      return;
    }
    console.log(formatHealReport(healReport(config, db, sess), { fullPatch: true }));
    return;
  }
  const sessions = recentSessions(db, 10);
  if (sessions.length === 0) {
    console.log("no sessions yet");
    return;
  }
  for (const s of sessions) {
    console.log(formatHealReport(healReport(config, db, s), { fullPatch: false }));
    console.log("");
  }
}

const DAEMON_LOG_PATH = join(process.cwd(), "data", "samasara.log");




function removeOwnedLock(pid: number): void {
  if (lockPid() !== pid) return;
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* already gone */
  }
}

function claimStartLock(): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  const existing = lockPid();
  if (existing != null && isSamasaraProcess(existing)) throw new Error(`already running pid ${existing}`);
  if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
  const fd = openSync(LOCK_PATH, "wx");
  try {
    writeFileSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
}

function acquireDaemonLock(starterPid: number): void {
  const existing = lockPid();
  if (existing !== starterPid) {
    if (existing != null && processIsAlive(existing)) throw new Error(`already running pid ${existing}`);
    throw new Error("start lock was lost");
  }
  writeFileSync(LOCK_PATH, String(process.pid));
}

async function startDetached(): Promise<void> {
  loadConfig();
  claimStartLock();
  const logFd = openSync(DAEMON_LOG_PATH, "a");
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([process.execPath, resolve(import.meta.path), "_daemon", String(process.pid)], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      detached: true,
    });
  } catch (e) {
    removeOwnedLock(process.pid);
    throw e;
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (lockPid() === child.pid && processIsAlive(child.pid)) {
      console.log(`started pid ${child.pid}; log ${DAEMON_LOG_PATH}`);
      return;
    }
    if (child.exitCode != null) break;
    await Bun.sleep(50);
  }
  removeOwnedLock(process.pid);
  if (processIsAlive(child.pid)) child.kill("SIGTERM");
  throw new Error(`daemon failed to start; see ${DAEMON_LOG_PATH}`);
}

async function stopDetached(): Promise<void> {
  const pid = lockPid();
  if (pid == null || !isSamasaraProcess(pid)) {
    if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
    console.log("not running");
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && processIsAlive(pid)) await Bun.sleep(50);
  if (processIsAlive(pid)) {
    console.log(`stop requested for pid ${pid}; waiting for the current poll to finish`);
  } else {
    removeOwnedLock(pid);
    console.log(`stopped pid ${pid}`);
  }
}

async function runDaemon(config: Config, db: Database, token: string): Promise<void> {
  let ticking = false;
  let stopping = false;
  const shutdown = () => {
    removeOwnedLock(process.pid);
    process.exit(0);
  };
  const onStop = () => {
    stopping = true;
    if (!ticking) shutdown();
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  const maybeTick = async () => {
    if (ticking || stopping) return;
    ticking = true;
    try {
      const latest = readRepoConfig();
      await tick({ ...config, repos: latest.repos, ignoreChecks: latest.ignoreChecks }, db, token);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
    } finally {
      ticking = false;
      if (stopping) shutdown();
    }
  };

  setInterval(() => {
    void maybeTick();
  }, config.pollIntervalSeconds * 1000);
  await maybeTick();
}

function usage(): never {
  console.log(USAGE);
  process.exit(1);
}

function runRepoCommand(argv: string[]): void {
  const sub = argv[3];
  if (sub === "ls" || sub === "list") {
    const { repos } = readRepoConfig();
    if (repos.length === 0) {
      console.log("no repos tracked");
      return;
    }
    for (const r of repos) {
      const ign = r.ignoreChecks?.length ? ` ignore=${r.ignoreChecks.join(";")}` : "";
      console.log(`${repoKey(r)}${ign}`);
    }
    return;
  }
  if (sub === "add") {
    const spec = argv[4];
    if (!spec) usage();
    const file = configFilePath();
    if (!existsSync(file)) {
      const example = join(process.cwd(), "config.example.json");
      if (!existsSync(example)) throw new Error("config.example.json not found");
      copyFileSync(example, file);
    }
    editConfigFile((obj) => { addTrackedRepo(obj, spec); });
    console.log(`added ${spec}`);
    return;
  }
  if (sub === "rm" || sub === "remove") {
    const spec = argv[4];
    if (!spec) usage();
    editConfigFile((obj) => { removeTrackedRepo(obj, spec); });
    console.log(`removed ${spec}`);
    return;
  }
  if (sub === "ignore") {
    const spec = argv[4];
    const pattern = argv.slice(5).join(" ");
    if (!spec || pattern.trim() === "") usage();
    editConfigFile((obj) => { addRepoIgnore(obj, spec, pattern); });
    console.log(`ignore ${spec} ${pattern.trim()}`);
    return;
  }
  if (sub === "unignore") {
    const spec = argv[4];
    const pattern = argv.slice(5).join(" ");
    if (!spec || pattern.trim() === "") usage();
    editConfigFile((obj) => { removeRepoIgnore(obj, spec, pattern); });
    console.log(`unignore ${spec} ${pattern.trim()}`);
    return;
  }
  usage();
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "dashboard") {
    await startDashboard();
    return;
  }
  if (cmd === "repo") {
    runRepoCommand(process.argv);
    return;
  }
  if (cmd === "start") {
    await startDetached();
    return;
  }
  if (cmd === "stop") {
    await stopDetached();
    return;
  }
  if (cmd === "_daemon") {
    const starterPid = Number.parseInt(process.argv[3] ?? "", 10);
    if (!Number.isFinite(starterPid) || starterPid <= 0) throw new Error("invalid daemon starter pid");
    acquireDaemonLock(starterPid);
    try {
      const config = loadConfig();
      const db = openDb(config);
      const token = await resolveGithubToken();
      await runDaemon(config, db, token);
    } catch (e) {
      removeOwnedLock(process.pid);
      throw e;
    }
    return;
  }
  if (cmd !== "once" && cmd !== "status" && cmd !== "telemetry" && cmd !== "notify-test") usage();
  const config = loadConfig();
  const db = openDb(config);
  if (cmd === "status") {
    printStatus(config, db);
    return;
  }
  if (cmd === "telemetry") {
    const raw = process.argv[3];
    if (raw) {
      const id = Number.parseInt(raw, 10);
      if (!Number.isFinite(id)) usage();
      printTelemetry(config, db, id);
    } else {
      printTelemetry(config, db);
    }
    return;
  }
  if (cmd === "notify-test") {
    await notifyHuman({
      config,
      db,
      repo: config.repos[0] ? `${config.repos[0].owner}/${config.repos[0].name}` : "test/repo",
      sessionId: 0,
      sha: "0".repeat(40),
      fields: { outcome: "gave_up", error: "notify-test" },
    });
    return;
  }
  const token = await resolveGithubToken();
  await tick(config, db, token, { force: true });
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
