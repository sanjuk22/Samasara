export const MONITORING_SCHEMA_VERSION = 1 as const;

export const MONITORING_EVENT_NAMES = [
  "feature_clicked",
  "login_started",
  "login_succeeded",
  "login_failed",
  "logout",
  "session_expired",
  "access_denied",
  "ai_interaction",
  "workflow_started",
  "workflow_completed",
  "deployment_started",
  "deployment_completed",
  "deployment_failed",
  "healer_started",
  "healer_completed",
] as const;

export const MONITORING_ENVIRONMENTS = ["local", "dev", "test", "prod"] as const;
export const MONITORING_RESULTS = ["success", "failure", "denied", "cancelled", "timeout"] as const;

export type MonitoringEventName = (typeof MONITORING_EVENT_NAMES)[number];
export type MonitoringEnvironment = (typeof MONITORING_ENVIRONMENTS)[number];
export type MonitoringResult = (typeof MONITORING_RESULTS)[number];
export type MonitoringAttribute = string | number | boolean;

export type MonitoringContext = Readonly<{
  application: string;
  environment: MonitoringEnvironment;
  userIdHash?: string;
  sessionId?: string;
  traceId?: string;
}>;

export type MonitoringEventInput = Readonly<{
  eventName: MonitoringEventName;
  sourceTimestamp?: string;
  route?: string;
  feature?: string;
  result?: MonitoringResult;
  durationMs?: number;
  repository?: string;
  workflowName?: string;
  workflowRunId?: string;
  commitSha?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  questionHash?: string;
  attributes?: Readonly<Record<string, MonitoringAttribute>>;
}>;

export type MonitoringEvent = Readonly<{
  schemaVersion: typeof MONITORING_SCHEMA_VERSION;
  timestamp: string;
  eventName: MonitoringEventName;
  application: string;
  environment: MonitoringEnvironment;
  userIdHash?: string;
  sessionId?: string;
  traceId?: string;
  sourceTimestamp?: string;
  route?: string;
  feature?: string;
  result?: MonitoringResult;
  durationMs?: number;
  repository?: string;
  workflowName?: string;
  workflowRunId?: string;
  commitSha?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  questionHash?: string;
  attributes?: Readonly<Record<string, MonitoringAttribute>>;
}>;

export class MonitoringContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitoringContractError";
  }
}

const EVENT_NAMES: Record<MonitoringEventName, true> = {
  feature_clicked: true,
  login_started: true,
  login_succeeded: true,
  login_failed: true,
  logout: true,
  session_expired: true,
  access_denied: true,
  ai_interaction: true,
  workflow_started: true,
  workflow_completed: true,
  deployment_started: true,
  deployment_completed: true,
  deployment_failed: true,
  healer_started: true,
  healer_completed: true,
};
const ENVIRONMENTS: Record<MonitoringEnvironment, true> = { local: true, dev: true, test: true, prod: true };
const RESULTS: Record<MonitoringResult, true> = {
  success: true,
  failure: true,
  denied: true,
  cancelled: true,
  timeout: true,
};
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,127}$/;
const ATTRIBUTE_KEY = /^[a-z][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{7,64}$/i;
const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SENSITIVE_ATTRIBUTE_KEY = /(body|email|password|prompt|question|response|secret|token|username)/i;
const FORBIDDEN_CONTENT_FIELDS = [
  "email",
  "prompt",
  "question",
  "requestBody",
  "response",
  "responseBody",
  "userId",
  "username",
] as const;

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new MonitoringContractError(`${field} must be a stable lowercase identifier`);
  }
  return value;
}

function optionalText(value: unknown, field: string, maxLength = 256): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new MonitoringContractError(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maxLength || CONTROL_CHARACTER.test(normalized)) {
    throw new MonitoringContractError(`${field} is invalid`);
  }
  return normalized;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredIdentifier(value, field);
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  values: Readonly<Partial<Record<T, true>>>,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || values[value as T] !== true) {
    throw new MonitoringContractError(`${field} is not supported`);
  }
  return value as T;
}

function optionalNonnegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MonitoringContractError(`${field} must be a nonnegative safe integer`);
  }
  return value;
}

