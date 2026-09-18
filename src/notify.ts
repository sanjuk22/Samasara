import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Config, SmtpConfig } from "./config";
import { eventsForSession, type FinishFields } from "./db";

export const HUMAN_OUTCOMES: Record<string, true> = {
  not_reproduced: true,
  gave_up: true,
  denied_policy: true,
  budget: true,
  error: true,
  reverted: true,
  head_moved: true,
};

export type NotifyMail = { to: string; subject: string; body: string };

export function needsHumanNotify(fields: FinishFields): boolean {
  if (!fields.outcome || !HUMAN_OUTCOMES[fields.outcome]) return false;
  if (fields.error === "dryRun") return false;
  return true;
}

export function buildNotifyMail(opts: {
  to: string;
  repo: string;
  sessionId: number;
  sha: string;
  fields: FinishFields;
  events: Array<{ event: string; payload_json: string }>;
}): NotifyMail {
  const outcome = opts.fields.outcome ?? "error";
  const subject = `Samasara needs you: ${opts.repo} [${outcome}]`;
  const lines = [
    `Repo: ${opts.repo}`,
    `HEAD: ${opts.sha}`,
    `Session: ${opts.sessionId}`,
    `Outcome: ${outcome}`,
  ];
  if (opts.fields.failure_class) lines.push(`Policy: ${opts.fields.failure_class}`);
  if (opts.fields.error) lines.push(`Error: ${opts.fields.error}`);
  if (opts.fields.files_json) lines.push(`Files: ${opts.fields.files_json}`);
  const [owner, name] = opts.repo.split("/");
  if (owner && name) {
    lines.push(`Commit: https://github.com/${owner}/${name}/commit/${opts.sha}`);
  }
  lines.push("", "Events:");
  const tail = opts.events.slice(-20);
  if (tail.length === 0) lines.push("(none)");
  for (const e of tail) {
    const payload = e.payload_json && e.payload_json !== "{}" ? ` ${e.payload_json}` : "";
    lines.push(`- ${e.event}${payload}`);
  }
  lines.push("", `On the VPS: bun src/index.ts telemetry ${opts.sessionId}`);
  return { to: opts.to, subject, body: lines.join("\n") };
}

const SMTP_PY = `import os, smtplib, ssl
from email.message import EmailMessage
from pathlib import Path

to = os.environ["SAMASARA_NOTIFY_TO"]
subject = Path(os.environ["SAMASARA_NOTIFY_SUBJECT_FILE"]).read_text()
body = Path(os.environ["SAMASARA_NOTIFY_BODY_FILE"]).read_text()
host = os.environ["SAMASARA_SMTP_HOST"]
port = int(os.environ["SAMASARA_SMTP_PORT"])
user = os.environ.get("SAMASARA_SMTP_USER", "")
password = os.environ.get("SAMASARA_SMTP_PASSWORD", "")
mail_from = os.environ["SAMASARA_SMTP_FROM"]
msg = EmailMessage()
msg["From"] = mail_from
msg["To"] = to
msg["Subject"] = subject
msg.set_content(body)
ctx = ssl.create_default_context()
if port == 465:
    s = smtplib.SMTP_SSL(host, port, context=ctx)
else:
    s = smtplib.SMTP(host, port, timeout=30)
    s.starttls(context=ctx)
if user:
    s.login(user, password)
s.send_message(msg)
s.quit()
`;

async function sendSmtp(smtp: SmtpConfig, mail: NotifyMail): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "samasara-mail-"));
  const subj = join(dir, "subject.txt");
  const body = join(dir, "body.txt");
  const py = join(dir, "send.py");
  writeFileSync(subj, mail.subject);
  writeFileSync(body, mail.body);
  writeFileSync(py, SMTP_PY);
  try {
    const proc = Bun.spawn(["python3", py], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        ...process.env,
        SAMASARA_NOTIFY_TO: mail.to,
        SAMASARA_NOTIFY_SUBJECT_FILE: subj,
        SAMASARA_NOTIFY_BODY_FILE: body,
        SAMASARA_SMTP_HOST: smtp.host,
        SAMASARA_SMTP_PORT: String(smtp.port),
        SAMASARA_SMTP_USER: smtp.user,
        SAMASARA_SMTP_PASSWORD: smtp.password,
        SAMASARA_SMTP_FROM: smtp.from,
      },
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(stderr.trim().slice(0, 400) || `smtp exit ${code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function notifyHuman(opts: {
  config: Config;
  db: Database;
  repo: string;
  sessionId: number;
  sha: string;
  fields: FinishFields;
}): Promise<void> {
  if (!opts.config.notifyEmail) return;
  if (!needsHumanNotify(opts.fields)) return;
  const mail = buildNotifyMail({
    to: opts.config.notifyEmail,
    repo: opts.repo,
    sessionId: opts.sessionId,
    sha: opts.sha,
    fields: opts.fields,
    events: eventsForSession(opts.db, opts.sessionId),
  });
  if (!opts.config.smtp) {
    console.error(`notify skipped (no smtp): ${mail.subject}`);
    return;
  }
  await sendSmtp(opts.config.smtp, mail);
  console.log(`notified ${mail.to} ${opts.fields.outcome}`);
}
