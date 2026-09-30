import { expect, test } from "bun:test";
import { openDb } from "./db";
import {
  archiveQuestion,
  azureMonitoringSettings,
  createMonitoringEvent,
  flushMonitoringOutbox,
  MonitoringContractError,
  monitoringEnvironment,
  queueMonitoringEvent,
  recordMonitoringEvent,
  type MonitoringEventInput,
} from "./observability";

const context = {
  application: "udap.assistant",
  environment: "test" as const,
  userIdHash: "a".repeat(64),
  sessionId: "session-42",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
};

function monitoringDb() {
  return openDb({ dbPath: ":memory:" });
}

test("creates a normalized monitoring event and derives total tokens", () => {
  const event = createMonitoringEvent(
    context,
    {
      eventName: "ai_interaction",
      sourceTimestamp: "2026-09-24T10:00:00-04:00",
      route: "/api/chat/:conversationId",
      feature: "chat.ask",
      result: "success",
      durationMs: 1250,
      repository: "EEOC/UDAP",
      commitSha: "ABCDEF1234567",
      model: "gpt-5.1",
      promptTokens: 120,
      completionTokens: 40,
      questionHash: "b".repeat(64),
      attributes: { office: "ocio", cached: false, archive_ref: "ai-question-archive/path.json" },
    },
    new Date("2026-09-24T14:00:01.000Z"),
  );

  expect(event).toMatchObject({
    schemaVersion: 1,
    timestamp: "2026-09-24T14:00:01.000Z",
    sourceTimestamp: "2026-09-24T14:00:00.000Z",
    eventName: "ai_interaction",
    application: "udap.assistant",
    environment: "test",
    userIdHash: "a".repeat(64),
    route: "/api/chat/:conversationId",
    feature: "chat.ask",
    promptTokens: 120,
    completionTokens: 40,
    totalTokens: 160,
    commitSha: "abcdef1234567",
    attributes: { office: "ocio", cached: false, archive_ref: "ai-question-archive/path.json" },
  });
  expect(Object.isFrozen(event)).toBe(true);
  expect(Object.isFrozen(event.attributes)).toBe(true);
});

test("rejects raw user content and identity fields", () => {
  for (const unsafe of [
    { eventName: "ai_interaction", question: "raw question" },
    { eventName: "login_succeeded", email: "person@example.gov" },
    { eventName: "feature_clicked", userId: "123" },
  ]) {
    expect(() => createMonitoringEvent(context, unsafe as unknown as MonitoringEventInput)).toThrow(
      MonitoringContractError,
    );
  }
});

test("rejects inconsistent or unsafe telemetry values", () => {
  expect(() => createMonitoringEvent(context, {
    eventName: "ai_interaction",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 99,
  })).toThrow("totalTokens must equal promptTokens plus completionTokens");

  expect(() => createMonitoringEvent(context, {
    eventName: "feature_clicked",
    route: "/dashboard?case=private",
  })).toThrow("route must be a path template without query parameters or fragments");

  expect(() => createMonitoringEvent(context, {
    eventName: "feature_clicked",
    attributes: { email_address: "person@example.gov" },
  })).toThrow("attribute key email_address is not allowed");
});

test("delivers queued AI interactions to the Azure Monitor DCR", async () => {
  const db = monitoringDb();
  let requestedUrl = "";
  let requestedBody: unknown;
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-access-token" });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const recorded = await recordMonitoringEvent(db, context, {
    eventName: "ai_interaction",
    feature: "chat.ask",
    result: "success",
    durationMs: 250,
    model: "gpt-5.1",
    promptTokens: 10,
    completionTokens: 5,
    questionHash: "c".repeat(64),
  }, {
    env: {
      SAMASARA_AZURE_LOGS_ENDPOINT: "https://logs.example.test/",
      SAMASARA_AZURE_DCR_ID: "dcr-abc123",
    },
    accessToken: "test-access-token",
    fetch: request,
    now: new Date("2026-09-28T12:00:00.000Z"),
  });

  expect(recorded.flush).toEqual({ delivered: 1, deferred: 0 });
  expect(requestedUrl).toBe(
    "https://logs.example.test/dataCollectionRules/dcr-abc123/streams/Custom-SamasaraEvent?api-version=2023-01-01",
  );
  expect(requestedBody).toEqual([recorded.event]);
  expect(db.query("SELECT COUNT(*) AS count FROM monitoring_outbox").get()).toEqual({ count: 0 });
  db.close();
});

