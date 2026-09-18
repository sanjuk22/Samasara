import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("start detaches and stop terminates the daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "samasara-daemon-"));
  roots.push(root);
  writeFileSync(join(root, "config.json"), JSON.stringify({ repos: [], pollIntervalSeconds: 60 }));
  const script = resolve(import.meta.dir, "index.ts");
  const env = { ...process.env, GITHUB_TOKEN: "test-token", GH_TOKEN: "" };

  const start = Bun.spawn([process.execPath, script, "start"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [startCode, startOut, startErr] = await Promise.all([
    start.exited,
    new Response(start.stdout).text(),
    new Response(start.stderr).text(),
  ]);
  expect(startCode, startErr).toBe(0);
  expect(startOut).toContain("started pid");

  const lockPath = join(root, "data", "samasara.lock");
  const pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
  pids.push(pid);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).not.toThrow();

  const runningStatus = Bun.spawn([process.execPath, script, "status"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [runningStatusCode, runningStatusOut, runningStatusErr] = await Promise.all([
    runningStatus.exited,
    new Response(runningStatus.stdout).text(),
    new Response(runningStatus.stderr).text(),
  ]);
  expect(runningStatusCode, runningStatusErr).toBe(0);
  expect(runningStatusOut).toStartWith(`daemon=running pid=${pid}\n`);

  const duplicate = Bun.spawn([process.execPath, script, "start"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [duplicateCode, duplicateErr] = await Promise.all([
    duplicate.exited,
    new Response(duplicate.stderr).text(),
  ]);
  expect(duplicateCode).toBe(1);
  expect(duplicateErr).toContain(`already running pid ${pid}`);

  const stop = Bun.spawn([process.execPath, script, "stop"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stopCode, stopOut, stopErr] = await Promise.all([
    stop.exited,
    new Response(stop.stdout).text(),
    new Response(stop.stderr).text(),
  ]);
  expect(stopCode, stopErr).toBe(0);
  expect(stopOut).toContain(`stopped pid ${pid}`);
  expect(existsSync(lockPath)).toBe(false);
  expect(() => process.kill(pid, 0)).toThrow();

  const stoppedStatus = Bun.spawn([process.execPath, script, "status"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stoppedStatusCode, stoppedStatusOut, stoppedStatusErr] = await Promise.all([
    stoppedStatus.exited,
    new Response(stoppedStatus.stdout).text(),
    new Response(stoppedStatus.stderr).text(),
  ]);
  expect(stoppedStatusCode, stoppedStatusErr).toBe(0);
  expect(stoppedStatusOut).toStartWith("daemon=stopped\n");
  pids.pop();
}, 10_000);
