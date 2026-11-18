import { createPublicKey, verify } from "node:crypto";
import { ApiError, ensure } from "./errors.js";

const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
export class FirebaseKeyCache {
  constructor(fetcher = fetch, clock = Date.now) {
    this.fetcher = fetcher;
    this.clock = clock;
    this.keys = {};
    this.expires = 0;
    this.refreshAfter = 0;
    this.pending = undefined;
  }
  async get(kid) {
    const now = this.clock();
    const rotated =
      kid && !Object.hasOwn(this.keys, kid) && now >= this.refreshAfter;
    if (this.expires > now && !rotated) return this.keys;
    if (!this.pending)
      this.pending = (async () => {
        // Unknown key IDs can refresh a warm cache once a minute. This handles
        // Google's key rotation without allowing arbitrary tokens to flood it.
        this.refreshAfter = this.clock() + 60000;
        try {
          const response = await this.fetcher(CERT_URL, {
            signal: AbortSignal.timeout(6000),
          });
          if (!response.ok) throw new Error("Certificate request failed");
          const certificates = await response.json(),
            keys = {};
          for (const [id, pem] of Object.entries(certificates))
            keys[id] = createPublicKey(pem);
          ensure(
            Object.keys(keys).length,
            "No signing keys were returned.",
            503,
            "AUTH_UNAVAILABLE",
          );
          const ttl = Number(
            response.headers
              .get("cache-control")
              ?.match(/max-age=(\d+)/)?.[1] || 300,
          );
          this.keys = keys;
          this.expires = this.clock() + Math.min(ttl, 21600) * 1000;
          return keys;
        } catch {
          throw new ApiError(
            503,
            "Authentication verification is temporarily unavailable.",
            "AUTH_UNAVAILABLE",
          );
        }
      })().finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
const signingKeys = new FirebaseKeyCache();

export function validateFirebaseToken(
  token,
  projectId,
  keys,
  now = Math.floor(Date.now() / 1000),
) {
  try {
    ensure(
      typeof token === "string" && token.length < 16000,
      "A valid Firebase session is required.",
      401,
      "UNAUTHENTICATED",
    );
    const parts = token.split(".");
    ensure(
      parts.length === 3,
      "Invalid session token.",
      401,
      "UNAUTHENTICATED",
    );
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString()),
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    ensure(
      header.alg === "RS256" &&
        typeof header.kid === "string" &&
        keys[header.kid],
      "Invalid session signature.",
      401,
      "UNAUTHENTICATED",
    );
    ensure(
      verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        keys[header.kid],
        Buffer.from(parts[2], "base64url"),
      ),
      "Invalid session signature.",
      401,
      "UNAUTHENTICATED",
    );
    ensure(
      claims.aud === projectId &&
        claims.iss === `https://securetoken.google.com/${projectId}`,
      "This session belongs to another project.",
      401,
      "UNAUTHENTICATED",
    );
    ensure(
      typeof claims.sub === "string" &&
        claims.sub.length > 0 &&
        claims.sub.length <= 128,
      "Invalid session user.",
      401,
      "UNAUTHENTICATED",
    );
    ensure(
      Number.isInteger(claims.exp) &&
        claims.exp > now &&
        Number.isInteger(claims.iat) &&
        claims.iat <= now + 30 &&
        Number.isInteger(claims.auth_time) &&
        claims.auth_time <= now + 30,
      "Session expired. Please sign in again.",
      401,
      "UNAUTHENTICATED",
    );
    return { ...claims, uid: claims.sub };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "Invalid session token.", "UNAUTHENTICATED");
  }
}

export async function authenticate(event) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  ensure(
    projectId,
    "Firebase authentication is not configured.",
    503,
    "AUTH_UNAVAILABLE",
  );
  const authorization =
    Object.entries(event.headers || {}).find(
      ([name]) => name.toLowerCase() === "authorization",
    )?.[1] || "";
  ensure(
    /^Bearer\s+\S+$/i.test(authorization),
    "Please sign in to continue.",
    401,
    "UNAUTHENTICATED",
  );
  const token = authorization.replace(/^Bearer\s+/i, "");
  let header;
  try {
    ensure(
      token.length < 16000 && token.split(".").length === 3,
      "Invalid session token.",
      401,
      "UNAUTHENTICATED",
    );
    header = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString(),
    );
  } catch {
    throw new ApiError(401, "Invalid session token.", "UNAUTHENTICATED");
  }
  ensure(
    header.alg === "RS256" &&
      typeof header.kid === "string" &&
      header.kid.length <= 200,
    "Invalid session signature.",
    401,
    "UNAUTHENTICATED",
  );
  return validateFirebaseToken(
    token,
    projectId,
    await signingKeys.get(header.kid),
  );
}
