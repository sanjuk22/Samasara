import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { redactSecrets } from "./anticheat";
import {
  addTrackedRepo,
  ConfigConflictError,
  editConfigFile,
  loadConfig,
  readRepoConfig,
  removeTrackedRepo,
  setRepoIgnores,
} from "./config";
import { openDb, recentSessions, sessionById, telemetryTotals } from "./db";
import type { SessionRow } from "./db";
import { applicationStatus, healReport } from "./management";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function positiveId(raw: string): number {
  const id = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) throw new HttpError(400, "Invalid session id");
  return id;
}

function ignorePatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || item.length > 200)) {
    throw new HttpError(400, "Expected up to 100 ignore patterns, each at most 200 characters");
  }
  return value as string[];
}

function editorAuthorized(request: Request, allowedUser: string | undefined): boolean {
  if (!allowedUser) return true;
  const login = request.headers.get("tailscale-user-login");
  if (login == null) return false;
  const expected = Buffer.from(allowedUser);
  const got = Buffer.from(login);
  return expected.length === got.length && timingSafeEqual(got, expected);
}

export async function startDashboard() {
  const config = loadConfig();
  const port = Number(process.env.SAMASARA_DASHBOARD_PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SAMASARA_DASHBOARD_PORT");
  const origins = new Map([
    [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
    [`localhost:${port}`, `http://localhost:${port}`],
  ]);
  const publicOrigin = process.env.SAMASARA_DASHBOARD_ORIGIN;
  const allowedUser = process.env.SAMASARA_DASHBOARD_USER;
  if (publicOrigin) {
    if (!allowedUser) throw new Error("SAMASARA_DASHBOARD_USER must name the allowed Tailscale login");
    const url = new URL(publicOrigin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("SAMASARA_DASHBOARD_ORIGIN must be an HTTPS origin without a path");
    }
    origins.set(url.host, url.origin);
  }
  const token = Buffer.from(crypto.randomUUID() + crypto.randomUUID());
  const assets = new Map<string, { body: string; type: string }>();
  for (const [path, file, type] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
  ]) {
    assets.set(path, { body: await Bun.file(join(import.meta.dir, "dashboard", file)).text(), type });
  }
  const db = openDb(config);

  function report(session: SessionRow, fullPatch: boolean) {
    const { patch, ...summary } = healReport(config, db, session);
    const safe = {
      ...summary,
      reasoning: summary.reasoning == null ? null : redactSecrets(summary.reasoning),
      startedAt: session.started_at,
      endedAt: session.ended_at,
    };
    return fullPatch ? { ...safe, patch: patch == null ? null : redactSecrets(patch) } : safe;
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 32 * 1024,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        const origin = origins.get(request.headers.get("host") ?? "");
        if (!origin) throw new HttpError(403, "Host not allowed");
        const canEdit = editorAuthorized(request, publicOrigin ? allowedUser : undefined);
        const requestOrigin = request.headers.get("origin");
        if (request.method === "GET") {
          if (request.headers.get("sec-fetch-mode") === "cors" && requestOrigin != null && requestOrigin !== origin) {
            throw new HttpError(403, "Cross-origin request denied");
          }
        } else if (request.headers.get("sec-fetch-site") === "cross-site" || (requestOrigin != null && requestOrigin !== origin)) {
          throw new HttpError(403, "Cross-origin request denied");
        }
        const path = url.pathname;
        if (request.method === "GET") {
          const asset = assets.get(path);
          if (asset) return new Response(asset.body, { headers: { ...SECURITY_HEADERS, "Content-Type": asset.type } });
          if (path === "/api/csrf") {
            if (!canEdit) throw new HttpError(403, "Tailscale account not authorized");
            return Response.json({ token: token.toString() }, { headers: SECURITY_HEADERS });
          }
          if (path === "/api/status") {
            const latest = readRepoConfig();
            return Response.json({
              ...applicationStatus({ ...config, repos: latest.repos, ignoreChecks: latest.ignoreChecks }, db),
              canEdit,
            }, { headers: SECURITY_HEADERS });
          }
          if (path === "/api/repos") return Response.json(readRepoConfig(), { headers: SECURITY_HEADERS });
          if (path === "/api/telemetry") {
            const rawBefore = url.searchParams.get("before");
            const sessions = recentSessions(db, 21, rawBefore == null ? undefined : positiveId(rawBefore));
            const page = sessions.slice(0, 20);
            const totals = telemetryTotals(db);
            return Response.json({
              sessions: page.map((session) => report(session, false)),
              nextBefore: sessions.length > 20 ? page[page.length - 1].id : null,
              totals: {
                sessions: totals.sessions,
                attempts: totals.attempts,
                tokensIn: totals.tokens_in,
                tokensOut: totals.tokens_out,
                durationMs: totals.duration_ms,
              },
            }, { headers: SECURITY_HEADERS });
          }
          const sessionMatch = /^\/api\/telemetry\/([^/]+)$/.exec(path);
          if (sessionMatch) {
            const session = sessionById(db, positiveId(sessionMatch[1]));
            if (!session) throw new HttpError(404, "Session not found");
            return Response.json(report(session, true), { headers: SECURITY_HEADERS });
          }
          throw new HttpError(404, "Not found");
        }
        if (!["POST", "PATCH", "DELETE"].includes(request.method)) throw new HttpError(405, "Method not allowed");
        if (!canEdit) throw new HttpError(403, "Tailscale account not authorized");
        if (requestOrigin !== origin) throw new HttpError(403, "Same-origin request required");
        const suppliedToken = Buffer.from(request.headers.get("x-samasara-csrf") ?? "");
        if (suppliedToken.length !== token.length || !timingSafeEqual(suppliedToken, token)) {
          throw new HttpError(403, "Invalid CSRF token; refresh the page");
        }
        if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          throw new HttpError(415, "Expected application/json");
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          throw new HttpError(400, "Invalid JSON body");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Expected an object");
        if (!("revision" in body) || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) {
          throw new HttpError(400, "A current config revision is required");
        }
        const match = /^\/api\/repos\/([^/]+)\/([^/]+)$/.exec(path);
        let spec: string;
        let ignores: string[] = [];
        if (path === "/api/repos" && request.method === "POST") {
          if (!("repo" in body) || typeof body.repo !== "string") throw new HttpError(400, "Expected owner/name");
          spec = body.repo;
          ignores = ignorePatterns("ignoreChecks" in body ? body.ignoreChecks : []);
        } else if (match && (request.method === "PATCH" || request.method === "DELETE")) {
          try {
            spec = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
          } catch {
            throw new HttpError(400, "Invalid repository path");
          }
          if (request.method === "PATCH") ignores = ignorePatterns("ignoreChecks" in body ? body.ignoreChecks : undefined);
        } else {
          throw new HttpError(404, "Not found");
        }
        const updated = editConfigFile((obj) => {
          try {
            if (request.method === "POST") addTrackedRepo(obj, spec);
            if (request.method === "DELETE") removeTrackedRepo(obj, spec);
            else setRepoIgnores(obj, spec, ignores);
          } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : "Invalid repository change");
          }
        }, { revision: body.revision });
        return Response.json(updated, { status: request.method === "POST" ? 201 : 200, headers: SECURITY_HEADERS });
      } catch (error) {
        if (error instanceof HttpError || error instanceof ConfigConflictError) {
          return Response.json({ error: error.message }, { status: error instanceof HttpError ? error.status : 409, headers: SECURITY_HEADERS });
        }
        console.error("Dashboard request failed; check config and database access");
        return Response.json({ error: "Unable to read or update application state" }, { status: 500, headers: SECURITY_HEADERS });
      }
    },
    error() {
      return Response.json({ error: "Request failed" }, { status: 500, headers: SECURITY_HEADERS });
    },
  });
  const shutdown = async () => {
    await server.stop();
    db.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.log(`Dashboard listening on http://127.0.0.1:${server.port}${publicOrigin ? `; private origin ${publicOrigin}` : "; remote access not configured"}`);
  return server;
}
