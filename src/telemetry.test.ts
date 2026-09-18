import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { EventRow, SessionRow } from "./db";
import {
  buildPriorHealContext,
  extractOmpPatch,
  extractOmpReasoning,
  formatHealReport,
  formatPriorHealContext,
  reportFromSession,
} from "./telemetry";

function session(over: Partial<SessionRow>): SessionRow {
  return {
    id: 2,
    repo: "acme/app",
    ref: "main",
    start_sha: "aaaaaaaaaaaa",
    end_sha: "bbbbbbbbbbbb",
    started_at: 1,
    ended_at: 2,
    outcome: "landed",
    failure_class: null,
    reproduced: 1,
    oracle_json: null,
    files_json: '["add.js"]',
    attempts: 1,
    tokens_in: 0,
    tokens_out: 0,
    sandbox_s: 1,
    error: null,
    ...over,
  };
}

function ev(event: string, payload: unknown): EventRow {
  return { id: 1, session_id: 2, at: 1, event, payload_json: JSON.stringify(payload) };
}

test("extract last assistant text as reasoning", () => {
  const jsonl = [
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "scratch" }] },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Reproduced yes. Root cause: add subtracted." }],
      },
    }),
  ].join("\n");
  expect(extractOmpReasoning(jsonl)).toBe("Reproduced yes. Root cause: add subtracted.");
});

test("extractOmpPatch from edit tool_execution_end", () => {
  const jsonl = JSON.stringify({
    type: "tool_execution_end",
    toolName: "edit",
    result: { details: { path: "add.js", diff: "-  return a - b;\n+  return a + b;" } },
  });
  expect(extractOmpPatch(jsonl)).toBe("--- add.js\n-  return a - b;\n+  return a + b;");
});

test("landed green reports accepted and worked", () => {
  const r = reportFromSession({
    session: session({}),
    events: [
      ev("patch_proposed", { files: ["add.js"], diff: "diff --git a/add.js b/add.js\n+return a+b" }),
      ev("anticheat", { pass: true }),
      ev("pushed", { from_sha: "aa", to_sha: "bb" }),
      ev("post_land_poll", { state: "green" }),
      ev("reasoning", { text: "Reproduced yes." }),
    ],
  });
  expect(r.accepted).toBe("yes (pushed)");
  expect(r.worked).toBe("yes (main green)");
  expect(r.patch).toContain("+return a+b");
  expect(r.reasoning).toBe("Reproduced yes.");
  expect(formatHealReport(r, { fullPatch: false })).toContain("accepted: yes (pushed)");
});

test("denied_policy is not accepted", () => {
  const r = reportFromSession({
    session: session({ outcome: "denied_policy", failure_class: "skip-test", end_sha: null }),
    events: [
      ev("patch_proposed", { files: ["foo.test.ts"], diff: "+it.skip" }),
      ev("anticheat", { pass: false, rule: "skip-test" }),
    ],
  });
  expect(r.accepted).toBe("no (anticheat: skip-test)");
  expect(r.worked).toBe("n/a");
});

test("reverted means patch did not work", () => {
  const r = reportFromSession({
    session: session({ outcome: "reverted" }),
    events: [
      ev("patch_proposed", { files: ["add.js"], diff: "x" }),
      ev("anticheat", { pass: true }),
      ev("pushed", {}),
      ev("post_land_poll", { state: "red" }),
    ],
  });
  expect(r.accepted).toBe("yes (pushed)");
  expect(r.worked).toBe("no (reverted)");
});

test("prior heal context tells the healer to check accepted patches for regressions", () => {
  const context = formatPriorHealContext("acme/app", [
    {
      sessionId: 7,
      repo: "acme/app",
      sha: "cccccccccccc",
      outcome: "landed",
      files: ["Dockerfile"],
      patch: "-authlib==1.6.5\n+authlib==1.6.9",
      accepted: "yes (pushed)",
      worked: "yes (main green)",
      reasoning: "Reproduced yes. The vulnerable dependency was pinned.",
    },
  ]);

  expect(context).toContain("A normal commit or merge can reintroduce a failure");
  expect(context).toContain("session 7 acme/app cccccccccccc landed");
  expect(context).toContain("+authlib==1.6.9");
});

test("build prior heal context includes only earlier pushed, non-reverted sessions for the repo", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY, repo TEXT, ref TEXT, start_sha TEXT, end_sha TEXT,
      started_at INTEGER, ended_at INTEGER, outcome TEXT, failure_class TEXT,
      reproduced INTEGER, oracle_json TEXT, files_json TEXT, attempts INTEGER,
      tokens_in INTEGER, tokens_out INTEGER, sandbox_s INTEGER, error TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, session_id INTEGER, at INTEGER, event TEXT, payload_json TEXT
    );
  `);
  const insertSession = db.prepare(
    "INSERT INTO sessions VALUES (?, ?, 'main', ?, ?, 1, 2, ?, NULL, 1, NULL, ?, 1, 0, 0, 1, NULL)",
  );
  insertSession.run(1, "acme/app", "aaaaaaaaaaaa", "bbbbbbbbbbbb", "landed", '["fixed.ts"]');
  insertSession.run(2, "acme/app", "bbbbbbbbbbbb", "aaaaaaaaaaaa", "reverted", '["bad.ts"]');
  insertSession.run(3, "other/app", "dddddddddddd", "eeeeeeeeeeee", "landed", '["other.ts"]');
  db.prepare("INSERT INTO events VALUES (?, ?, 1, ?, ?)").run(1, 1, "pushed", "{}");
  db.prepare("INSERT INTO events VALUES (?, ?, 1, ?, ?)").run(
    2,
    1,
    "patch_proposed",
    JSON.stringify({ files: ["fixed.ts"], diff: "+fixed" }),
  );
  db.prepare("INSERT INTO events VALUES (?, ?, 1, ?, ?)").run(3, 2, "pushed", "{}");
  db.prepare("INSERT INTO events VALUES (?, ?, 1, ?, ?)").run(4, 3, "pushed", "{}");

  const context = buildPriorHealContext(db, "acme/app", 4);
  expect(context).toContain("session 1 acme/app aaaaaaaaaaaa landed");
  expect(context).toContain("+fixed");
  expect(context).not.toContain("bad.ts");
  expect(context).not.toContain("other.ts");
  db.close();
});
