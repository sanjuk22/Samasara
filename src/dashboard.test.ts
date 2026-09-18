import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already stopped */
    }
  }
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
  pids.push(proc.pid);
  await waitForListening(proc);
  return Number(env.SAMASARA_DASHBOARD_PORT);
}

test("public origin allows anonymous reads and blocks writes", async () => {
  const origin = "https://samasara.example.ts.net";
  const host = "samasara.example.ts.net";
  const port = 33000 + Math.floor(Math.random() * 2000);
  await startDashboard({
    SAMASARA_DASHBOARD_PORT: String(port),
    SAMASARA_DASHBOARD_ORIGIN: origin,
    SAMASARA_DASHBOARD_USER: "owner@example.com",
  });
  const anonymous = await curl(port, "/api/status", { Host: host });
  expect(anonymous.status).toBe(200);
  expect(anonymous.body.canEdit).toBe(false);
  expect(anonymous.body.repos[0].repo).toBe("acme/demo");

  const owner = await curl(port, "/api/status", { Host: host, "Tailscale-User-Login": "owner@example.com" });
  expect(owner.status).toBe(200);
  expect(owner.body.canEdit).toBe(true);

  const stranger = await curl(port, "/api/status", { Host: host, "Tailscale-User-Login": "other@example.com" });
  expect(stranger.status).toBe(200);
  expect(stranger.body.canEdit).toBe(false);

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
  const port = 35000 + Math.floor(Math.random() * 2000);
  await startDashboard({
    SAMASARA_DASHBOARD_PORT: String(port),
    SAMASARA_DASHBOARD_ORIGIN: "",
    SAMASARA_DASHBOARD_USER: "",
  });
  const status = await curl(port, "/api/status", {});
  expect(status.status).toBe(200);
  expect(status.body.canEdit).toBe(true);
  const csrf = await curl(port, "/api/csrf", {});
  expect(csrf.status).toBe(200);
  expect(typeof csrf.body.token).toBe("string");
}, 10_000);
