import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";

async function request(action?: string, data: Record<string, unknown> = {}) {
  const res = await fetch(
    "/api/passkey",
    action
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...data }),
        }
      : { cache: "no-store" },
  );
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Passkey request failed");
  return body;
}
export async function passkeySetup(): Promise<boolean> {
  return (await request()).setup;
}
export async function registerPasskey(password?: string) {
  const optionsJSON = await request("register-options", { password });
  const response = await startRegistration({ optionsJSON });
  await request("register-verify", { response });
}
export async function signInWithPasskey() {
  const optionsJSON = await request("login-options");
  const response = await startAuthentication({ optionsJSON });
  await request("login-verify", { response });
}
export async function signOut() {
  await request("logout");
}
export function passkeyError(error: unknown) {
  if (error instanceof Error && error.name === "NotAllowedError")
    return "Passkey request was cancelled or timed out. Try again.";
  if (error instanceof Error && error.name === "InvalidStateError")
    return "This device already has a Passkey. Try signing in.";
  return error instanceof Error
    ? error.message
    : "Passkey request failed. Retry.";
}
