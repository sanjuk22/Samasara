import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type RepoRef = { owner: string; name: string; ignoreChecks?: string[] };

export type RepoConfig = { repos: RepoRef[]; ignoreChecks: string[]; revision: string };

export class ConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigConflictError";
  }
}

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
};

export type Config = {
  pollIntervalSeconds: number;
  maxSessionMinutes: number;
  maxHealIterations: number;
  postLandWatchSeconds: number;
  postLandPollSeconds: number;
  maxLandsPerRepoPerUtcDay: number;
  revertCooldownHours: number;
  dryRun: boolean;
  workDir: string;
  dbPath: string;
  logDir: string;
  ref: string;
  ignoreChecks: string[];
  notifyEmail: string;
  smtp: SmtpConfig | null;
  gitName: string;
  gitEmail: string;
  repos: RepoRef[];
};

const DEFAULTS = {
  pollIntervalSeconds: 900,
  maxSessionMinutes: 60,
  maxHealIterations: 3,
  postLandWatchSeconds: 1200,
  postLandPollSeconds: 60,
  maxLandsPerRepoPerUtcDay: 8,
  revertCooldownHours: 6,
  dryRun: false,
  workDir: "data/work",
  dbPath: "data/samasara.sqlite",
  logDir: "data/logs",
  ref: "main",
  ignoreChecks: [] as string[],
} as const;

export function repoKey(r: RepoRef): string {
  return `${r.owner}/${r.name}`;
}

export function ignoreChecksFor(config: Config, repo: RepoRef): string[] {
  const out: string[] = [];
  const seen: Record<string, true> = {};
  for (const p of [...config.ignoreChecks, ...(repo.ignoreChecks ?? [])]) {
    const t = p.trim();
    if (t === "" || seen[t]) continue;
    seen[t] = true;
    out.push(t);
  }
  return out;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function absCwd(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

export function loadConfig(path?: string): Config {
  const { obj } = readConfigFile(path);
  if (!Array.isArray(obj.repos)) throw new Error("repos is empty");
  const repos = reposFromFile(obj);
  return {
    pollIntervalSeconds: num(obj.pollIntervalSeconds, DEFAULTS.pollIntervalSeconds),
    maxSessionMinutes: num(obj.maxSessionMinutes, DEFAULTS.maxSessionMinutes),
    maxHealIterations: Math.max(1, Math.floor(num(obj.maxHealIterations, DEFAULTS.maxHealIterations))),
    postLandWatchSeconds: num(obj.postLandWatchSeconds, DEFAULTS.postLandWatchSeconds),
    postLandPollSeconds: num(obj.postLandPollSeconds, DEFAULTS.postLandPollSeconds),
    maxLandsPerRepoPerUtcDay: num(obj.maxLandsPerRepoPerUtcDay, DEFAULTS.maxLandsPerRepoPerUtcDay),
    revertCooldownHours: num(obj.revertCooldownHours, DEFAULTS.revertCooldownHours),
    dryRun: typeof obj.dryRun === "boolean" ? obj.dryRun : DEFAULTS.dryRun,
    workDir: absCwd(typeof obj.workDir === "string" ? obj.workDir : DEFAULTS.workDir),
    dbPath: absCwd(typeof obj.dbPath === "string" ? obj.dbPath : DEFAULTS.dbPath),
    logDir: absCwd(typeof obj.logDir === "string" ? obj.logDir : DEFAULTS.logDir),
    ref: typeof obj.ref === "string" && obj.ref ? obj.ref : DEFAULTS.ref,
    ignoreChecks: stringList(obj.ignoreChecks),
    notifyEmail: typeof obj.notifyEmail === "string" ? obj.notifyEmail.trim() : "",
    smtp: parseSmtp(obj.smtp),
    gitName: typeof obj.gitName === "string" ? obj.gitName.trim() : "",
    gitEmail: typeof obj.gitEmail === "string" ? obj.gitEmail.trim() : "",
    repos,
  };
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const pattern = x.trim();
    const key = pattern.toLowerCase();
    if (!pattern || seen.has(key)) continue;
    seen.add(key);
    out.push(pattern);
  }
  return out;
}

function parseSmtp(v: unknown): SmtpConfig | null {
  if (!v || typeof v !== "object") return null;
  const host = "host" in v && typeof v.host === "string" ? v.host.trim() : "";
  const from = "from" in v && typeof v.from === "string" ? v.from.trim() : "";
  if (host === "" || from === "") return null;
  const port = "port" in v && typeof v.port === "number" && Number.isFinite(v.port) ? v.port : 587;
  const user = "user" in v && typeof v.user === "string" ? v.user : "";
  const password = "password" in v && typeof v.password === "string" ? v.password : "";
  return { host, port, user, password, from };
}

export function configFilePath(path?: string): string {
  return path ?? process.env.SAMASARA_CONFIG ?? join(process.cwd(), "config.json");
}

export function parseRepoSpec(spec: string): RepoRef {
  if (typeof spec !== "string") throw new Error("expected owner/name");
  const parts = spec.split("/");
  if (parts.length !== 2) throw new Error("expected owner/name");
  const owner = parts[0].trim();
  const name = parts[1].trim();
  if (
    !/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i.test(owner) ||
    !/^[a-z0-9_.-]{1,100}$/i.test(name) ||
    name === "." ||
    name === ".." ||
    owner === "OWNER" ||
    name === "REPO"
  ) {
    throw new Error("invalid repo owner/name");
  }
  return { owner, name };
}

function readConfigContents(path?: string): { path: string; obj: Record<string, unknown>; bytes: Uint8Array } {
  const file = configFilePath(path);
  if (!existsSync(file)) {
    throw new Error("config.json not found; copy config.example.json to config.json and set repos");
  }
  const bytes = readFileSync(file);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    // JSON parser errors can contain config values, including credentials.
    throw new Error("invalid config.json");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invalid config.json");
  }
  return { path: file, obj: raw as Record<string, unknown>, bytes };
}

