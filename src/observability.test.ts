import { expect, test } from "bun:test";
import {
  createMonitoringEvent,
  MonitoringContractError,
  type MonitoringEventInput,
} from "./observability";

const context = {
  application: "udap.assistant",
  environment: "test" as const,
  userIdHash: "a".repeat(64),
  sessionId: "session-42",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
};

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
      attributes: { office: "ocio", cached: false },
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
    attributes: { office: "ocio", cached: false },
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
