import { expect, test } from "bun:test";
import { dependencyRecord } from "./traffic";

test("dependency records omit query strings and preserve request correlation", () => {
  const record = dependencyRecord({
    method: "GET",
    url: new URL("https://api.github.com/repos/EEOC/example/actions?token=secret"),
    statusCode: 200,
    durationMs: 12.6,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  });

  expect(record).toMatchObject({
    log: "application_dependency",
    application: "samasara",
    dependencyType: "HTTP",
    target: "api.github.com",
    name: "GET api.github.com/repos/EEOC/example/actions",
    statusCode: 200,
    durationMs: 13,
    success: true,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  });
  expect(JSON.stringify(record)).not.toContain("token=secret");
});

test("dependency errors are unsuccessful without serializing messages", () => {
  const record = dependencyRecord({
    method: "POST",
    url: new URL("https://example.invalid/ingest"),
    statusCode: 0,
    durationMs: 1,
    traceId: "trace",
    error: "TimeoutError",
  });
  expect(record).toMatchObject({ success: false, error: "TimeoutError" });
});