export function readConfigFile(path?: string): { path: string; obj: Record<string, unknown> } {
  const { path: file, obj } = readConfigContents(path);
  return { path: file, obj };
}

function configRevision(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function repoConfig(obj: Record<string, unknown>, revision: string): RepoConfig {
  return { repos: reposFromFile(obj), ignoreChecks: stringList(obj.ignoreChecks), revision };
}

export function readRepoConfig(path?: string): RepoConfig {
  const { obj, bytes } = readConfigContents(path);
  return repoConfig(obj, configRevision(bytes));
}

function withConfigLock<T>(path: string, change: (file: string) => T): T {
  const file = existsSync(path) ? realpathSync(path) : resolve(path);
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConfigConflictError("config is being edited; refresh and try again");
    }
    throw error;
  }
  try {
    closeSync(fd);
    return change(file);
  } finally {
    rmSync(lock, { force: true });
  }
}

function writeConfigBytes(file: string, bytes: string): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temp, "wx", 0o600);
    created = true;
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    created = false;
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      if (created) rmSync(temp, { force: true });
    }
  }
}

export function editConfigFile(
  change: (obj: Record<string, unknown>) => void,
  opts?: { path?: string; revision?: string },
): RepoConfig {
  return withConfigLock(configFilePath(opts?.path), (file) => {
    const { obj, bytes: original } = readConfigContents(file);
    if (opts?.revision !== undefined && opts.revision !== configRevision(original)) {
      throw new ConfigConflictError("config has changed; refresh and try again");
    }
    change(obj);
    const result = repoConfig(obj, "");
    const bytes = `${JSON.stringify(obj, null, 2)}\n`;
    result.revision = configRevision(bytes);
    writeConfigBytes(file, bytes);
    return result;
  });
}

