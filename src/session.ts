import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { checkDiff } from "./anticheat";
import type { Config, RepoRef } from "./config";
import { ignoreChecksFor, repoKey } from "./config";
import {
  activeSession,
  appendEvent,
  beginSession,
  finishSession,
  insertLand,
  landsToday,
  lastSession,
  type FinishFields,
} from "./db";
import { fetchFailedJobLog, pollRepo, resolveGitIdentity, type GitIdentity } from "./github";
import { notifyHuman } from "./notify";
import { buildPriorHealContext, extractOmpReasoning } from "./telemetry";
import { monitoringEnvironment, recordMonitoringEvent } from "./observability";

const BUN_BIN = "/home/opc/.bun/bin";
const SAMASARA_ACTOR_HASH = createHash("sha256").update("service:samasara").digest("hex");
const NO_RETRY: Record<string, true> = {
  landed: true,
  reverted: true,
  gave_up: true,
  not_reproduced: true,
  denied_policy: true,
  budget: true,
  follow_up: true,
};

export type SessionRunResult =
  | { kind: "idle" }
  | { kind: "done" }
  | { kind: "iterate"; sha: string; red: string[]; ompSessionId: string | null; work: string };

export type PostLandAction = "watch" | "landed" | "revert" | "iterate" | "stop";

export function postLandAction(opts: {
  result: string;
  originalRed: string[];
  currentRed: string[];
  iteration: number;
  maxIterations: number;
}): PostLandAction {
  if (opts.result === "pending" || opts.result === "no_rollup") return "watch";
  if (opts.result === "green") return "landed";
  if (opts.result !== "red") return "watch";
  // No original list: cannot tell “new” vs “same” → revert.
  if (opts.originalRed.length === 0) return "revert";
  // Keep the land. Same-check-still-red used to revert and ate stale-gate
  // removals when the job then failed a later step. Iterate, or stop at max.
  if (opts.iteration < opts.maxIterations) return "iterate";
  return "stop";
}

export function resolveWorktree(opts: {
  workDir: string;
  repo: RepoRef;
  sha: string;
  previousWork?: string | null;
}): { work: string; reuse: boolean } {
  const previous = opts.previousWork?.trim() ?? "";
  if (previous !== "") return { work: previous, reuse: true };
  return { work: join(opts.workDir, opts.repo.owner, opts.repo.name, opts.sha), reuse: false };
}

function scrub(text: string, token: string): string {
  return text.split(token).join("[REDACTED]");
}

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function gitAuthArgs(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", "credential.helper=", "-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

function gitAuthorArgs(ident: GitIdentity): string[] {
  return ["-c", `user.name=${ident.name}`, "-c", `user.email=${ident.email}`, "-c", "commit.gpgsign=false"];
}

async function captured(
  cmd: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    detached?: boolean;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string; aborted: boolean }> {
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: opts.detached ?? false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { code: 127, stdout: "", stderr: msg, aborted: false };
  }
  let aborted = false;
  const killTree = () => {
    aborted = true;
    if (proc.pid) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  };
  const timer = opts.timeoutMs != null ? setTimeout(killTree, opts.timeoutMs) : undefined;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code: code ?? 1, stdout, stderr, aborted };
}

export function extractOmpSessionId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    if (rec.type === "session" && typeof rec.id === "string" && rec.id !== "") return rec.id;
  }
  return null;
}

