import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const processes: Array<{ pid: number; exited: Promise<number> }> = [];

afterEach(async () => {
  const running = processes.splice(0);
  for (const proc of running) {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      /* already stopped */
    }
  }
  await Promise.all(running.map((proc) => proc.exited.catch(() => -1)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForListening(proc: { stdout: ReadableStream<Uint8Array>; exited: Promise<number> }) {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const chunk = await Promise.race([
      reader.read(),
      proc.exited.then((code) => {
        throw new Error(buf || `dashboard exited ${code}`);
      }),
    ]);
    if ("done" in chunk && chunk.done) throw new Error(buf || "dashboard closed stdout");
    if (!("value" in chunk) || chunk.value == null) continue;
    buf += decoder.decode(chunk.value, { stream: true });
    if (buf.includes("Dashboard listening")) return;
  }
}

function curl(port: number, path: string, headers: Record<string, string>, extra: string[] = []) {
  const args = ["curl", "--silent", "--show-error", "--write-out", "\n%{http_code}", ...extra];
  for (const [name, value] of Object.entries(headers)) args.push("-H", `${name}: ${value}`);
  args.push(`http://127.0.0.1:${port}${path}`);
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr) || `curl exited ${result.exitCode}`);
  const raw = new TextDecoder().decode(result.stdout);
  const split = raw.lastIndexOf("\n");
  const body = raw.slice(0, split);
  const status = Number(raw.slice(split + 1));
  try {
    return { status, body: body ? JSON.parse(body) : null };
  } catch {
    return { status, body };
  }
}

async function startDashboard(env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "samasara-dash-"));
  roots.push(root);
  writeFileSync(join(root, "config.json"), JSON.stringify({
    repos: [{ owner: "acme", name: "demo" }],
    pollIntervalSeconds: 900,
  }));
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "index.ts"), "dashboard"], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_TOKEN: "test-token",
      GH_TOKEN: "",
      SAMASARA_CONFIG: join(root, "config.json"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(proc);
  await waitForListening(proc);
  return { port: Number(env.SAMASARA_DASHBOARD_PORT), dbPath: join(root, "data", "samasara.sqlite") };
}

test("public origin allows anonymous reads and blocks writes", async () => {
  const origin = "https://samasara.example.ts.net";
  const host = "samasara.example.ts.net";
  const port = 33000 + Math.floor(Math.random() * 2000);
  const { dbPath } = await startDashboard({
    SAMASARA_DASHBOARD_PORT: String(port),
    SAMASARA_DASHBOARD_ORIGIN: origin,
    SAMASARA_DASHBOARD_USER: "owner@example.com",
    SAMASARA_TELEMETRY_HASH_KEY: "test-feature-telemetry-hash-key-32",
  });
  const anonymous = await curl(port, "/api/status", { Host: host });
  expect(anonymous.status).toBe(200);
  expect(anonymous.body.canEdit).toBe(false);
  expect(anonymous.body.canViewTelemetry).toBe(false);
  expect(anonymous.body.repos[0].repo).toBe("acme/demo");

  const owner = await curl(port, "/api/status", { Host: host, "Tailscale-User-Login": "owner@example.com" });
  expect(owner.status).toBe(200);
  expect(owner.body.canEdit).toBe(true);
  expect(owner.body.canViewTelemetry).toBe(true);

  const stranger = await curl(port, "/api/status", { Host: host, "Tailscale-User-Login": "other@example.com" });
  expect(stranger.status).toBe(200);
  expect(stranger.body.canEdit).toBe(false);
  expect(stranger.body.canViewTelemetry).toBe(false);

  const anonymousTelemetry = await curl(port, "/api/telemetry", { Host: host });
  expect(anonymousTelemetry.status).toBe(403);

  const ownerTelemetry = await curl(port, "/api/telemetry", { Host: host, "Tailscale-User-Login": "owner@example.com" });
  expect(ownerTelemetry.status).toBe(200);
  expect(ownerTelemetry.body.totals).toEqual({
    sessions: 0,
    attempts: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
  });

  const strangerTelemetry = await curl(port, "/api/telemetry", { Host: host, "Tailscale-User-Login": "other@example.com" });
  expect(strangerTelemetry.status).toBe(403);
  const monitoringDb = new Database(dbPath);
  const deniedRow = monitoringDb.query("SELECT event_json FROM monitoring_outbox ORDER BY id DESC LIMIT 1").get() as { event_json: string };
  monitoringDb.close();
  expect(JSON.parse(deniedRow.event_json)).toMatchObject({
    eventName: "access_denied",
    userIdHash: createHmac("sha256", "test-feature-telemetry-hash-key-32").update("other@example.com").digest("hex"),
    route: "/api/telemetry",
    feature: "dashboard.monitoring",
    result: "denied",
  });
  expect(deniedRow.event_json).not.toContain("other@example.com");

  const csrf = await curl(port, "/api/csrf", { Host: host });
  expect(csrf.status).toBe(403);

  const sharedLink = await curl(port, "/", {
    Host: host,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    Origin: "https://mail.google.com",
  });
  expect(sharedLink.status).toBe(200);
  expect(String(sharedLink.body)).toContain("Samasara");

  const inAppBrowser = await curl(port, "/", { Host: host, Origin: "https://app.slack.com" });
  expect(inAppBrowser.status).toBe(200);
  expect(String(inAppBrowser.body)).toContain("Samasara");

  const sharedStatus = await curl(port, "/api/status", {
    Host: host,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  });
  expect(sharedStatus.status).toBe(200);
  expect(sharedStatus.body.canEdit).toBe(false);
  expect(sharedStatus.body.canViewTelemetry).toBe(false);

  const foreignFetch = await curl(port, "/api/status", {
    Host: host,
    Origin: "https://evil.example",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
  });
  expect(foreignFetch.status).toBe(403);
  expect(foreignFetch.body.error).toBe("Cross-origin request denied");

  const write = await curl(port, "/api/repos", { Host: host, Origin: origin, "Content-Type": "application/json" }, [
    "-X", "POST",
    "--data", JSON.stringify({ repo: "acme/other", revision: "a".repeat(64) }),
  ]);
  expect(write.status).toBe(403);
  expect(write.body.error).toBe("Tailscale account not authorized");
}, 10_000);

