// Only messages authored here may be returned before authentication. Never
// expose a database exception, environment value, or WebAuthn response.
export class PasskeyConfigurationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PasskeyConfigurationError";
  }
}

export type PasskeyStage =
  | "configuration"
  | "storage"
  | "options"
  | "verification";

export function passkeyFailure(error: unknown, stage: PasskeyStage) {
  if (error instanceof PasskeyConfigurationError) {
    return { status: 503, body: { error: error.message, code: error.code } };
  }
  if (stage === "storage") {
    return {
      status: 503,
      body: {
        error:
          "Passkey storage is unavailable. Retry, or check DATABASE_URL and database permissions in Vercel.",
        code: "passkey_storage_unavailable",
      },
    };
  }
  if (stage === "verification") {
    return {
      status: 400,
      body: {
        error: "Passkey verification failed. Please try again.",
        code: "passkey_verification_failed",
      },
    };
  }
  return {
    status: 503,
    body: {
      error:
        "Passkey sign-in is unavailable. Retry or check the Vercel function logs.",
      code: "passkey_unavailable",
    },
  };
}
