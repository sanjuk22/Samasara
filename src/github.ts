import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoRef } from "./config";
import { redactSecrets } from "./anticheat";

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "samasara",
});

const POLL_QUERY = `query($owner: String!, $name: String!, $qualifiedRef: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $qualifiedRef) {
      target {
        ... on Commit {
          oid
          statusCheckRollup {
            state
            contexts(first: 100) {
              nodes {
                __typename
                ... on CheckRun {
                  name
                  status
                  conclusion
                  checkSuite {
                    workflowRun {
                      event
                      workflow { name }
                    }
                  }
                }
                ... on StatusContext {
                  context
                  state
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export type RollupResult = "green" | "red" | "pending" | "no_rollup";

const GREEN: Record<string, true> = { SUCCESS: true, NEUTRAL: true, SKIPPED: true };
const PENDING: Record<string, true> = { PENDING: true, EXPECTED: true };
const RED: Record<string, true> = {
  FAILURE: true,
  ERROR: true,
  TIMED_OUT: true,
  CANCELLED: true,
  ACTION_REQUIRED: true,
  STARTUP_FAILURE: true,
};

export async function resolveGithubToken(): Promise<string> {
  const envTok = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envTok && envTok.trim() !== "") return envTok.trim();
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stdout = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (stdout === "") throw new Error("No GitHub token; set GITHUB_TOKEN or run gh auth login");
  return stdout;
}

export type GitIdentity = { name: string; email: string };

export function gitIdentityFromUser(user: { id: number; login: string; name?: string | null }): GitIdentity {
  const rawName = user.name;
  const name = typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : user.login;
  return { name, email: `${user.id}+${user.login}@users.noreply.github.com` };
}

export async function resolveGitIdentity(token: string): Promise<GitIdentity> {
  const res = await fetch("https://api.github.com/user", { headers: GH_HEADERS(token) });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 500)}`);
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid /user");
  if (!("id" in parsed) || !("login" in parsed)) throw new Error("invalid /user");
  if (typeof parsed.id !== "number" || typeof parsed.login !== "string" || parsed.login === "") {
    throw new Error("invalid /user");
  }
  let name: string | null = null;
  if ("name" in parsed && typeof parsed.name === "string") name = parsed.name;
  return gitIdentityFromUser({ id: parsed.id, login: parsed.login, name });
}

export async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...GH_HEADERS(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.text();
  let parsed: { data?: T; errors?: unknown } | null = null;
  try {
    parsed = JSON.parse(body) as { data?: T; errors?: unknown };
  } catch {
    parsed = null;
  }
  if (!res.ok || !parsed || parsed.errors || parsed.data === undefined) {
    throw new Error(`${res.status} ${body.slice(0, 500)}`);
  }
  return parsed.data;
}

export function classifyRollup(state: string | null | undefined): RollupResult {
  if (state == null) return "no_rollup";
  if (GREEN[state]) return "green";
  if (PENDING[state]) return "pending";
  if (RED[state]) return "red";
  return "red";
}

export type CheckSnapshot = {
  name: string;
  workflow: string;
  event: string;
  result: RollupResult;
};

export function checkDisplayName(c: CheckSnapshot): string {
  if (c.workflow !== "" && c.event !== "") return `${c.workflow} / ${c.name} (${c.event})`;
  if (c.workflow !== "") return `${c.workflow} / ${c.name}`;
  return c.name;
}

export function isIgnoredCheck(c: CheckSnapshot, patterns: string[]): boolean {
  const fields = [checkDisplayName(c), c.name, c.workflow].filter((s) => s !== "");
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase();
    if (p === "") continue;
    for (const f of fields) {
      if (f.toLowerCase().includes(p)) return true;
    }
  }
  return false;
}

export function isIgnoredWorkflowRun(runName: string, patterns: string[]): boolean {
  const n = runName.trim().toLowerCase();
  if (n === "") return false;
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase();
    if (p === "") continue;
    if (n.includes(p)) return true;
    const workflow = p.split(" / ")[0] ?? "";
    if (workflow !== "" && workflow === n) return true;
  }
  return false;
}

export function classifyChecks(
  checks: CheckSnapshot[],
  ignoreChecks: string[],
): { result: RollupResult; ignored: string[] } {
  const ignored: string[] = [];
  const relevant: CheckSnapshot[] = [];
  for (const c of checks) {
    if (isIgnoredCheck(c, ignoreChecks)) ignored.push(checkDisplayName(c));
    else relevant.push(c);
  }
  if (relevant.length === 0) {
    return { result: checks.length === 0 ? "no_rollup" : "green", ignored };
  }
  let pending = false;
  for (const c of relevant) {
    if (c.result === "red") return { result: "red", ignored };
    if (c.result === "pending") pending = true;
  }
  return { result: pending ? "pending" : "green", ignored };
}

export function relevantRedNames(checks: CheckSnapshot[], ignoreChecks: string[]): string[] {
  const out: string[] = [];
  for (const c of checks) {
    if (c.result !== "red") continue;
    if (isIgnoredCheck(c, ignoreChecks)) continue;
    out.push(checkDisplayName(c));
  }
  return out;
}

