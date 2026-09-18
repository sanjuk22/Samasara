import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  addRepoIgnore,
  addTrackedRepo,
  ConfigConflictError,
  editConfigFile,
  parseRepoSpec,
  readRepoConfig,
  removeRepoIgnore,
  removeTrackedRepo,
  reposFromFile,
  setRepoIgnores,
} from "./config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configFile(bytes = '{"repos":[]}\n'): string {
  const root = mkdtempSync(join(tmpdir(), "samasara-config-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(path, bytes);
  return path;
}

test("parseRepoSpec owner/name", () => {
  expect(parseRepoSpec("acme/app")).toEqual({ owner: "acme", name: "app" });
});

test("parseRepoSpec rejects placeholder", () => {
  expect(() => parseRepoSpec("OWNER/REPO")).toThrow();
});

test("add/list/remove tracked repos", () => {
  const obj: Record<string, unknown> = { repos: [{ owner: "OWNER", name: "REPO" }] };
  addTrackedRepo(obj, "Acme/App");
  expect(reposFromFile(obj)).toEqual([{ owner: "Acme", name: "App" }]);
  expect(() => addTrackedRepo(obj, "acme/app")).toThrow();
  expect(removeTrackedRepo(obj, "ACME/APP")).toEqual({ owner: "Acme", name: "App" });
  expect(reposFromFile(obj)).toEqual([]);
});

test("per-repo ignore add and remove", () => {
  const obj: Record<string, unknown> = { repos: [] };
  addTrackedRepo(obj, "acme/app");
  addRepoIgnore(obj, "acme/app", "CI-BlackDuck-SCA-Basic / build (push)");
  expect(reposFromFile(obj)[0]?.ignoreChecks).toEqual(["CI-BlackDuck-SCA-Basic / build (push)"]);
  removeRepoIgnore(obj, "acme/app", "CI-BlackDuck-SCA-Basic / build (push)");
  expect(reposFromFile(obj)[0]?.ignoreChecks).toBeUndefined();
});

test("repo updates preserve private settings without exposing them", () => {
  const secret = "fixture-password";
  const bytes = JSON.stringify({ repos: [{ owner: "Acme", name: "App" }], smtp: { password: secret }, custom: { enabled: true } });
  const path = configFile(bytes);
  const before = readRepoConfig(path);
  expect(before.revision).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(JSON.stringify(before)).not.toContain(secret);
  expect(before).not.toHaveProperty("smtp");
  expect(before).not.toHaveProperty("custom");

  const result = editConfigFile((obj) => setRepoIgnores(obj, "acme/app", [" Build ", "build", "", "SECURITY"]), {
    path,
    revision: before.revision,
  });
  expect(result.repos).toEqual([{ owner: "Acme", name: "App", ignoreChecks: ["Build", "SECURITY"] }]);
  expect(JSON.stringify(result)).not.toContain(secret);
  const saved = readFileSync(path);
  expect(JSON.parse(saved.toString())).toEqual({
    repos: result.repos,
    smtp: { password: secret },
    custom: { enabled: true },
  });
  expect(result.revision).toBe(createHash("sha256").update(saved).digest("hex"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(dirname(path))).toEqual(["config.json"]);

  editConfigFile((obj) => setRepoIgnores(obj, "ACME/APP", []), { path, revision: result.revision });
  expect(readRepoConfig(path).repos).toEqual([{ owner: "Acme", name: "App" }]);
});

test("stale revisions cannot overwrite either repo edits or byte-only config changes", () => {
  const path = configFile();
  const first = readRepoConfig(path);
  const second = editConfigFile((obj) => addTrackedRepo(obj, "acme/one"), { path, revision: first.revision });
  let called = false;
  expect(() => editConfigFile(() => { called = true; }, { path, revision: first.revision })).toThrow(ConfigConflictError);
  expect(called).toBe(false);
  expect(readRepoConfig(path)).toEqual(second);
  expect(existsSync(`${path}.lock`)).toBe(false);

  const changed = `${readFileSync(path, "utf8")}\n`;
  writeFileSync(path, changed);
  expect(() => editConfigFile((obj) => addTrackedRepo(obj, "acme/two"), { path, revision: second.revision })).toThrow(ConfigConflictError);
  expect(readFileSync(path, "utf8")).toBe(changed);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("exclusive config lock also protects symlink callers without removing another edit's lock", () => {
  const path = configFile();
  const alias = join(dirname(path), "alias.json");
  symlinkSync(path, alias);
  editConfigFile((obj) => {
    expect(existsSync(`${path}.lock`)).toBe(true);
    expect(() => editConfigFile((other) => addTrackedRepo(other, "acme/loser"), { path: alias })).toThrow(ConfigConflictError);
    expect(existsSync(`${path}.lock`)).toBe(true);
    addTrackedRepo(obj, "Acme/Winner");
  }, { path });
  expect(readRepoConfig(alias).repos).toEqual([{ owner: "Acme", name: "Winner" }]);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("aborted and unserializable edits leave original bytes and release their lock", () => {
  const path = configFile();
  const original = readFileSync(path, "utf8");
  expect(() => editConfigFile((obj) => {
    addTrackedRepo(obj, "acme/aborted");
    throw new Error("abort");
  }, { path })).toThrow();
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(readdirSync(dirname(path))).toEqual(["config.json"]);

  expect(() => editConfigFile((obj) => { obj.circular = obj; }, { path })).toThrow();
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(readdirSync(dirname(path))).toEqual(["config.json"]);
  editConfigFile((obj) => addTrackedRepo(obj, "acme/committed"), { path });
  expect(readRepoConfig(path).repos).toEqual([{ owner: "acme", name: "committed" }]);
});

test("repo mutations reject traversal, encoded separators, and invalid GitHub identifiers", () => {
  const path = configFile();
  const original = readFileSync(path, "utf8");
  for (const spec of ["../app", "acme/..", "acme/a/b", "acme/%2fetc", "acme\\team/app", "-acme/app", "acme--team/app", "acme/a b", `${"a".repeat(40)}/app`, `acme/${"a".repeat(101)}`]) {
    expect(() => editConfigFile((obj) => addTrackedRepo(obj, spec), { path })).toThrow();
  }
  expect(() => editConfigFile((obj) => { obj.repos = [{ owner: "acme", name: "../escape" }]; }, { path })).toThrow();
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(readdirSync(dirname(path))).toEqual(["config.json"]);
});

test("invalid JSON errors do not disclose config credentials and release the edit lock", () => {
  const secret = "fixture-secret-credential";
  const path = configFile(`{"smtp":{"password":"${secret}"},`);
  let caught: unknown;
  try {
    editConfigFile(() => {}, { path });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).not.toContain(secret);
  expect(readdirSync(dirname(path))).toEqual(["config.json"]);
});
