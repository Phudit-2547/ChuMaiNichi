import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAuth } from "./auth";
import {
  authConfig,
  hasSession,
  newSessionCookie,
  signToken,
  verifyToken,
} from "./session";
import { privateSqlBoundaryError } from "./query/security";

beforeEach(() => {
  vi.stubEnv("PASSKEY_ORIGIN", "https://dashboard.example.com");
  vi.stubEnv("SESSION_SECRET", "a".repeat(64));
  vi.stubEnv("DASHBOARD_PASSWORD", "old-password");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("Passkey sessions", () => {
  it("rejects the legacy password once Passkeys are configured", () => {
    expect(checkAuth("Bearer old-password", "old-password")).toBe(false);
  });
  it("accepts a signed cookie and includes production cookie protections", () => {
    const cookie = newSessionCookie();
    expect(cookie).toContain("__Host-chumainichi-session=");
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    expect(cookie).toContain("; Secure");
    expect(hasSession(cookie)).toBe(true);
    expect(hasSession(cookie, "https://evil.example.com")).toBe(false);
  });
  it("rejects forged, expired and wrong-purpose cookies", () => {
    vi.useFakeTimers();
    const token = signToken("session", "value", 5);
    expect(verifyToken(token + "x", "session")).toBeNull();
    expect(verifyToken(token, "challenge")).toBeNull();
    vi.advanceTimersByTime(6000);
    expect(verifyToken(token, "session")).toBeNull();
  });
  it("invalidates sessions when the signing secret rotates", () => {
    const cookie = newSessionCookie();
    vi.stubEnv("SESSION_SECRET", "b".repeat(64));
    expect(hasSession(cookie)).toBe(false);
  });
  it("fails closed for partial or insecure configuration", () => {
    vi.stubEnv("SESSION_SECRET", "short");
    expect(checkAuth("Bearer old-password", "old-password")).toBe(false);
    expect(() => authConfig()).toThrow();
    vi.stubEnv("SESSION_SECRET", "a".repeat(64));
    vi.stubEnv("PASSKEY_ORIGIN", "http://dashboard.example.com");
    expect(() => authConfig()).toThrow();
  });
  it("protects authentication state from analytics and AI queries", () => {
    for (const table of [
      "dashboard_passkeys",
      "dashboard_auth_challenges",
      "dashboard_auth_attempts",
    ]) {
      expect(privateSqlBoundaryError(`SELECT * FROM ${table}`)).toBeTruthy();
    }
  });
});
