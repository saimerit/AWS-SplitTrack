import crypto from "node:crypto";
import { authenticate } from "./firebaseAuth.js";
import { ApiError, ensure } from "./errors.js";
import { repository } from "./awsRepository.js";
import { SplitTrackService } from "./service.js";
import { MediaService } from "./media.js";
import { extractStatementPdf } from "./statementPdf.js";

const media = new MediaService(),
  service = new SplitTrackService(repository, media);
const headers = {
  "content-type": "application/json",
  "access-control-allow-origin": process.env.CORS_ORIGIN || "*",
  "access-control-allow-headers":
    "content-type,authorization,idempotency-key,x-admin-key",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "cache-control": "no-store",
};
export const response = (body, statusCode = 200) => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});
const header = (event, name) =>
  Object.entries(event.headers || {}).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
function parse(event) {
  if (!event.body) return {};
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString()
    : event.body;
  ensure(
    Buffer.byteLength(typeof text === "string" ? text : JSON.stringify(text)) <=
      7 * 1024 * 1024,
    "Request is too large.",
    413,
  );
  try {
    return typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}
const admin = (event) => {
  const expected = process.env.ADMIN_API_KEY,
    provided = header(event, "x-admin-key");
  ensure(
    expected &&
      typeof provided === "string" &&
      Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected)),
    "Admin authentication is required.",
    403,
  );
};

