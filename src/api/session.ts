import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_SECONDS = 12 * 60 * 60;
export function passkeysEnabled() {
  return Boolean(process.env.PASSKEY_ORIGIN || process.env.SESSION_SECRET);
}
export function authConfig() {
  const origin = new URL(process.env.PASSKEY_ORIGIN ?? "");
  const secret = process.env.SESSION_SECRET;
  if (
    !secret ||
    Buffer.byteLength(secret) < 32 ||
    origin.origin !== process.env.PASSKEY_ORIGIN ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "localhost"))
  ) {
    throw new Error("Invalid Passkey configuration");
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
