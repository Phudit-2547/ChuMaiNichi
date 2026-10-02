import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { newSessionCookie, signToken } from "../src/api/session";
const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  credentials: vi.fn(),
  rateLimit: vi.fn(),
  challenge: vi.fn(),
  consume: vi.fn(),
  register: vi.fn(),
  counter: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));
vi.mock("../src/api/passkey-store.js", () => ({ passkeyStore: () => mocks }));
vi.mock("@simplewebauthn/server", () => mocks);
import handler from "./passkey";
function request(
  action: string,
  extra = {},
  cookie?: string,
  origin = "https://dashboard.example.com",
) {
  return {
    method: "POST",
    headers: { origin, cookie },
    body: { action, ...extra },
  } as VercelRequest;
}
function response() {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}
function challengeCookie() {
  return `__Host-chumainichi-challenge=${signToken("challenge", "nonce", 300)}`;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PASSKEY_ORIGIN", "https://dashboard.example.com");
  vi.stubEnv("SESSION_SECRET", "a".repeat(64));
  vi.stubEnv("DASHBOARD_PASSWORD", "old-password");
  mocks.credentials.mockResolvedValue([]);
  mocks.rateLimit.mockResolvedValue(true);
  mocks.generateRegistrationOptions.mockResolvedValue({
    challenge: "challenge",
  });
  mocks.generateAuthenticationOptions.mockResolvedValue({
    challenge: "challenge",
  });
  mocks.register.mockResolvedValue(true);
  mocks.counter.mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("Passkey endpoints", () => {
  it("loads first-enrollment status when a copied URL ends with a slash", async () => {
    vi.stubEnv("PASSKEY_ORIGIN", "https://dashboard.example.com/\n");
    const res = response();
    await handler({ method: "GET", headers: {} } as VercelRequest, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ setup: true });
  });
  it.each([
    ["PASSKEY_ORIGIN", "", "passkey_origin_missing"],
    ["PASSKEY_ORIGIN", "invalid://private-value", "passkey_origin_invalid"],
    ["SESSION_SECRET", "", "passkey_session_secret_missing"],
    ["SESSION_SECRET", "private-value", "passkey_session_secret_invalid"],
  ])(
    "identifies %s configuration failures without leaking values",
    async (name, value, code) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv(name, value);
      const res = response();
      await handler({ method: "GET", headers: {} } as VercelRequest, res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining(name),
        code,
      });
      expect(mocks.init).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain(
        "private-value",
      );
      expect(log).toHaveBeenCalledWith("passkey request failed", {
        stage: "configuration",
        code,
      });
    },
  );
  it("reports database failures without exposing connection strings in responses or logs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.init.mockRejectedValue(
      new Error("postgres://private-password@private-host/database"),
    );
    const res = response();
    await handler({ method: "GET", headers: {} } as VercelRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.stringContaining("storage"),
      code: "passkey_storage_unavailable",
    });
    expect(
      JSON.stringify([vi.mocked(res.json).mock.calls, log.mock.calls]),
    ).not.toContain("private-password");
    expect(log).toHaveBeenCalledWith("passkey request failed", {
      stage: "storage",
      code: "passkey_storage_unavailable",
    });
  });
  it("rejects cross-origin setup before touching storage", async () => {
    const res = response();
    await handler(
      request("register-options", {}, undefined, "https://evil.example.com"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mocks.init).not.toHaveBeenCalled();
  });
  it("requires the old password only for first registration", async () => {
    const res = response();
    await handler(request("register-options", { password: "wrong" }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mocks.challenge).not.toHaveBeenCalled();
    await handler(
      request("register-options", { password: "old-password" }),
      response(),
    );
    expect(mocks.challenge).toHaveBeenCalledWith(expect.any(String), {
      challenge: "challenge",
      purpose: "register",
      bootstrap: true,
    });
  });
  it("throttles setup password guesses", async () => {
    mocks.rateLimit.mockResolvedValue(false);
    const res = response();
    await handler(
      request("register-options", { password: "old-password" }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(429);
  });
  it("rejects password-based registration after setup", async () => {
    mocks.credentials.mockResolvedValue([{ id: "existing" }]);
    const res = response();
    await handler(
      request("register-options", { password: "old-password" }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });
  it("permits backup registration with a valid session", async () => {
    mocks.credentials.mockResolvedValue([{ id: "existing" }]);
    const res = response();
    await handler(request("register-options", {}, newSessionCookie()), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
      }),
    );
  });
  it("rejects replayed or expired challenges", async () => {
    mocks.consume.mockResolvedValue(null);
    const res = response();
    await handler(request("login-verify", {}, challengeCookie()), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });
  it("binds challenge purpose", async () => {
    mocks.consume.mockResolvedValue({
      purpose: "register",
      challenge: "challenge",
      bootstrap: true,
    });
    const res = response();
    await handler(request("login-verify", {}, challengeCookie()), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
  it("does not grant a session when concurrent bootstrap registration loses", async () => {
    mocks.consume.mockResolvedValue({
      purpose: "register",
      challenge: "challenge",
      bootstrap: true,
    });
    mocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: "key", publicKey: new Uint8Array([1]), counter: 0 },
      },
    });
    mocks.register.mockResolvedValue(false);
    const res = response();
    await handler(
      request("register-verify", { response: {} }, challengeCookie()),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.setHeader).not.toHaveBeenCalledWith(
      "Set-Cookie",
      expect.anything(),
    );
  });
  it("verifies origin, RP and user verification before issuing a session", async () => {
    mocks.credentials.mockResolvedValue([
      { id: "key", publicKey: "AQ", counter: 0 },
    ]);
    mocks.consume.mockResolvedValue({
      purpose: "login",
      challenge: "challenge",
    });
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });
    const res = response();
    await handler(
      request("login-verify", { response: { id: "key" } }, challengeCookie()),
      res,
    );
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "challenge",
        expectedOrigin: "https://dashboard.example.com",
        expectedRPID: "dashboard.example.com",
        requireUserVerification: true,
      }),
    );
    expect(mocks.counter).toHaveBeenCalledWith("key", 0, 1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.arrayContaining([
        expect.stringContaining("__Host-chumainichi-session="),
      ]),
    );
  });
  it("clears session cookies on sign-out without a database dependency", async () => {
    const res = response();
    await handler(request("logout"), res);
    expect(mocks.init).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.arrayContaining([expect.stringContaining("Max-Age=0")]),
    );
  });
});
