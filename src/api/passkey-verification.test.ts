import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";

// Exercise the real verifier with a signed ES256 WebAuthn assertion, including
// user-presence/user-verification flags and the RP-ID hash (no verifier mocks).
function assertion(origin = "https://dashboard.example.com", flags = 5) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const coseKey = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(jwk.y!, "base64url"),
  ]);
  const authData = Buffer.concat([
    createHash("sha256").update("dashboard.example.com").digest(),
    Buffer.from([flags, 0, 0, 0, 1]),
  ]);
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: "challenge",
      origin,
      crossOrigin: false,
    }),
  );
  const signature = sign(
    "sha256",
    Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
    privateKey,
  );
  const id = Buffer.from("credential-id").toString("base64url");
  return {
    credential: { id, publicKey: new Uint8Array(coseKey), counter: 0 },
    response: {
      id,
      rawId: id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
      },
    },
    expectedChallenge: "challenge",
    expectedOrigin: "https://dashboard.example.com",
    expectedRPID: "dashboard.example.com",
    requireUserVerification: true,
  };
}
describe("real WebAuthn signature verification", () => {
  it("verifies a valid device assertion", async () => {
    const result = await verifyAuthenticationResponse(assertion());
    expect(result.verified).toBe(true);
    expect(result.authenticationInfo.newCounter).toBe(1);
  });
  it("rejects a signature from a different private key", async () => {
    const input = assertion();
    input.response.response.signature = assertion().response.response.signature;
    expect((await verifyAuthenticationResponse(input)).verified).toBe(false);
  });
  it("rejects a wrong origin and missing user verification", async () => {
    await expect(
      verifyAuthenticationResponse(assertion("https://evil.example.com")),
    ).rejects.toThrow();
    await expect(
      verifyAuthenticationResponse(assertion(undefined, 1)),
    ).rejects.toThrow();
  });
  it("rejects a wrong challenge and RP ID", async () => {
    await expect(
      verifyAuthenticationResponse({
        ...assertion(),
        expectedChallenge: "other",
      }),
    ).rejects.toThrow();
    await expect(
      verifyAuthenticationResponse({
        ...assertion(),
        expectedRPID: "other.example.com",
      }),
    ).rejects.toThrow();
  });
});
