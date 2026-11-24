import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const requests = new AsyncLocalStorage();
const round = (value) => Math.round(value * 100) / 100;
const allowedPhases = new Set(["auth", "database", "commit", "snapshot", "telemetry", "serialize"]);

export function recordTiming(phase, milliseconds, attempts = 1) {
  const request = requests.getStore();
  if (!request || !allowedPhases.has(phase)) return;
  const current = request.phases[phase] ?? { milliseconds: 0, calls: 0, retries: 0 };
  current.milliseconds += milliseconds;
  current.calls++;
  current.retries += Math.max(0, attempts - 1);
  request.phases[phase] = current;
}

export async function measure(phase, action) {
  if (!requests.getStore()) return action();
  const started = performance.now();
  try { return await action(); }
  finally { recordTiming(phase, performance.now() - started); }
}

export async function databaseCall(action) {
  if (!requests.getStore()) return action();
  const started = performance.now();
  let attempts = 1;
  try {
    const result = await action();
    attempts = result?.$metadata?.attempts ?? 1;
    return result;
  } catch (error) {
    attempts = error?.$metadata?.attempts ?? 1;
    throw error;
  } finally { recordTiming("database", performance.now() - started, attempts); }
}

export function routeLabel(event) {
  const path = (event.rawPath || event.path || "").replace(/\/+$/, "") || "/";
  if (["/health", "/api/health", "/state", "/state/erase", "/changelog", "/admin/changelog", "/auth/me", "/auth/signup", "/auth/signin", "/auth/google", "/api/profile", "/api/settings", "/api/users/search", "/api/users/username", "/api/media", "/api/analytics", "/api/import/statement/pdf", "/api/settlements", "/transactions", "/transactions/batch", "/transactions/bin", "/api/transactions", "/api/transactions/bin", "/recurring", "/recurring/due", "/templates", "/api/recurring", "/api/recurring/due", "/api/templates"].includes(path)) return path;
  const entity = path.match(/^\/entities\/(accounts|friends|trips|categories|recurring|templates)\/[^/]+$/);
  if (entity) return `/entities/${entity[1]}/:id`;
  if (/^(?:\/api)?\/transactions\/[^/]+\/(restore|settle)$/.test(path)) return path.replace(/\/transactions\/[^/]+\//, "/transactions/:id/");
  if (/^(?:\/api)?\/transactions\/[^/]+$/.test(path)) return path.replace(/\/transactions\/[^/]+$/, "/transactions/:id");
  if (/^\/api\/trips\/[^/]+\/members\/[^/]+$/.test(path)) return "/api/trips/:id/members/:id";
  if (/^\/api\/trips\/[^/]+\/(transactions|simplify)$/.test(path)) return path.replace(/\/trips\/[^/]+\//, "/trips/:id/");
  if (/^(?:\/api)?\/(recurring|templates)\/[^/]+(?:\/(process|skip))?$/.test(path)) return path.replace(/\/(recurring|templates)\/[^/]+/, "/$1/:id");
  return "unknown";
}

export function withRequestTiming(handler, { logger = console.info, random = Math.random, sampleRate, slowMilliseconds } = {}) {
  return (event, context) => requests.run({ phases: {} }, async () => {
    const started = performance.now();
    let response;
    let failed = false;
    try { response = await handler(event, context); return response; }
    catch (error) { failed = true; throw error; }
    finally {
      const elapsed = performance.now() - started;
      const rate = sampleRate ?? Number(process.env.PERFORMANCE_LOG_SAMPLE_RATE ?? 0.01);
      const slow = slowMilliseconds ?? Number(process.env.PERFORMANCE_SLOW_MS ?? 500);
      if (failed || elapsed >= slow || response?.statusCode >= 500 || random() < rate) {
        const request = requests.getStore();
        try { logger(JSON.stringify({
          event: "request_timing", route: routeLabel(event),
          method: ["GET", "POST", "PUT", "DELETE", "OPTIONS"].includes(event.requestContext?.http?.method || event.httpMethod) ? event.requestContext?.http?.method || event.httpMethod : "other",
          status: response?.statusCode ?? 500, durationMs: round(elapsed),
          ...(context?.awsRequestId ? { requestId: context.awsRequestId } : {}),
          phases: Object.fromEntries(Object.entries(request.phases).map(([phase, value]) => [phase, { totalMs: round(value.milliseconds), calls: value.calls, retries: value.retries }])),
        })); } catch { /* Diagnostic output must not change a response. */ }
      }
    }
  });
}