test("localhost dashboard stays writable without Tailscale identity", async () => {
  const requestedPort = 35000 + Math.floor(Math.random() * 2000);
  const { port } = await startDashboard({
    SAMASARA_DASHBOARD_PORT: String(requestedPort),
    SAMASARA_DASHBOARD_ORIGIN: "",
    SAMASARA_DASHBOARD_USER: "",
  });
  const status = await curl(port, "/api/status", {});
  expect(status.status).toBe(200);
  expect(status.body.canEdit).toBe(true);
  expect(status.body.canViewTelemetry).toBe(true);
  const csrf = await curl(port, "/api/csrf", {});
  expect(csrf.status).toBe(200);
  expect(typeof csrf.body.token).toBe("string");
}, 10_000);

test("feature telemetry requires identity and stores only allowlisted metadata", async () => {
  const origin = "https://samasara.example.ts.net";
  const host = "samasara.example.ts.net";
  const hashKey = "test-feature-telemetry-hash-key-32";
  const requestedPort = 37000 + Math.floor(Math.random() * 2000);
  const { port, dbPath } = await startDashboard({
    SAMASARA_DASHBOARD_PORT: String(requestedPort),
    SAMASARA_DASHBOARD_ORIGIN: origin,
    SAMASARA_DASHBOARD_USER: "owner@example.com",
    SAMASARA_TELEMETRY_HASH_KEY: hashKey,
  });
  const headers = { Host: host, Origin: origin, "Content-Type": "application/json" };

  const anonymous = await curl(port, "/api/events", headers, [
    "-X", "POST", "--data", JSON.stringify({ event: "dashboard.telemetry.opened" }),
  ]);
  expect(anonymous.status).toBe(403);

  const unsupported = await curl(port, "/api/events", {
    ...headers,
    "Tailscale-User-Login": "owner@example.com",
  }, [
    "-X", "POST", "--data", JSON.stringify({ event: "dashboard.telemetry.opened", text: "private content" }),
  ]);
  expect(unsupported.status).toBe(400);

  const accepted = await curl(port, "/api/events", {
    ...headers,
    "Tailscale-User-Login": "owner@example.com",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  }, [
    "-X", "POST", "--data", JSON.stringify({ event: "dashboard.telemetry.opened" }),
  ]);
  expect(accepted).toEqual({ status: 202, body: { accepted: true } });

  const db = new Database(dbPath);
  const row = db.query("SELECT event_json FROM monitoring_outbox ORDER BY id DESC LIMIT 1").get() as { event_json: string };
  db.close();
  const event = JSON.parse(row.event_json);
  expect(event).toMatchObject({
    eventName: "feature_clicked",
    application: "samasara",
    environment: "local",
    userIdHash: createHmac("sha256", hashKey).update("owner@example.com").digest("hex"),
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    route: "/dashboard",
    feature: "dashboard.telemetry.opened",
  });
  expect(row.event_json).not.toContain("owner@example.com");
  expect(row.event_json).not.toContain("private content");
}, 10_000);