function checkFromNode(node: unknown): CheckSnapshot | null {
  if (!node || typeof node !== "object") return null;
  if ("context" in node && typeof node.context === "string") {
    const state = "state" in node && typeof node.state === "string" ? node.state : null;
    if (node.context === "") return null;
    return { name: node.context, workflow: "", event: "", result: classifyRollup(state) };
  }
  const name = "name" in node && typeof node.name === "string" ? node.name : "";
  if (name === "") return null;
  const status = "status" in node && typeof node.status === "string" ? node.status : "";
  const conclusion = "conclusion" in node && typeof node.conclusion === "string" ? node.conclusion : null;
  let workflow = "";
  let event = "";
  if ("checkSuite" in node && node.checkSuite && typeof node.checkSuite === "object") {
    const suite = node.checkSuite;
    if ("workflowRun" in suite && suite.workflowRun && typeof suite.workflowRun === "object") {
      const wr = suite.workflowRun;
      if ("event" in wr && typeof wr.event === "string") event = wr.event;
      if ("workflow" in wr && wr.workflow && typeof wr.workflow === "object" && "name" in wr.workflow) {
        const wf = wr.workflow;
        if (typeof wf.name === "string") workflow = wf.name;
      }
    }
  }
  const result = status !== "" && status !== "COMPLETED" ? "pending" : classifyRollup(conclusion);
  return { name, workflow, event, result };
}

function checksFromRollup(rollup: unknown): CheckSnapshot[] {
  if (!rollup || typeof rollup !== "object" || !("contexts" in rollup)) return [];
  const contexts = rollup.contexts;
  if (!contexts || typeof contexts !== "object" || !("nodes" in contexts) || !Array.isArray(contexts.nodes)) {
    return [];
  }
  const out: CheckSnapshot[] = [];
  for (const node of contexts.nodes) {
    const c = checkFromNode(node);
    if (c) out.push(c);
  }
  return out;
}

type PollGql = {
  repository: {
    ref: {
      target: {
        oid?: string;
        statusCheckRollup?: { state?: string; contexts?: { nodes?: unknown[] } } | null;
      } | null;
    } | null;
  } | null;
};

export async function pollRepo(
  token: string,
  repo: RepoRef,
  ref: string,
  ignoreChecks: string[] = [],
): Promise<{ sha: string; result: RollupResult; ignored: string[]; red: string[] }> {
  const data = await graphql<PollGql>(token, POLL_QUERY, {
    owner: repo.owner,
    name: repo.name,
    qualifiedRef: `refs/heads/${ref}`,
  });
  const target = data.repository?.ref?.target;
  const oid = target?.oid;
  if (!data.repository?.ref || !oid) {
    throw new Error("missing repository.ref or oid");
  }
  const rollup = target?.statusCheckRollup;
  const checks = checksFromRollup(rollup);
  if (checks.length === 0) {
    return { sha: oid, result: classifyRollup(rollup?.state), ignored: [], red: [] };
  }
  const classified = classifyChecks(checks, ignoreChecks);
  return {
    sha: oid,
    result: classified.result,
    ignored: classified.ignored,
    red: relevantRedNames(checks, ignoreChecks),
  };
}

type ActionsRuns = {
  workflow_runs?: Array<{
    id: number;
    head_branch: string | null;
    updated_at: string;
    name?: string | null;
    display_title?: string | null;
  }>;
};

export async function fetchFailedJobLog(
  token: string,
  repo: RepoRef,
  ref: string,
  sha: string,
  logDir: string,
  ignoreChecks: string[] = [],
): Promise<{ runId: number | null; logPath: string | null }> {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/runs?head_sha=${encodeURIComponent(sha)}&status=failure&per_page=10`;
  const res = await fetch(url, { headers: GH_HEADERS(token) });
  if (!res.ok) return { runId: null, logPath: null };
  const json = (await res.json()) as ActionsRuns;
  const runs = json.workflow_runs ?? [];
  let matched = runs.filter((r) => r.head_branch === ref);
  if (matched.length === 0) matched = runs;
  if (ignoreChecks.length > 0) {
    matched = matched.filter((r) => {
      if (isIgnoredWorkflowRun(r.name ?? "", ignoreChecks)) return false;
      const title = r.display_title ?? "";
      if (title !== "" && isIgnoredCheck({ name: title, workflow: "", event: "", result: "red" }, ignoreChecks)) {
        return false;
      }
      return true;
    });
  }
  if (matched.length === 0) return { runId: null, logPath: null };
  let best = matched[0];
  for (const r of matched) {
    if (r.updated_at > best.updated_at) best = r;
  }
  const runId = best.id;
  const proc = Bun.spawn(
    ["gh", "run", "view", String(runId), "--repo", `${repo.owner}/${repo.name}`, "--log-failed"],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const stdout = await new Response(proc.stdout).bytes();
  await proc.exited;
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${repo.owner}__${repo.name}__${sha}.log`);
  const sliced = stdout.length > 1_000_000 ? stdout.slice(stdout.length - 1_000_000) : stdout;
  writeFileSync(logPath, sliced);
  const redacted = redactSecrets(readFileSync(logPath, "utf8"));
  writeFileSync(logPath, redacted);
  return { runId, logPath };
}