export function createHandler(
  app = service,
  verifyAuth = authenticate,
  repo = repository,
) {
  return async (event) => {
    try {
      const method =
          event.requestContext?.http?.method || event.httpMethod || "GET",
        path = (event.rawPath || event.path || "").replace(/\/+$/, "") || "/",
        query = event.queryStringParameters || {};
      if (method === "OPTIONS") return response({ ok: true });
      if ((path === "/health" || path === "/api/health") && method === "GET")
        return response({
          status: "ok",
          service: "splittrack-backend",
          version: "2.0.0",
          authentication: "firebase",
          database: "dynamodb",
        });
      if (path === "/changelog" && method === "GET")
        return response(
          (await repo.releases()).map((release) => ({
            ...release,
            version: release.version || release.releaseId,
            message: release.message || release.title || "",
            notes: Array.isArray(release.notes)
              ? release.notes
              : String(release.notes || "")
                  .split("\n")
                  .filter(Boolean),
          })),
        );
      if (path === "/admin/changelog" && method === "POST") {
        admin(event);
        const body = parse(event),
          releaseId = body.releaseId || body.version;
        ensure(
          typeof releaseId === "string" && releaseId.length < 80,
          "A release version is required.",
        );
        const notes = Array.isArray(body.notes)
          ? body.notes.map((note) => String(note).slice(0, 1000)).slice(0, 100)
          : String(body.notes || "")
              .slice(0, 10000)
              .split("\n")
              .filter(Boolean);
        await repo.transact([
          {
            type: "put",
            table: "changelog",
            item: {
              releaseId,
              version: releaseId,
              publishedAt: new Date().toISOString(),
              message: String(body.message || body.title || "").slice(0, 200),
              notes,
            },
          },
        ]);
        return response({ published: true }, 201);
      }
      const auth = await verifyAuth(event),
        requestId = header(event, "idempotency-key");
      if (path === "/api/import/statement/pdf" && method === "POST")
        return response(await extractStatementPdf(parse(event).base64));
      if (["/auth/signup", "/auth/signin", "/auth/google"].includes(path))
        throw new ApiError(
          410,
          "Sign in through Firebase Authentication in the app.",
        );
      if ((path === "/auth/me" || path === "/api/profile") && method === "GET")
        return response(await app.profile(auth));
      if (path === "/api/profile" && method === "PUT")
        return response(await app.updateProfile(auth, requestId, parse(event)));
      if (path === "/api/users/username" && method === "GET")
        return response(await app.usernameAvailable(query.value, auth.uid));
      if (path === "/api/users/search" && method === "GET")
        return response({ items: await app.search(query.q, auth.uid) });
      if (path === "/api/media" && method === "POST")
        return response(
          await app.media.upload(auth.uid, parse(event).data),
          201,
        );
      if (path === "/api/settings" && method === "PUT")
        return response(await app.settings(auth, requestId, parse(event)));
      if (path === "/api/analytics" && method === "GET")
        return response(await app.analytics(auth, query));
      if (path === "/state" && method === "GET") {
        if (query.after !== undefined) return response(await app.sync(auth.uid, query.after));
        await app.bootstrap(auth);
        return response(await app.snapshot(auth.uid));
      }
      if (
        (path === "/state/erase" && method === "POST") ||
        (path === "/state" && method === "DELETE")
      )
        return response(await app.erase(auth, requestId));
      if (path === "/state" && ["POST", "PUT"].includes(method))
        throw new ApiError(
          405,
          "Use typed mutation endpoints; financial state cannot be overwritten.",
        );
      const entity = path.match(/^\/entities\/([a-z]+)\/([^/]+)$/);
      if (entity) {
        const [, type, id] = entity;
        if (method === "PUT")
          return response(
            await app.saveEntity(
              auth,
              requestId,
              type,
              decodeURIComponent(id),
              parse(event),
            ),
          );
        if (method === "DELETE")
          return response(
            await app.deleteEntity(
              auth,
              requestId,
              type,
              decodeURIComponent(id),
            ),
          );
      }
      if (
        (path === "/transactions" || path === "/api/transactions") &&
        method === "GET"
      )
        return response(
          await app.history(auth.uid, {
            cursor: query.cursor,
            limit: query.limit,
          }),
        );
      if (
        (path === "/transactions" || path === "/api/transactions") &&
        method === "POST"
      ) {
        const body = parse(event);
        return response(
          await app.transaction(auth, requestId, body.transaction || body),
          201,
        );
      }
      if (path === "/transactions/batch" && method === "POST") {
        const body = parse(event),
          list = Array.isArray(body) ? body : body.transactions;
        ensure(
          Array.isArray(list) && list.length > 0 && list.length <= 50,
          "Import 1–50 transactions at a time.",
        );
        ensure(
          typeof requestId === "string" &&
            /^[A-Za-z0-9_-]{12,80}$/.test(requestId),
          "An idempotency-key is required.",
        );
        let importedCount = 0;
        for (const transaction of list) {
          await app.transaction(
            auth,
            `${requestId}_${importedCount}`,
            transaction,
          );
          importedCount++;
        }
        return response(
          { result: { importedCount }, state: await app.snapshot(auth.uid) },
          201,
        );
      }
      if ((path === "/transactions/bin" || path === "/api/transactions/bin") && method === "GET") return response(await app.transactionBin(auth));
      const restore = path.match(/^(?:\/api)?\/transactions\/([^/]+)\/restore$/);
      if (restore && method === "POST") return response(await app.restoreTransaction(auth, requestId, decodeURIComponent(restore[1])));
      const transactionSettlement = path.match(/^(?:\/api)?\/transactions\/([^/]+)\/settle$/);
      if (transactionSettlement && method === "POST") return response(await app.settle(auth, requestId, { ...parse(event), transactionId: decodeURIComponent(transactionSettlement[1]) }), 201);
      const transaction = path.match(/^(?:\/api)?\/transactions\/([^/]+)$/);
      if (transaction) {
        const id = decodeURIComponent(transaction[1]);
        if (method === "GET")
          return response(await app.getTransaction(auth, id));
        if (method === "DELETE")
          return response(await app.deleteTransaction(auth, requestId, id));
        if (method === "PUT") return response(await app.editTransaction(auth, requestId, id, parse(event)));
      }
      if (path === "/api/settlements" && method === "POST")
        return response(await app.settle(auth, requestId, parse(event)), 201);
      const members = path.match(/^\/api\/trips\/([^/]+)\/members\/([^/]+)$/);
      if (members && ["PUT", "DELETE"].includes(method))
        return response(
          await app.member(
            auth,
            requestId,
            decodeURIComponent(members[1]),
            decodeURIComponent(members[2]),
            method === "DELETE",
          ),
        );
      const tripHistory = path.match(/^\/api\/trips\/([^/]+)\/transactions$/);
      if (tripHistory && method === "GET")
        return response(
          await app.tripHistory(auth, decodeURIComponent(tripHistory[1]), {
            cursor: query.cursor,
            limit: query.limit,
          }),
        );
      const collection = path.match(
        /^(?:\/api)?\/(recurring|templates)(?:\/(due))?$/,
      );
      if (collection) {
        const type = collection[1];
        if (method === "GET")
          return response(
            await app.records(auth, type, {
              due: Boolean(collection[2]),
              cursor: query.cursor,
            }),
          );
        if (method === "POST" && !collection[2])
          return response(
            await app.saveEntity(
              auth,
              requestId,
              type,
              `${type}-${crypto.createHash("sha256").update(`${auth.uid}:${requestId}`).digest("hex").slice(0, 32)}`,
              parse(event),
            ),
            201,
          );
      }
      const record = path.match(
        /^(?:\/api)?\/(recurring|templates)\/([^/]+)(?:\/(process|skip))?$/,
      );
      if (record) {
        const [, type, id, operation] = record;
        if (
          type === "recurring" &&
          operation === "process" &&
          method === "POST"
        )
          return response(await app.processRecurring(auth, id));
        if (type === "recurring" && operation === "skip" && method === "POST")
          return response(await app.skipRecurring(auth, requestId, id));
        if (!operation && method === "PUT")
          return response(
            await app.saveEntity(auth, requestId, type, id, parse(event)),
          );
        if (!operation && method === "DELETE")
          return response(await app.deleteEntity(auth, requestId, type, id));
      }
      throw new ApiError(404, "Endpoint not found.");
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      if (status === 500)
        console.error(
          JSON.stringify({
            event: "request_failed",
            code: error.name || "Error",
            requestId: event.requestContext?.requestId,
          }),
        );
      return response(
        {
          message:
            status === 500
              ? "The request could not be completed. Please retry."
              : error.message,
          code: error.code || "INTERNAL_ERROR",
          ...(status !== 500 && error.details ? { details: error.details } : {}),
        },
        status,
      );
    }
  };
}
export const handler = createHandler();
