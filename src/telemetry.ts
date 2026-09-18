import type { Database } from "bun:sqlite";
import { eventsForSession, priorPushedSessions, type EventRow, type SessionRow } from "./db";

export type HealReport = {
  sessionId: number;
  repo: string;
  sha: string;
  outcome: string;
  files: string[];
  patch: string | null;
  accepted: string;
  worked: string;
  reasoning: string | null;
};

export function extractOmpReasoning(jsonl: string): string | null {
  let last: string | null = null;
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    if (!("type" in obj) || obj.type !== "message_end") continue;
    if (!("message" in obj) || !obj.message || typeof obj.message !== "object") continue;
    const msg = obj.message;
    if (!("role" in msg) || msg.role !== "assistant") continue;
    if (!("content" in msg) || !Array.isArray(msg.content)) continue;
    const texts: string[] = [];
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      if (!("type" in part) || part.type !== "text") continue;
      if ("text" in part && typeof part.text === "string" && part.text.trim() !== "") {
        texts.push(part.text.trim());
      }
    }
    if (texts.length > 0) last = texts.join("\n");
  }
  return last;
}

export function extractOmpPatch(jsonl: string): string | null {
  const hunks: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    if (!("type" in obj) || obj.type !== "tool_execution_end") continue;
    if (!("toolName" in obj) || obj.toolName !== "edit") continue;
    if (!("result" in obj) || !obj.result || typeof obj.result !== "object") continue;
    const result = obj.result;
    if (!("details" in result) || !result.details || typeof result.details !== "object") continue;
    const details = result.details;
    const path = "path" in details && typeof details.path === "string" ? details.path : "";
    const diff = "diff" in details && typeof details.diff === "string" ? details.diff : "";
    if (diff.trim() === "") continue;
    hunks.push(path !== "" ? `--- ${path}\n${diff}` : diff);
  }
  return hunks.length > 0 ? hunks.join("\n") : null;
}

function payload(ev: EventRow): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(ev.payload_json);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return {};
}

export function reportFromSession(opts: {
  session: SessionRow;
  events: EventRow[];
  ompJsonl?: string | null;
}): HealReport {
  const s = opts.session;
  const outcome = s.outcome ?? "running";
  let files: string[] = [];
  if (s.files_json) {
    try {
      const raw: unknown = JSON.parse(s.files_json);
      if (Array.isArray(raw)) files = raw.filter((x): x is string => typeof x === "string");
    } catch {
      /* ignore */
    }
  }
  let patch: string | null = null;
  let anticheatPass: boolean | null = null;
  let anticheatRule = "";
  let pushed = false;
  let lastPoll: string | null = null;
  let reasoning: string | null = null;
  for (const ev of opts.events) {
    const p = payload(ev);
    if (ev.event === "patch_proposed") {
      if (Array.isArray(p.files) && files.length === 0) {
        files = p.files.filter((x): x is string => typeof x === "string");
      }
      if (typeof p.diff === "string" && p.diff.trim() !== "") patch = p.diff;
    }
    if (ev.event === "anticheat") {
      if (p.pass === true) anticheatPass = true;
      if (p.pass === false) {
        anticheatPass = false;
        if (typeof p.rule === "string") anticheatRule = p.rule;
      }
    }
    if (ev.event === "pushed") pushed = true;
    if (ev.event === "post_land_poll" && typeof p.state === "string") lastPoll = p.state;
    if (ev.event === "reasoning" && typeof p.text === "string" && p.text.trim() !== "") {
      reasoning = p.text.trim();
    }
  }
  if (!reasoning && opts.ompJsonl) reasoning = extractOmpReasoning(opts.ompJsonl);
  if (!patch && opts.ompJsonl) patch = extractOmpPatch(opts.ompJsonl);

  let accepted = "n/a (no patch)";
  if (anticheatPass === false) accepted = `no (anticheat: ${anticheatRule || "denied"})`;
  else if (files.length > 0 || patch) {
    if (pushed || outcome === "landed" || outcome === "reverted" || outcome === "follow_up") {
      accepted = "yes (pushed)";
    } else if (outcome === "head_moved") accepted = "no (head moved)";
    else if (outcome === "gave_up" && s.error === "dryRun") accepted = "no (dryRun)";
    else if (outcome === "denied_policy") accepted = `no (anticheat: ${s.failure_class ?? anticheatRule})`;
    else accepted = `no (${outcome})`;
  } else if (outcome === "not_reproduced") accepted = "n/a (no diff)";
  else if (outcome === "denied_policy") accepted = `no (anticheat: ${s.failure_class ?? anticheatRule})`;

  let worked = "n/a";
  if (pushed || outcome === "landed" || outcome === "reverted" || outcome === "follow_up") {
    if (outcome === "reverted") worked = "no (reverted)";
    else if (outcome === "follow_up") worked = "no (new checks; iterating)";
    else if (outcome === "gave_up") worked = "no (still red)";
    else if (lastPoll === "green") worked = "yes (main green)";
    else if (lastPoll === "red") worked = "no (still red)";
    else if (outcome === "landed") worked = "yes (landed)";
    else worked = `unknown (${lastPoll ?? outcome})`;
  }

  return {
    sessionId: s.id,
    repo: s.repo,
    sha: s.start_sha,
    outcome,
    files,
    patch,
    accepted,
    worked,
    reasoning,
  };
}

export function formatHealReport(r: HealReport, opts: { fullPatch: boolean }): string {
  const lines = [
    `session ${r.sessionId} ${r.repo} ${r.sha.slice(0, 12)} ${r.outcome}`,
    `  patch: ${r.files.length > 0 ? r.files.join(", ") : r.patch ? "(unnamed diff)" : "(none)"}`,
    `  accepted: ${r.accepted}`,
    `  worked: ${r.worked}`,
    `  reasoning: ${r.reasoning ?? "(none)"}`,
  ];
  if (opts.fullPatch) {
    lines.push("  diff:");
    lines.push(r.patch && r.patch.trim() !== "" ? r.patch : "  (none)");
  }
  return lines.join("\n");
}

export function formatPriorHealContext(repo: string, reports: HealReport[], maxChars = 60_000): string | null {
  if (reports.length === 0) return null;
  const header = [
    `Prior Samasara telemetry for ${repo} (newest first):`,
    "A normal commit or merge can reintroduce a failure that an earlier heal already fixed.",
    "Compare these accepted patches with the current checkout before investigating from scratch. Treat them as evidence, reproduce the current failure, and reapply only fixes that still match.",
  ].join("\n");
  let text = header;
  for (const report of reports) {
    const section = `\n\n${formatHealReport(report, { fullPatch: true })}`;
    if (text.length + section.length <= maxChars) {
      text += section;
      continue;
    }
    const marker = "\n[prior telemetry truncated]";
    const remaining = maxChars - text.length - marker.length;
    if (remaining > 0) text += section.slice(0, remaining);
    text += marker;
    break;
  }
  return text;
}

export function buildPriorHealContext(
  db: Database,
  repo: string,
  beforeSessionId: number,
): string | null {
  const reports = priorPushedSessions(db, repo, beforeSessionId).map((session) =>
    reportFromSession({ session, events: eventsForSession(db, session.id) }),
  );
  return formatPriorHealContext(repo, reports);
}