test("retains failed AI interactions and applies retry backoff", async () => {
  const db = monitoringDb();
  const now = new Date("2026-09-28T12:00:00.000Z");
  queueMonitoringEvent(db, context, {
    eventName: "ai_interaction",
    feature: "chat.ask",
    result: "failure",
    durationMs: 50,
    model: "gpt-5.1",
    promptTokens: 3,
    completionTokens: 0,
    questionHash: "d".repeat(64),
  }, now);
  let requests = 0;
  const request = (async () => {
    requests += 1;
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  const options = {
    env: {
      SAMASARA_AZURE_LOGS_ENDPOINT: "https://logs.example.test",
      SAMASARA_AZURE_DCR_ID: "dcr-abc123",
    },
    accessToken: "test-access-token",
    fetch: request,
    now,
  };

  const failed = await flushMonitoringOutbox(db, options);
  expect(failed).toEqual({
    delivered: 0,
    deferred: 1,
    error: "Azure Monitor ingestion failed with HTTP 503",
  });
  expect(db.query(
    "SELECT attempt_count, next_attempt_at, last_error FROM monitoring_outbox",
  ).get()).toEqual({
    attempt_count: 1,
    next_attempt_at: now.getTime() + 1_000,
    last_error: "Azure Monitor ingestion failed with HTTP 503",
  });

  expect(await flushMonitoringOutbox(db, options)).toEqual({ delivered: 0, deferred: 0 });
  expect(requests).toBe(1);
  db.close();
});

test("requires complete AI interaction metadata", () => {
  expect(() => createMonitoringEvent(context, {
    eventName: "ai_interaction",
    feature: "chat.ask",
    result: "success",
    durationMs: 10,
    promptTokens: 1,
    completionTokens: 1,
    questionHash: "e".repeat(64),
  })).toThrow("ai_interaction is missing required fields: model");
});

test("validates monitoring environment and complete Azure settings", () => {
  expect(monitoringEnvironment({ SAMASARA_ENVIRONMENT: "prod" })).toBe("prod");
  expect(() => monitoringEnvironment({ SAMASARA_ENVIRONMENT: "production" })).toThrow(
    "SAMASARA_ENVIRONMENT must be local, dev, test, or prod",
  );
  expect(azureMonitoringSettings({})).toBeNull();
  expect(() => azureMonitoringSettings({ SAMASARA_AZURE_LOGS_ENDPOINT: "https://logs.example.test" })).toThrow(
    "SAMASARA_AZURE_LOGS_ENDPOINT and SAMASARA_AZURE_DCR_ID must be configured together",
  );
});

test("archives exact healer questions outside monitoring events", async () => {
  let body = "";
  let url = "";
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    url = String(input);
    body = String(init?.body);
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  const reference = await archiveQuestion({
    application: "samasara",
    questionHash: "f".repeat(64),
    sessionId: "session-1",
    traceId: "trace-1",
    parts: ["failed log", "instruction"],
  }, {
    env: { SAMASARA_QUESTION_ARCHIVE_ACCOUNT: "archiveaccount" },
    accessToken: "token",
    fetch: request,
    now: new Date("2026-09-30T12:00:00Z"),
  });

  expect(reference).toStartWith("ai-question-archive/samasara/2026/09/30/ffffffffffffffff-");
  expect(url).toStartWith("https://archiveaccount.blob.core.windows.net/ai-question-archive/samasara/2026/09/30/");
  expect(JSON.parse(body)).toMatchObject({
    application: "samasara",
    questionHash: "f".repeat(64),
    sessionId: "session-1",
    traceId: "trace-1",
    question: "failed log\n\u001e\ninstruction",
  });
});