function optionalHash(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new MonitoringContractError(`${field} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new MonitoringContractError(`${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new MonitoringContractError(`${field} must be an ISO timestamp`);
  return parsed.toISOString();
}

function optionalRoute(value: unknown): string | undefined {
  const route = optionalText(value, "route");
  if (route === undefined) return undefined;
  if (!route.startsWith("/") || route.includes("?") || route.includes("#")) {
    throw new MonitoringContractError("route must be a path template without query parameters or fragments");
  }
  return route;
}

function optionalRepository(value: unknown): string | undefined {
  const repository = optionalText(value, "repository", 201);
  if (repository === undefined) return undefined;
  if (!REPOSITORY.test(repository)) throw new MonitoringContractError("repository must use owner/name");
  return repository;
}

function optionalCommitSha(value: unknown): string | undefined {
  const sha = optionalText(value, "commitSha", 64);
  if (sha === undefined) return undefined;
  if (!COMMIT_SHA.test(sha)) throw new MonitoringContractError("commitSha must be a hexadecimal Git SHA");
  return sha.toLowerCase();
}

function optionalAttributes(value: unknown): Readonly<Record<string, MonitoringAttribute>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MonitoringContractError("attributes must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new MonitoringContractError("attributes cannot contain more than 32 values");
  const result: Record<string, MonitoringAttribute> = {};
  for (const [key, attribute] of entries) {
    if (!ATTRIBUTE_KEY.test(key) || SENSITIVE_ATTRIBUTE_KEY.test(key)) {
      throw new MonitoringContractError(`attribute key ${key} is not allowed`);
    }
    if (typeof attribute === "string") {
      const normalized = optionalText(attribute, `attributes.${key}`);
      if (normalized === undefined) throw new MonitoringContractError(`attributes.${key} is invalid`);
      result[key] = normalized;
    } else if (typeof attribute === "number") {
      if (!Number.isFinite(attribute)) throw new MonitoringContractError(`attributes.${key} must be finite`);
      result[key] = attribute;
    } else if (typeof attribute === "boolean") {
      result[key] = attribute;
    } else {
      throw new MonitoringContractError(`attributes.${key} must be a string, number, or boolean`);
    }
  }
  return Object.freeze(result);
}

function assertNoRawContent(input: MonitoringEventInput): void {
  const record = input as MonitoringEventInput & Record<string, unknown>;
  for (const field of FORBIDDEN_CONTENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      throw new MonitoringContractError(`${field} cannot be included in monitoring events`);
    }
  }
}

export function createMonitoringEvent(
  context: MonitoringContext,
  input: MonitoringEventInput,
  now: Date = new Date(),
): MonitoringEvent {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new MonitoringContractError("now must be a valid Date");
  }
  if (context === null || typeof context !== "object" || input === null || typeof input !== "object") {
    throw new MonitoringContractError("context and input are required");
  }
  assertNoRawContent(input);

  const eventName = optionalEnum<MonitoringEventName>(input.eventName, "eventName", EVENT_NAMES);
  if (eventName === undefined) throw new MonitoringContractError("eventName is required");
  const environment = optionalEnum<MonitoringEnvironment>(context.environment, "environment", ENVIRONMENTS);
  if (environment === undefined) throw new MonitoringContractError("environment is required");

  const promptTokens = optionalNonnegativeInteger(input.promptTokens, "promptTokens");
  const completionTokens = optionalNonnegativeInteger(input.completionTokens, "completionTokens");
  let totalTokens = optionalNonnegativeInteger(input.totalTokens, "totalTokens");
  if (promptTokens !== undefined && completionTokens !== undefined) {
    const calculatedTotal = promptTokens + completionTokens;
    if (!Number.isSafeInteger(calculatedTotal)) throw new MonitoringContractError("token total exceeds safe integer range");
    if (totalTokens !== undefined && totalTokens !== calculatedTotal) {
      throw new MonitoringContractError("totalTokens must equal promptTokens plus completionTokens");
    }
    totalTokens = calculatedTotal;
  }

  const event: MonitoringEvent = {
    schemaVersion: MONITORING_SCHEMA_VERSION,
    timestamp: now.toISOString(),
    eventName,
    application: requiredIdentifier(context.application, "application"),
    environment,
    ...optionalProperty("userIdHash", optionalHash(context.userIdHash, "userIdHash")),
    ...optionalProperty("sessionId", optionalText(context.sessionId, "sessionId", 128)),
    ...optionalProperty("traceId", optionalText(context.traceId, "traceId", 128)),
    ...optionalProperty("sourceTimestamp", optionalTimestamp(input.sourceTimestamp, "sourceTimestamp")),
    ...optionalProperty("route", optionalRoute(input.route)),
    ...optionalProperty("feature", optionalIdentifier(input.feature, "feature")),
    ...optionalProperty("result", optionalEnum<MonitoringResult>(input.result, "result", RESULTS)),
    ...optionalProperty("durationMs", optionalNonnegativeInteger(input.durationMs, "durationMs")),
    ...optionalProperty("repository", optionalRepository(input.repository)),
    ...optionalProperty("workflowName", optionalText(input.workflowName, "workflowName")),
    ...optionalProperty("workflowRunId", optionalText(input.workflowRunId, "workflowRunId", 64)),
    ...optionalProperty("commitSha", optionalCommitSha(input.commitSha)),
    ...optionalProperty("model", optionalText(input.model, "model", 128)),
    ...optionalProperty("promptTokens", promptTokens),
    ...optionalProperty("completionTokens", completionTokens),
    ...optionalProperty("totalTokens", totalTokens),
    ...optionalProperty("questionHash", optionalHash(input.questionHash, "questionHash")),
    ...optionalProperty("attributes", optionalAttributes(input.attributes)),
  };
  return Object.freeze(event);
}

function optionalProperty<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}
