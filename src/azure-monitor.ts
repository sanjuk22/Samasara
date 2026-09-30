export type MonitoringView = "applications" | "ai" | "workflows" | "authentication";

const QUERIES: Record<MonitoringView, string> = {
  applications: `AppRequests
| where TimeGenerated > ago(24h)
| summarize Requests=count(), Failures=countif(Success == false), P50DurationMs=percentile(DurationMs, 50), P95DurationMs=percentile(DurationMs, 95), P99DurationMs=percentile(DurationMs, 99) by Application=AppRoleName
| order by Requests desc`,
  ai: `SamasaraEvent_CL
| where TimeGenerated > ago(24h) and EventName == "ai_interaction"
| summarize Attempts=count(), Failures=countif(Result != "success"), PromptTokens=sum(PromptTokens), CompletionTokens=sum(CompletionTokens), TotalTokens=sum(TotalTokens), P95DurationMs=percentile(DurationMs, 95) by Application, Model
| order by TotalTokens desc`,
  workflows: `SamasaraWorkflow_CL
| where TimeGenerated > ago(24h)
| summarize Runs=count(), Failures=countif(Conclusion in ("failure", "timed_out", "cancelled", "action_required", "startup_failure")), P95DurationMs=percentile(DurationMs, 95), LastSeen=max(TimeGenerated) by Repository, WorkflowName
| order by Failures desc, Runs desc`,
  authentication: `SamasaraEvent_CL
| where TimeGenerated > ago(24h) and EventName in ("login_started", "login_succeeded", "login_failed", "logout", "session_expired", "access_denied")
| summarize Events=count() by Application, EventName, Result
| order by Application asc, EventName asc`,
};

type QueryOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  accessToken?: string;
}>;

type AzureQueryResponse = {
  tables?: Array<{
    columns?: Array<{ name?: unknown }>;
    rows?: unknown[][];
  }>;
};

function settings(env: Readonly<Record<string, string | undefined>>): {
  workspaceId: string;
  managedIdentityClientId?: string;
} | null {
  const workspaceId = env.SAMASARA_AZURE_WORKSPACE_ID?.trim() ?? "";
  if (!workspaceId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new Error("SAMASARA_AZURE_WORKSPACE_ID must be a Log Analytics workspace customer ID");
  }
  const managedIdentityClientId = env.SAMASARA_AZURE_MANAGED_IDENTITY_CLIENT_ID?.trim() || undefined;
  return { workspaceId, ...(managedIdentityClientId ? { managedIdentityClientId } : {}) };
}

async function managedIdentityToken(
  managedIdentityClientId: string | undefined,
  request: typeof fetch,
): Promise<string> {
  const url = new URL("http://169.254.169.254/metadata/identity/oauth2/token");
  url.searchParams.set("api-version", "2018-02-01");
  url.searchParams.set("resource", "https://api.loganalytics.io");
  if (managedIdentityClientId) url.searchParams.set("client_id", managedIdentityClientId);
  const response = await request(url, { headers: { Metadata: "true" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`managed identity token request failed with HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("access_token" in body) || typeof body.access_token !== "string") {
    throw new Error("managed identity token response did not contain an access token");
  }
  return body.access_token;
}

export function monitoringQuery(view: MonitoringView): string {
  return QUERIES[view];
}

export async function queryMonitoringView(view: MonitoringView, options: QueryOptions = {}): Promise<{
  configured: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
}> {
  const config = settings(options.env ?? process.env);
  if (!config) return { configured: false, columns: [], rows: [] };
  const request = options.fetch ?? fetch;
  const token = options.accessToken ?? await managedIdentityToken(config.managedIdentityClientId, request);
  const endpoint = new URL(`https://api.loganalytics.azure.com/v1/workspaces/${config.workspaceId}/query`);
  const response = await request(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: monitoringQuery(view) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Azure Monitor query failed with HTTP ${response.status}`);
  const body = await response.json() as AzureQueryResponse;
  const table = body.tables?.[0];
  const columns = table?.columns?.map((column) => typeof column.name === "string" ? column.name : "") ?? [];
  const rows = table?.rows?.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null]))) ?? [];
  return { configured: true, columns, rows };
}