function parseOmpJsonl(
  db: Database,
  sessionId: number,
  stdout: string,
): { tokens_in: number; tokens_out: number; reasoning: string | null; ompSessionId: string | null; model: string | null } {
  let tokens_in = 0;
  let tokens_out = 0;
  let model: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    if (rec.type === "agent_end") {
      let src: Record<string, unknown> = rec;
      if (rec.usage && typeof rec.usage === "object") src = rec.usage as Record<string, unknown>;
      const tin = src.tokens_in ?? src.input_tokens ?? src.prompt_tokens;
      const tout = src.tokens_out ?? src.output_tokens ?? src.completion_tokens;
      if (typeof tin === "number") tokens_in = tin;
      if (typeof tout === "number") tokens_out = tout;
    }
    const candidateModel = rec.model ?? rec.model_id ?? rec.deployment;
    if (typeof candidateModel === "string" && candidateModel.trim() !== "") model = candidateModel.trim();
    if (rec.type === "tool_execution_start" || rec.type === "tool_execution_end") {
      let toolName = "unknown";
      if (typeof rec.toolName === "string") toolName = rec.toolName;
      else if (typeof rec.tool_name === "string") toolName = rec.tool_name;
      appendEvent(db, sessionId, String(rec.type), { toolName });
    }
  }
  return {
    tokens_in,
    tokens_out,
    reasoning: extractOmpReasoning(stdout),
    ompSessionId: extractOmpSessionId(stdout),
    model,
  };
}

function namesFromDiff(stdout: string): string[] {
  const out: string[] = [];
  const seen: Record<string, true> = {};
  for (const line of stdout.split("\n")) {
    const n = line.trim();
    if (n === "" || seen[n]) continue;
    seen[n] = true;
    out.push(n);
  }
  return out;
}

async function remoteSha(work: string, token: string, ref: string): Promise<string> {
  const lr = await captured(["git", "-C", work, ...gitAuthArgs(token), "ls-remote", "origin", `refs/heads/${ref}`], {
    env: gitEnv(),
  });
  return lr.stdout.trim().split(/\s+/)[0] ?? "";
}

async function worktreeAtSha(work: string, sha: string, token: string): Promise<boolean> {
  const head = await captured(["git", "-C", work, "rev-parse", "HEAD"], { env: gitEnv() });
  if (head.code === 0 && head.stdout.trim() === sha) return true;
  if (head.code !== 0) return false;
  const fetch = await captured(
    ["git", "-C", work, ...gitAuthArgs(token), "fetch", "--depth", "50", "origin", sha],
    { env: gitEnv() },
  );
  if (fetch.code !== 0) return false;
  const co = await captured(["git", "-C", work, "checkout", "--detach", sha], { env: gitEnv() });
  return co.code === 0;
}

async function cloneWorktree(opts: {
  work: string;
  token: string;
  repo: RepoRef;
  ref: string;
  sha: string;
}): Promise<{ ok: true } | { ok: false; stage: "clone" | "fetch" | "checkout"; error: string }> {
  const { work, token, repo, ref, sha } = opts;
  rmSync(work, { recursive: true, force: true });
  const cloneUrl = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git`;
  let clone = await captured(["git", "clone", "--depth", "50", "--branch", ref, cloneUrl, work], {
    env: gitEnv(),
  });
  if (clone.code !== 0) {
    rmSync(work, { recursive: true, force: true });
    const plain = `https://github.com/${repo.owner}/${repo.name}.git`;
    clone = await captured(
      ["git", ...gitAuthArgs(token), "clone", "--depth", "50", "--branch", ref, plain, work],
      { env: gitEnv() },
    );
  }
  if (clone.code !== 0) return { ok: false, stage: "clone", error: scrub(clone.stderr.slice(0, 400), token) };
  await captured(["git", "-C", work, "remote", "set-url", "origin", `https://github.com/${repo.owner}/${repo.name}.git`], {
    env: gitEnv(),
  });
  const fetch = await captured(
    ["git", "-C", work, ...gitAuthArgs(token), "fetch", "--depth", "50", "origin", sha],
    { env: gitEnv() },
  );
  if (fetch.code !== 0) return { ok: false, stage: "fetch", error: scrub(fetch.stderr.slice(0, 400), token) };
  const co = await captured(["git", "-C", work, "checkout", "--detach", sha], { env: gitEnv() });
  if (co.code !== 0) return { ok: false, stage: "checkout", error: scrub(co.stderr.slice(0, 400), token) };
  return { ok: true };
}

