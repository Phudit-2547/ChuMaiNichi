import { afterEach, describe, expect, it, vi } from "vitest";
import { passkeyFailure } from "./passkey-errors";
import { passkeyStore } from "./passkey-store";

afterEach(() => vi.unstubAllEnvs());

describe("Passkey startup errors", () => {
  it("identifies a missing database URL without connecting", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(() => passkeyStore()).toThrow(
      expect.objectContaining({ code: "passkey_database_url_missing" }),
    );
  });
  it("treats rejected WebAuthn assertions as verification failures", () => {
    expect(
      passkeyFailure(new Error("private credential contents"), "verification"),
    ).toEqual({
      status: 400,
      body: {
        code: "passkey_verification_failed",
        error: "Passkey verification failed. Please try again.",
      },
    });
  });
});
