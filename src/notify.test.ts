import { expect, test } from "bun:test";
import { buildNotifyMail, needsHumanNotify } from "./notify";

test("needs human on gave_up not landed", () => {
  expect(needsHumanNotify({ outcome: "gave_up" })).toBe(true);
  expect(needsHumanNotify({ outcome: "not_reproduced" })).toBe(true);
  expect(needsHumanNotify({ outcome: "denied_policy" })).toBe(true);
  expect(needsHumanNotify({ outcome: "landed" })).toBe(false);
  expect(needsHumanNotify({ outcome: "follow_up" })).toBe(false);
  expect(needsHumanNotify({ outcome: "gave_up", error: "dryRun" })).toBe(false);
});

test("notify mail names repo outcome and telemetry hint", () => {
  const mail = buildNotifyMail({
    to: "nathaniel.xu@eeoc.gov",
    repo: "acme/app",
    sessionId: 7,
    sha: "abc123",
    fields: { outcome: "not_reproduced", error: "no diff" },
    events: [{ event: "lock_acquired", payload_json: "{\"sha\":\"abc123\"}" }],
  });
  expect(mail.to).toBe("nathaniel.xu@eeoc.gov");
  expect(mail.subject).toBe("Samasara needs you: acme/app [not_reproduced]");
  expect(mail.body).toContain("Outcome: not_reproduced");
  expect(mail.body).toContain("https://github.com/acme/app/commit/abc123");
  expect(mail.body).toContain("bun src/index.ts telemetry 7");
  expect(mail.body).toContain("lock_acquired");
});
