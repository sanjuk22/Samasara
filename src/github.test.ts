import { expect, test } from "bun:test";
import {
  classifyChecks,
  classifyRollup,
  gitIdentityFromUser,
  isIgnoredCheck,
  isIgnoredWorkflowRun,
  relevantRedNames,
  type CheckSnapshot,
} from "./github";

test("SUCCESS → green", () => {
  expect(classifyRollup("SUCCESS")).toBe("green");
});

test("FAILURE → red", () => {
  expect(classifyRollup("FAILURE")).toBe("red");
});

test("PENDING → pending", () => {
  expect(classifyRollup("PENDING")).toBe("pending");
});

test("null → no_rollup", () => {
  expect(classifyRollup(null)).toBe("no_rollup");
});

test("TIMED_OUT → red", () => {
  expect(classifyRollup("TIMED_OUT")).toBe("red");
});

test('unknown "WAT" → red', () => {
  expect(classifyRollup("WAT")).toBe("red");
});

test("git identity uses profile name and noreply email", () => {
  expect(gitIdentityFromUser({ id: 47922161, login: "Nathaniel-Xu", name: "Nathaniel Xu" })).toEqual({
    name: "Nathaniel Xu",
    email: "47922161+Nathaniel-Xu@users.noreply.github.com",
  });
});

test("git identity falls back to login when name missing", () => {
  expect(gitIdentityFromUser({ id: 1, login: "octocat", name: null })).toEqual({
    name: "octocat",
    email: "1+octocat@users.noreply.github.com",
  });
});

const blackDuck: CheckSnapshot = {
  name: "build",
  workflow: "CI-BlackDuck-SCA-Basic",
  event: "push",
  result: "red",
};
const unit: CheckSnapshot = {
  name: "test",
  workflow: "ci",
  event: "push",
  result: "green",
};

test("ignore BlackDuck UI title", () => {
  expect(isIgnoredCheck(blackDuck, ["CI-BlackDuck-SCA-Basic / build (push)"])).toBe(true);
  expect(isIgnoredCheck(unit, ["CI-BlackDuck-SCA-Basic / build (push)"])).toBe(false);
});

test("ignored BlackDuck with green tests → green", () => {
  expect(classifyChecks([blackDuck, unit], ["CI-BlackDuck-SCA-Basic"]).result).toBe("green");
});

test("ignored BlackDuck with red tests → red", () => {
  const failed = { ...unit, result: "red" as const };
  expect(classifyChecks([blackDuck, failed], ["CI-BlackDuck-SCA-Basic"]).result).toBe("red");
});

test("only ignored failures → green", () => {
  expect(classifyChecks([blackDuck], ["CI-BlackDuck-SCA-Basic"]).result).toBe("green");
});

test("no ignore keeps BlackDuck red", () => {
  expect(classifyChecks([blackDuck, unit], []).result).toBe("red");
});

test("ignored red with pending relevant → pending", () => {
  const pending = { ...unit, result: "pending" as const };
  expect(classifyChecks([blackDuck, pending], ["BlackDuck"]).result).toBe("pending");
});

test("relevantRedNames drops ignored checks", () => {
  const failed = { ...unit, result: "red" as const };
  expect(relevantRedNames([blackDuck, failed], ["BlackDuck"])).toEqual(["ci / test (push)"]);
});

test("UI-title ignoreChecks skips BlackDuck Actions run name", () => {
  const ignore = ["CI-BlackDuck-SCA-Basic / build (push)"];
  expect(isIgnoredWorkflowRun("CI-BlackDuck-SCA-Basic", ignore)).toBe(true);
  expect(isIgnoredWorkflowRun("Build, verify, and deploy", ignore)).toBe(false);
});

test("short ignoreChecks still skips BlackDuck run name", () => {
  expect(isIgnoredWorkflowRun("CI-BlackDuck-SCA-Basic", ["CI-BlackDuck-SCA-Basic"])).toBe(true);
});
