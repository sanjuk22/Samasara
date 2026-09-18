export type AnticheatVerdict = { ok: true } | { ok: false; rule: string; detail: string };

const SECRET_RES = [
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxai-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SKIP_RE = /describe\.skip|context\.skip|it\.skip|test\.skip|\bxit\b|\bxdescribe\b|\.only\(/;
const WEAKEN_RE = /continue-on-error:\s*true\b|\|\|\s*true\b|if:\s*false\b|exit\s+0\b/;
const TIMEOUT_RE = /timeout|retries|maxAttempts|sleep\(/i;
const TEST_PATH_RE = /\.(test|spec)\./;
const TEST_DIR_RE = /\/(tests|__tests__|spec)\//;

function hasSecret(text: string): boolean {
  for (const re of SECRET_RES) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

function isContentLine(line: string): boolean {
  if (line.startsWith("+++") || line.startsWith("---")) return false;
  if (line.startsWith("@@") || line.startsWith("diff ")) return false;
  return line.startsWith("+") || line.startsWith("-");
}

function parseGitPaths(line: string): { a: string; b: string } | null {
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice("diff --git ".length);
  const bAt = rest.lastIndexOf(" b/");
  if (bAt < 0 || !rest.startsWith("a/")) return null;
  return { a: rest.slice(2, bAt), b: rest.slice(bAt + 3) };
}

export function checkDiff(diff: string): AnticheatVerdict {
  if (diff.trim() === "") return { ok: false, rule: "empty", detail: "no diff" };

  if (hasSecret(diff)) return { ok: false, rule: "secret", detail: "secret pattern in diff" };

  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++") && SKIP_RE.test(line)) {
      return { ok: false, rule: "skip-test", detail: line.slice(0, 200) };
    }
  }

  type FileHunk = {
    a: string;
    b: string;
    deleted: boolean;
    newFile: boolean;
    added: string[];
  };
  const files: FileHunk[] = [];
  let current: FileHunk | null = null;
  const pm: string[] = [];

  for (const line of lines) {
    const paths = parseGitPaths(line);
    if (paths) {
      current = {
        a: paths.a,
        b: paths.b,
        deleted: paths.b === "/dev/null",
        newFile: paths.a === "/dev/null",
        added: [],
      };
      files.push(current);
      continue;
    }
    if (current) {
      if (line.startsWith("deleted file mode") || line === "+++ /dev/null") current.deleted = true;
      if (line.startsWith("new file mode") || line === "--- /dev/null") current.newFile = true;
      if (line.startsWith("+") && !line.startsWith("+++")) current.added.push(line);
    }
    if (isContentLine(line)) pm.push(line);
  }

  const workflowPath = (p: string) => p === ".github/workflows" || p.startsWith(".github/workflows/");

  for (const f of files) {
    if (!(workflowPath(f.a) || workflowPath(f.b))) continue;
    for (const added of f.added) {
      if (WEAKEN_RE.test(added)) {
        return { ok: false, rule: "weaken-ci", detail: added.slice(0, 200) };
      }
    }
  }

  for (const f of files) {
    if (f.deleted && (workflowPath(f.a) || workflowPath(f.b))) {
      return { ok: false, rule: "delete-workflow", detail: f.a || f.b };
    }
  }

  if (pm.length > 0 && pm.every((line) => TIMEOUT_RE.test(line))) {
    return { ok: false, rule: "timeout-only", detail: "timeout/retry-only diff" };
  }

  const anyNew = files.some((f) => f.newFile);
  for (const f of files) {
    if (!f.deleted) continue;
    const path = f.a || f.b;
    if (TEST_PATH_RE.test(path) || TEST_DIR_RE.test(path)) {
      if (!anyNew) return { ok: false, rule: "delete-test", detail: path };
    }
  }

  return { ok: true };
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_RES) {
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}
