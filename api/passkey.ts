import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  authConfig,
  authCookie,
  cookieName,
  hasSession,
  newSessionCookie,
  readCookie,
  signToken,
  verifyToken,
} from "../src/api/session.js";
import { passkeyStore } from "../src/api/passkey-store.js";
import {
  passkeyFailure,
  type PasskeyStage,
} from "../src/api/passkey-errors.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET" && req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });
  let stage: PasskeyStage = "configuration";
  try {
    const config = authConfig();
    if (req.method === "POST" && req.headers.origin !== config.origin)
      return res.status(403).json({ error: "Invalid origin" });
    const body = req.body ?? {};
    if (req.method === "POST" && body.action === "logout") {
      res.setHeader("Set-Cookie", [
        authCookie("session", "", 0),
        authCookie("challenge", "", 0),
      ]);
      return res.status(200).json({ ok: true });
    }
    stage = "storage";
    const store = passkeyStore();
    await store.init();
    const credentials = await store.credentials();
    if (req.method === "GET")
      return res.status(200).json({ setup: credentials.length === 0 });
    const authed = hasSession(req.headers.cookie, req.headers.origin);
    if (!authed && !(await store.rateLimit("sign-in", 60)))
      return res
        .status(429)
        .json({ error: "Too many sign-in attempts. Retry in a minute." });
    const register =
      body.action === "register-options" || body.action === "register-verify";
    const bootstrap = register && credentials.length === 0;
    if (body.action === "register-options" || body.action === "login-options") {
      if (register) {
        if (!authed) {
          if (!bootstrap)
            return res
              .status(401)
              .json({ error: "Sign in before adding a Passkey" });
          if (!(await store.rateLimit("bootstrap")))
            return res
              .status(429)
              .json({ error: "Too many setup attempts. Retry in a minute." });
          // Explicit comparison without the session-aware migration wrapper.
          const password = process.env.DASHBOARD_PASSWORD;
          if (
            !password ||
            typeof body.password !== "string" ||
            !checkBootstrapPassword(body.password, password)
          )
            return res
              .status(401)
              .json({ error: "Setup password does not match" });
        }
      } else if (credentials.length === 0)
        return res.status(409).json({ error: "Create your first Passkey" });
      stage = "options";
      const options = register
        ? await generateRegistrationOptions({
            rpName: "ChuMaiNichi",
            rpID: config.rpID,
            userName: "dashboard",
            userID: new TextEncoder().encode("chumainichi-dashboard"),
            attestationType: "none",
            excludeCredentials: credentials.map(({ id, transports }) => ({
              id,
              transports,
            })),
            authenticatorSelection: {
              residentKey: "required",
              userVerification: "required",
            },
          })
        : await generateAuthenticationOptions({
            rpID: config.rpID,
            userVerification: "required",
          });
      const id = randomBytes(32).toString("base64url");
      stage = "storage";
      await store.challenge(id, {
        challenge: options.challenge,
        purpose: register ? "register" : "login",
        bootstrap,
      });
      res.setHeader(
        "Set-Cookie",
        authCookie("challenge", signToken("challenge", id, 300), 300),
      );
      return res.status(200).json(options);
    }
    if (body.action !== "register-verify" && body.action !== "login-verify")
      return res.status(400).json({ error: "Invalid action" });
    const id = verifyToken(
      readCookie(req.headers.cookie, cookieName("challenge")),
      "challenge",
    );
    const challenge = id ? await store.consume(id) : null;
    if (!challenge || challenge.purpose !== (register ? "register" : "login"))
      return res.status(400).json({ error: "Passkey request expired. Retry." });
    if (register) {
      if (!challenge.bootstrap && !authed)
        return res
          .status(401)
          .json({ error: "Sign in before adding a Passkey" });
      stage = "verification";
      const result = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo)
        return res.status(401).json({ error: "Passkey verification failed" });
      const credential = result.registrationInfo.credential;
      stage = "storage";
      if (
        !(await store.register(
          {
            ...credential,
            publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          },
          challenge.bootstrap,
        ))
      )
        return res
          .status(409)
          .json({ error: "Passkey setup changed. Sign in and retry." });
    } else {
      const credential = credentials.find(
        (item) => item.id === body.response?.id,
      );
      if (!credential)
        return res.status(401).json({ error: "Passkey not recognized" });
      stage = "verification";
      const result = await verifyAuthenticationResponse({
        response: body.response,
        credential: {
          ...credential,
          publicKey: new Uint8Array(
            Buffer.from(credential.publicKey, "base64url"),
          ),
        },
        expectedChallenge: challenge.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        requireUserVerification: true,
      });
      stage = "storage";
      if (
        !result.verified ||
        !(await store.counter(
          credential.id,
          credential.counter,
          result.authenticationInfo.newCounter,
        ))
      )
        return res
          .status(401)
          .json({ error: "Passkey verification failed. Retry." });
    }
    res.setHeader("Set-Cookie", [
      newSessionCookie(),
      authCookie("challenge", "", 0),
    ]);
    return res.status(200).json({ ok: true });
  } catch (error) {
    const failure = passkeyFailure(error, stage);
    // Do not log raw exception messages: driver errors can contain credentials.
    console.error("passkey request failed", { stage, code: failure.body.code });
    return res.status(failure.status).json(failure.body);
  }
}

function checkBootstrapPassword(actual: string, expected: string) {
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
