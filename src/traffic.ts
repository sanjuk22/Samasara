import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { monitoringEnvironment } from "./observability";

const traceContext = new AsyncLocalStorage<{ traceId: string }>();
let installed = false;

export function runWithTrace<T>(traceId: string, operation: () => Promise<T>): Promise<T> {
  return traceContext.run({ traceId }, operation);
}

export function dependencyRecord(input: {
  method: string;
  url: URL;
  statusCode: number;
  durationMs: number;
  traceId: string;
  error?: string;
}): Record<string, string | number | boolean> {
  return {
    log: "application_dependency",
    timestamp: new Date().toISOString(),
    application: "samasara",
    environment: monitoringEnvironment(),
    dependencyType: "HTTP",
    target: input.url.hostname,
    name: `${input.method} ${input.url.hostname}${input.url.pathname}`,
    statusCode: input.statusCode,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    success: input.statusCode >= 200 && input.statusCode < 400 && !input.error,
    traceId: input.traceId,
    ...(input.error ? { error: input.error } : {}),
  };
}

export function installDependencyTelemetry(): void {
  if (installed) return;
  installed = true;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const traceId = traceContext.getStore()?.traceId ?? randomUUID().replaceAll("-", "");
    const startedAt = performance.now();
    let statusCode = 0;
    let errorName: string | undefined;
    try {
      const response = await nativeFetch(input, init);
      statusCode = response.status;
      return response;
    } catch (error) {
      errorName = error instanceof Error ? error.name : "unknown";
      throw error;
    } finally {
      console.info(JSON.stringify(dependencyRecord({
        method,
        url,
        statusCode,
        durationMs: performance.now() - startedAt,
        traceId,
        ...(errorName ? { error: errorName } : {}),
      })));
    }
  };
}