export function reposFromFile(obj: Record<string, unknown>): RepoRef[] {
  if (!Array.isArray(obj.repos)) return [];
  const repos: RepoRef[] = [];
  const seen = new Set<string>();
  for (const entry of obj.repos) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("invalid repo");
    const rec = entry as Record<string, unknown>;
    if (rec.owner === "OWNER" && rec.name === "REPO") continue;
    if (typeof rec.owner !== "string" || typeof rec.name !== "string") throw new Error("invalid repo owner/name");
    const repo = parseRepoSpec(`${rec.owner}/${rec.name}`);
    const key = repoKey(repo).toLowerCase();
    if (seen.has(key)) throw new Error(`${repoKey(repo)} already tracked`);
    seen.add(key);
    const ign = stringList(rec.ignoreChecks);
    if (ign.length > 0) repo.ignoreChecks = ign;
    repos.push(repo);
  }
  return repos;
}

function writeRepos(obj: Record<string, unknown>, repos: RepoRef[]): void {
  obj.repos = repos.map((r) => {
    if (r.ignoreChecks && r.ignoreChecks.length > 0) {
      return { owner: r.owner, name: r.name, ignoreChecks: r.ignoreChecks };
    }
    return { owner: r.owner, name: r.name };
  });
}

export function addTrackedRepo(obj: Record<string, unknown>, spec: string): RepoRef {
  const repo = parseRepoSpec(spec);
  const repos = reposFromFile(obj);
  if (repos.some((r) => repoKey(r).toLowerCase() === repoKey(repo).toLowerCase())) {
    throw new Error(`${repoKey(repo)} already tracked`);
  }
  repos.push(repo);
  writeRepos(obj, repos);
  return repo;
}

export function removeTrackedRepo(obj: Record<string, unknown>, spec: string): RepoRef {
  const found = trackedIndex(obj, spec);
  found.repos.splice(found.i, 1);
  writeRepos(obj, found.repos);
  return found.repo;
}

function trackedIndex(obj: Record<string, unknown>, spec: string): { repos: RepoRef[]; i: number; repo: RepoRef } {
  const want = parseRepoSpec(spec);
  const repos = reposFromFile(obj);
  const i = repos.findIndex((r) => repoKey(r).toLowerCase() === repoKey(want).toLowerCase());
  if (i < 0) throw new Error(`${repoKey(want)} not tracked`);
  return { repos, i, repo: repos[i] };
}

export function setRepoIgnores(obj: Record<string, unknown>, spec: string, patterns: string[]): void {
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) {
    throw new Error("ignore patterns must be strings");
  }
  const found = trackedIndex(obj, spec);
  const ignoreChecks = stringList(patterns);
  if (ignoreChecks.length > 0) found.repo.ignoreChecks = ignoreChecks;
  else delete found.repo.ignoreChecks;
  writeRepos(obj, found.repos);
}

export function addRepoIgnore(obj: Record<string, unknown>, spec: string, pattern: string): void {
  const p = pattern.trim();
  if (p === "") throw new Error("empty ignore pattern");
  const found = trackedIndex(obj, spec);
  const ign = found.repo.ignoreChecks ?? [];
  if (!ign.some((x) => x.toLowerCase() === p.toLowerCase())) ign.push(p);
  found.repos[found.i] = { owner: found.repo.owner, name: found.repo.name, ignoreChecks: ign };
  writeRepos(obj, found.repos);
}

export function removeRepoIgnore(obj: Record<string, unknown>, spec: string, pattern: string): void {
  const p = pattern.trim();
  const found = trackedIndex(obj, spec);
  const prev = found.repo.ignoreChecks ?? [];
  const ign = prev.filter((x) => x.toLowerCase() !== p.toLowerCase());
  if (ign.length === prev.length) throw new Error("pattern not found");
  found.repos[found.i] =
    ign.length > 0
      ? { owner: found.repo.owner, name: found.repo.name, ignoreChecks: ign }
      : { owner: found.repo.owner, name: found.repo.name };
  writeRepos(obj, found.repos);
}