export async function runSession(opts: {
  config: Config;
  db: Database;
  token: string;
  repo: RepoRef;
  sha: string;
  originalRed?: string[];
  iteration?: number;
  ompSessionId?: string | null;
  work?: string | null;
  force?: boolean;
}): Promise<SessionRunResult> {
  const { config, db, token, repo, sha } = opts;
  const originalRed = opts.originalRed ?? [];
  const iteration = opts.iteration ?? 1;
  const ignore = ignoreChecksFor(config, repo);
  const key = repoKey(repo);
  const maxAge = config.maxSessionMinutes * 60_000 + 5 * 60_000;
  const active = activeSession(db, key);
  if (active) {
    if (active.started_at < Date.now() - maxAge) {
      finishSession(db, active.id, { outcome: "error", error: "stale lock" });
    } else {
      console.log(`${key} skip active session ${active.id}`);
      return { kind: "idle" };
    }
  }
  const last = lastSession(db, key);
  if (last && last.start_sha === sha && last.outcome && NO_RETRY[last.outcome]) {
    console.log(`${key} skip no_retry ${last.outcome} sha=${sha.slice(0, 12)}`);
    return { kind: "idle" };
  }
  if (
    last &&
    last.outcome === "reverted" &&
    last.ended_at != null &&
    last.ended_at > Date.now() - config.revertCooldownHours * 3_600_000
  ) {
    if (!opts.force) {
      const until = new Date(last.ended_at + config.revertCooldownHours * 3_600_000).toISOString();
      console.log(`${key} skip revert_cooldown until ${until}`);
      return { kind: "idle" };
    }
    console.log(`${key} once bypass revert_cooldown`);
  }
  if (landsToday(db, key) >= config.maxLandsPerRepoPerUtcDay) {
    console.log(`${key} skip daily land cap ${config.maxLandsPerRepoPerUtcDay}`);
    return { kind: "idle" };
  }

  const id = beginSession(db, key, config.ref, sha);
  appendEvent(db, id, "lock_acquired", { sha });
  console.log(`${key} session ${id} start ${sha}`);

  const { work, reuse } = resolveWorktree({
    workDir: config.workDir,
    repo,
    sha,
    previousWork: opts.work,
  });
  let finished = false;
  let keepWork = false;
  let notifyFields: FinishFields | null = null;
  const finish = (fields: FinishFields) => {
    if (finished) return;
    finished = true;
    notifyFields = fields;
    finishSession(db, id, fields);
    const err = fields.error ? ` ${fields.error}` : "";
    console.log(`${key} session ${id} ${fields.outcome ?? "error"}${err}`);
  };

  try {
    mkdirSync(dirname(work), { recursive: true });
    let haveWork = false;
    if (reuse) haveWork = await worktreeAtSha(work, sha, token);
    if (haveWork) {
      console.log(`${key} session ${id} reuse worktree`);
    } else {
      const cloned = await cloneWorktree({ work, token, repo, ref: config.ref, sha });
      if (!cloned.ok) {
        appendEvent(db, id, "gave_up", { stage: cloned.stage, error: cloned.error });
        finish({ outcome: "error", error: cloned.error });
        return { kind: "done" };
      }
    }

    let runId: number | null = null;
    let logPath: string | null = null;
    try {
      const logs = await fetchFailedJobLog(token, repo, config.ref, sha, config.logDir, ignore);
      runId = logs.runId;
      logPath = logs.logPath;
    } catch {
      /* still run omp */
    }
    let bytes = 0;
    if (logPath) {
      try {
        bytes = statSync(logPath).size;
      } catch {
        logPath = null;
      }
    }
    appendEvent(db, id, "logs_fetched", { runId, bytes });

    const denyAbs = resolve(join(import.meta.dir, "omp", "deny-git-land.ts"));
    const healerAbs = resolve(join(import.meta.dir, "..", "healer.md"));
    const sessionDir = join(config.logDir, "omp-sessions");
    mkdirSync(sessionDir, { recursive: true });
    const ompArgs = [
      "omp",
      "-p",
      "--auto-approve",
      "--approval-mode",
      "yolo",
      "--no-title",
      "--no-pty",
      "--no-lsp",
      "--no-skills",
      "--no-extensions",
      "--no-rules",
      "--session-dir",
      sessionDir,
      "--cwd",
      work,
      "--max-time",
      `${config.maxSessionMinutes}m`,
      "--tools",
      "read,edit,write,grep,glob,bash",
      "-e",
      denyAbs,
      "--append-system-prompt",
      healerAbs,
      "--mode",
      "json",
    ];
    if (opts.ompSessionId) {
      ompArgs.push("--resume", opts.ompSessionId);
      appendEvent(db, id, "omp_resume", { ompSessionId: opts.ompSessionId });
    }
    const questionHasher = createHash("sha256");
    const hashQuestionPart = (value: string | Uint8Array) => {
      questionHasher.update(value);
      questionHasher.update("\u001e");
    };
    if (logPath) {
      ompArgs.push(`@${logPath}`);
      try {
        hashQuestionPart(readFileSync(logPath));
      } catch {
        /* the missing attachment is already represented by logs_fetched */
      }
    }
    const priorHealContext = buildPriorHealContext(db, key, id);
    if (priorHealContext) {
      ompArgs.push(priorHealContext);
      hashQuestionPart(priorHealContext);
    }
    const instruction = iteration > 1
      ? `HEAD ${sha} on ${config.ref} is still red after the previous land. New failing checks: ${originalRed.length > 0 ? originalRed.join("; ") : "unknown"}. Your earlier patch is already in this checkout and in this session. Reproduce the new failure, patch, re-run until green. Do not commit or push.`
      : `HEAD ${sha} on ${config.ref} is red. Reproduce the failed job, patch, re-run until green. Do not commit or push.`;
    ompArgs.push(instruction);
    hashQuestionPart(instruction);
    const questionHash = questionHasher.digest("hex");
    const traceId = randomBytes(16).toString("hex");
    const ompEnv = gitEnv();
    ompEnv.PATH = `${BUN_BIN}:${ompEnv.PATH ?? ""}`;
    const ompStart = Date.now();
    console.log(`${key} session ${id} omp`);
    const omp = await captured(ompArgs, {
      env: ompEnv,
      timeoutMs: (config.maxSessionMinutes * 60 + 30) * 1000,
      detached: true,
    });
    const sandbox_s = Math.round((Date.now() - ompStart) / 1000);
    writeFileSync(join(config.logDir, `${id}.omp.jsonl`), omp.stdout);
    const usage = parseOmpJsonl(db, id, omp.stdout);
    const attempts = iteration;
    if (usage.reasoning) appendEvent(db, id, "reasoning", { text: usage.reasoning });
    try {
      const result = omp.aborted ? "timeout" : omp.code === 0 ? "success" : "failure";
      const recorded = await recordMonitoringEvent(
        db,
        {
          application: "samasara",
          environment: monitoringEnvironment(),
          userIdHash: SAMASARA_ACTOR_HASH,
          sessionId: usage.ompSessionId ?? String(id),
          traceId,
        },
        {
          eventName: "ai_interaction",
          feature: "healer.completion",
          result,
          durationMs: Date.now() - ompStart,
          repository: key,
          commitSha: sha,
          model: usage.model ?? "unknown",
          promptTokens: usage.tokens_in,
          completionTokens: usage.tokens_out,
          questionHash,
          attributes: { iteration, exit_code: omp.code },
        },
      );
      if (recorded.flush.error) console.error(`${key} session ${id} telemetry deferred ${recorded.flush.error}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${key} session ${id} telemetry failed ${message.slice(0, 200)}`);
    }

    if (omp.aborted) {
      finish({
        outcome: "budget",
        attempts,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        sandbox_s,
        oracle_json: JSON.stringify({ runId }),
      });
      return { kind: "done" };
    }
    if (omp.code === 127 || /not found|ENOENT/i.test(omp.stderr)) {
      finish({
        outcome: "error",
        error: "omp not found",
        attempts,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        sandbox_s,
        oracle_json: JSON.stringify({ runId }),
      });
      return { kind: "done" };
    }

    await captured(["git", "-C", work, "add", "-A"], { env: gitEnv() });
    const unstaged = await captured(["git", "-C", work, "diff", "--no-color", "HEAD"], { env: gitEnv() });
    const cached = await captured(["git", "-C", work, "diff", "--no-color", "--cached"], { env: gitEnv() });
    const diff = [unstaged.stdout, cached.stdout].filter((s) => s.trim() !== "").join("\n");
    const nameHead = await captured(["git", "-C", work, "diff", "--name-only", "HEAD"], { env: gitEnv() });
    const nameCached = await captured(["git", "-C", work, "diff", "--name-only", "--cached"], { env: gitEnv() });
    const files = namesFromDiff(`${nameHead.stdout}\n${nameCached.stdout}`);
    const stat = await captured(["git", "-C", work, "diff", "--stat", "HEAD"], { env: gitEnv() });
    const storedDiff = diff.length > 100_000 ? `${diff.slice(0, 100_000)}\n…` : diff;
    const verdict = checkDiff(diff);
    if (!verdict.ok && verdict.rule === "empty") {
      finish({
        outcome: omp.code === 0 ? "not_reproduced" : "gave_up",
        reproduced: 0,
        attempts,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        sandbox_s,
        oracle_json: JSON.stringify({ runId }),
      });
      return { kind: "done" };
    }
    appendEvent(db, id, "patch_proposed", { files, stat: stat.stdout.trim(), diff: storedDiff });
    if (!verdict.ok) {
      appendEvent(db, id, "anticheat", { pass: false, rule: verdict.rule });
      finish({
        outcome: "denied_policy",
        failure_class: verdict.rule,
        reproduced: 1,
        files_json: JSON.stringify(files),
        attempts,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        sandbox_s,
        oracle_json: JSON.stringify({ runId }),
        error: verdict.detail,
      });
      return { kind: "done" };
    }
    appendEvent(db, id, "anticheat", { pass: true });

    if (config.dryRun) {
      finish({
        outcome: "gave_up",
        error: "dryRun",
        reproduced: 1,
        files_json: JSON.stringify(files),
        attempts,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        sandbox_s,
        oracle_json: JSON.stringify({ runId }),
      });
      return { kind: "done" };
    }

    await captured(["git", "-C", work, "add", "-A"], { env: gitEnv() });
    let ident: GitIdentity;
    if (config.gitName !== "" && config.gitEmail !== "") {
      ident = { name: config.gitName, email: config.gitEmail };
    } else {
      try {
        ident = await resolveGitIdentity(token);
      } catch (e) {
        const err = scrub(e instanceof Error ? e.message : String(e), token);
        finish({
          outcome: "error",
          error: `git identity: ${err}`,
          reproduced: 1,
          files_json: JSON.stringify(files),
          attempts,
          tokens_in: usage.tokens_in,
          tokens_out: usage.tokens_out,
          sandbox_s,
          oracle_json: JSON.stringify({ runId }),
        });
      return { kind: "done" };
      }
    }
    const commit = await captured(
      ["git", "-C", work, ...gitAuthorArgs(ident), "commit", "-m", `heal: ${sha.slice(0, 12)}`],
      { env: gitEnv() },
    );
    if (commit.code !== 0) {
      finish({
        outcome: "error",
        error: scrub(commit.stderr.slice(0, 400), token),
        reproduced: 1,
        files_json: JSON.stringify(files),
        attempts,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        sandbox_s,
        oracle_json: JSON.stringify({ runId }),
      });
      return { kind: "done" };
    }

    const expected = sha;
    const actual = await remoteSha(work, token, config.ref);
    if (actual !== expected) {
      appendEvent(db, id, "aborted_head_moved", { expected, actual });
      finish({
        outcome: "head_moved",
        reproduced: 1,
        files_json: JSON.stringify(files),
        attempts,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        sandbox_s,
        oracle_json: JSON.stringify({ runId }),
      });
      return { kind: "done" };
    }

    const push = await captured(
      ["git", "-C", work, ...gitAuthArgs(token), "push", "origin", `HEAD:refs/heads/${config.ref}`],
      { env: gitEnv() },
    );
    if (push.code !== 0) {
      const err = scrub(`${push.stdout}\n${push.stderr}`.slice(0, 400), token);
      const moved = /non-fast-forward|rejected/i.test(err);
      finish({
        outcome: moved ? "head_moved" : "error",
        error: err,
        reproduced: 1,
        files_json: JSON.stringify(files),
        attempts,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        sandbox_s,
        oracle_json: JSON.stringify({ runId }),
      });
      return { kind: "done" };
    }

    const end = await captured(["git", "-C", work, "rev-parse", "HEAD"], { env: gitEnv() });
    const end_sha = end.stdout.trim();
    insertLand(db, { session_id: id, repo: key, sha: end_sha });
    appendEvent(db, id, "pushed", { from_sha: sha, to_sha: end_sha });

    let outcome: "landed" | "reverted" | "error" | "follow_up" | "gave_up" = "landed";
    let watchError: string | null = null;
    let iterateRed: string[] | null = null;
    const deadline = Date.now() + config.postLandWatchSeconds * 1000;
    while (Date.now() < deadline) {
      await Bun.sleep(config.postLandPollSeconds * 1000);
      let polled;
      try {
        polled = await pollRepo(token, repo, config.ref, ignore);
      } catch {
        continue;
      }
      appendEvent(db, id, "post_land_poll", { state: polled.result, red: polled.red });
      const action = postLandAction({
        result: polled.result,
        originalRed,
        currentRed: polled.red,
        iteration,
        maxIterations: config.maxHealIterations,
      });
      if (action === "watch") continue;
      if (action === "landed") {
        outcome = "landed";
        break;
      }
      if (action === "iterate") {
        outcome = "follow_up";
        iterateRed = polled.red;
        break;
      }
      if (action === "stop") {
        outcome = "gave_up";
        watchError = "max iterations; new failures remain";
        break;
      }
      const nowRemote = await remoteSha(work, token, config.ref);
      if (nowRemote !== end_sha) {
        outcome = "error";
        watchError = "head moved before revert";
        break;
      }
      const revert = await captured(
        ["git", "-C", work, ...gitAuthorArgs(ident), "revert", "--no-edit", "HEAD"],
        { env: gitEnv() },
      );
      if (revert.code !== 0) {
        outcome = "error";
        watchError = scrub(revert.stderr.slice(0, 400), token);
        break;
      }
      const stillHead = await remoteSha(work, token, config.ref);
      if (stillHead !== end_sha) {
        outcome = "error";
        watchError = "head moved before revert push";
        break;
      }
      const revertPush = await captured(
        ["git", "-C", work, ...gitAuthArgs(token), "push", "origin", `HEAD:refs/heads/${config.ref}`],
        { env: gitEnv() },
      );
      if (revertPush.code !== 0) {
        outcome = "error";
        watchError = scrub(revertPush.stderr.slice(0, 400), token);
        break;
      }
      outcome = "reverted";
      break;
    }

    finish({
      end_sha,
      outcome,
      reproduced: 1,
      files_json: JSON.stringify(files),
      attempts,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      sandbox_s,
      oracle_json: JSON.stringify({ runId, originalRed, currentRed: iterateRed }),
      error: watchError,
    });
    if (iterateRed) {
      keepWork = true;
      const ompSessionId = usage.ompSessionId ?? opts.ompSessionId ?? null;
      return { kind: "iterate", sha: end_sha, red: iterateRed, ompSessionId, work };
    }
    return { kind: "done" };
  } catch (e) {
    const msg = scrub(e instanceof Error ? e.message : String(e), token);
    finish({ outcome: "error", error: msg });
    return { kind: "done" };
  } finally {
    if (!finished) finish({ outcome: "error", error: "unfinished session" });
    if (!keepWork && process.env.SAMASARA_KEEP_WORK !== "1") {
      rmSync(work, { recursive: true, force: true });
    }
    if (notifyFields) {
      try {
        await notifyHuman({ config, db, repo: key, sessionId: id, sha, fields: notifyFields });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`notify failed ${msg.slice(0, 200)}`);
      }
    }
  }
}
