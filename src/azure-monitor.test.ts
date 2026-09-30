import { expect, test } from "bun:test";
import { monitoringQuery, queryMonitoringView } from "./azure-monitor";

const workspaceId = "11111111-2222-4333-8444-555555555555";

test("monitoring views use fixed aggregate queries", () => {
  expect(monitoringQuery("applications")).toContain("AppRequests");
  expect(monitoringQuery("applications")).toContain("P95DurationMs");
  expect(monitoringQuery("ai")).toContain('EventName == "ai_interaction"');
  expect(monitoringQuery("workflows")).toContain("SamasaraWorkflow_CL");
  expect(monitoringQuery("authentication")).toContain("access_denied");
});

test("monitoring query maps Azure columns to named rows", async () => {
  let requestedUrl = "";
  let requestedQuery = "";
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedQuery = JSON.parse(String(init?.body)).query;
    return Response.json({
      tables: [{
        columns: [{ name: "Application" }, { name: "Requests" }],
        rows: [["eeoc.ai.workspace", 12]],
      }],
    });
  }) as typeof fetch;

  const result = await queryMonitoringView("applications", {
    env: { SAMASARA_AZURE_WORKSPACE_ID: workspaceId },
    accessToken: "token",
    fetch: request,
  });

  expect(requestedUrl).toBe(`https://api.loganalytics.azure.com/v1/workspaces/${workspaceId}/query`);
  expect(requestedQuery).toContain("AppRequests");
  expect(result).toEqual({
    configured: true,
    columns: ["Application", "Requests"],
    rows: [{ Application: "eeoc.ai.workspace", Requests: 12 }],
  });
});

test("monitoring query reports unconfigured workspace without network access", async () => {
  const result = await queryMonitoringView("ai", { env: {} });
  expect(result).toEqual({ configured: false, columns: [], rows: [] });
});

test("monitoring query rejects resource IDs in place of customer IDs", async () => {
  expect(queryMonitoringView("ai", {
    env: { SAMASARA_AZURE_WORKSPACE_ID: "/subscriptions/example/resourceGroups/example" },
  })).rejects.toThrow("workspace customer ID");
});
