import { expect, test } from "bun:test";
import { extractOmpSessionId, postLandAction, resolveWorktree } from "./session";

const original = ["Build, verify, and deploy / Tested image (ogc-trialtool-functionapp)"];
const next = ["Build, verify, and deploy / Publish and deploy TrialTool web to DEV / Publish tested image and deploy"];

test("green after land → landed", () => {
  expect(
    postLandAction({ result: "green", originalRed: original, currentRed: [], iteration: 1, maxIterations: 3 }),
  ).toBe("landed");
});

test("extractOmpSessionId from jsonl session frame", () => {
  const jsonl = [
    JSON.stringify({ type: "session", version: 3, id: "01abc-session" }),
    JSON.stringify({ type: "agent_start" }),
  ].join("\n");
  expect(extractOmpSessionId(jsonl)).toBe("01abc-session");
});

test("pending keeps watching", () => {
  expect(
    postLandAction({ result: "pending", originalRed: original, currentRed: [], iteration: 1, maxIterations: 3 }),
  ).toBe("watch");
});

test("original failure still red → iterate (keep land)", () => {
  expect(
    postLandAction({
      result: "red",
      originalRed: original,
      currentRed: original,
      iteration: 1,
      maxIterations: 3,
    }),
  ).toBe("iterate");
});

test("new failure after original is gone → iterate", () => {
  expect(
    postLandAction({
      result: "red",
      originalRed: original,
      currentRed: next,
      iteration: 1,
      maxIterations: 3,
    }),
  ).toBe("iterate");
});

test("still red at max iterations → stop (keep land)", () => {
  expect(
    postLandAction({
      result: "red",
      originalRed: original,
      currentRed: original,
      iteration: 3,
      maxIterations: 3,
    }),
  ).toBe("stop");
});

test("unknown original reds → revert", () => {
  expect(
    postLandAction({ result: "red", originalRed: [], currentRed: next, iteration: 1, maxIterations: 3 }),
  ).toBe("revert");
});

test("first pass worktree is sha-keyed", () => {
  expect(
    resolveWorktree({
      workDir: "data/work",
      repo: { owner: "EEOC", name: "TrialTool" },
      sha: "195b088b32bd",
    }),
  ).toEqual({ work: "data/work/EEOC/TrialTool/195b088b32bd", reuse: false });
});

test("follow-up reuses previous worktree not the new sha path", () => {
  expect(
    resolveWorktree({
      workDir: "data/work",
      repo: { owner: "EEOC", name: "TrialTool" },
      sha: "215d825a4af3",
      previousWork: "data/work/EEOC/TrialTool/195b088b32bd",
    }),
  ).toEqual({ work: "data/work/EEOC/TrialTool/195b088b32bd", reuse: true });
});

test("empty previousWork clones a new sha worktree", () => {
  expect(
    resolveWorktree({
      workDir: "data/work",
      repo: { owner: "EEOC", name: "TrialTool" },
      sha: "215d825a4af3",
      previousWork: "  ",
    }),
  ).toEqual({ work: "data/work/EEOC/TrialTool/215d825a4af3", reuse: false });
});
