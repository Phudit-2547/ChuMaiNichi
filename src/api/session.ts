import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PasskeyConfigurationError } from "./passkey-errors.js";

export const SESSION_SECONDS = 12 * 60 * 60;
export function passkeysEnabled() {
  return Boolean(process.env.PASSKEY_ORIGIN || process.env.SESSION_SECRET);
}
export function authConfig() {
  const rawOrigin = process.env.PASSKEY_ORIGIN?.trim();
  if (!rawOrigin) {
    throw new PasskeyConfigurationError(
      "passkey_origin_missing",
      "Set PASSKEY_ORIGIN to this dashboard's HTTPS URL in Vercel Production, then redeploy.",
    );
  }
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new PasskeyConfigurationError(
      "passkey_origin_invalid",
      "PASSKEY_ORIGIN must be a complete HTTPS URL. Update it in Vercel Production, then redeploy.",
    );
  }
  // Copying a root URL from the address bar commonly includes a trailing slash.
  // Normalize it without accepting paths, credentials, query strings or hashes.
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "localhost"))
  ) {
    throw new PasskeyConfigurationError(
      "passkey_origin_invalid",
      "PASSKEY_ORIGIN must be an HTTPS origin without a path, query or fragment. Update it in Vercel Production, then redeploy.",
    );
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret || !secret.trim()) {
    throw new PasskeyConfigurationError(
      "passkey_session_secret_missing",
      "Set SESSION_SECRET in Vercel Production to the output of openssl rand -hex 32, then redeploy.",
    );
  }
  if (Buffer.byteLength(secret.trim()) < 32) {
    throw new PasskeyConfigurationError(
      "passkey_session_secret_invalid",
      "SESSION_SECRET is too short. Save the output of openssl rand -hex 32 in Vercel Production, then redeploy.",
    );
  }
  return {
    origin: origin.origin,
    rpID: origin.hostname,
    secure: origin.protocol === "https:",
    secret,
  };
}
export function cookieName(kind: "session" | "challenge") {
  return `${authConfig().secure ? "__Host-" : ""}chumainichi-${kind}`;
}
export function readCookie(header: string | undefined, name: string) {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
export function signToken(kind: string, value: string, seconds: number) {
  const payload = Buffer.from(
    JSON.stringify({ kind, value, exp: Date.now() + seconds * 1000 }),
  ).toString("base64url");
  const signature = createHmac("sha256", authConfig().secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}
export function verifyToken(
  token: string | undefined,
  kind: string,
): string | null {
  try {
    if (!token || token.length > 2048) return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", authConfig().secret)
      .update(payload)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.kind === kind &&
      typeof data.value === "string" &&
      typeof data.exp === "number" &&
      data.exp > Date.now()
      ? data.value
      : null;
  } catch {
    return null;
  }
}
export function hasSession(cookie: string | undefined, origin?: string) {
  try {
    if (origin && origin !== authConfig().origin) return false;
    return Boolean(
      verifyToken(readCookie(cookie, cookieName("session")), "session"),
    );
  } catch {
    return false;
  }
}
export function authCookie(
  kind: "session" | "challenge",
  value: string,
  seconds: number,
) {
  return `${cookieName(kind)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${authConfig().secure ? "; Secure" : ""}`;
}
export function newSessionCookie() {
  return authCookie(
    "session",
    signToken(
      "session",
      randomBytes(32).toString("base64url"),
      SESSION_SECONDS,
    ),
    SESSION_SECONDS,
  );
}
