import { useEffect, useState, type FormEvent } from "react";
import { Fingerprint } from "lucide-react";
import {
  passkeyError,
  passkeySetup,
  registerPasskey,
  signInWithPasskey,
} from "../../../global/lib/passkey";

export default function PasskeyGate({
  onAuthenticated,
}: {
  onAuthenticated: () => void;
}) {
  const [setup, setSetup] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const supported =
    typeof PublicKeyCredential !== "undefined" && window.isSecureContext;
  async function loadSetup() {
    setError("");
    try {
      setSetup(await passkeySetup());
    } catch (err) {
      setError(passkeyError(err));
    }
  }
  useEffect(() => {
    void passkeySetup()
      .then(setSetup)
      .catch((err) => setError(passkeyError(err)));
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (setup) await registerPasskey(password);
      else await signInWithPasskey();
      setPassword("");
      onAuthenticated();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center justify-center min-h-screen px-6">
      <form onSubmit={submit} className="flex flex-col gap-3 w-80">
        <Fingerprint size={32} aria-hidden="true" />
        <h2 className="m-0 text-xl">ChuMaiNichi</h2>
        <p className="text-sm text-muted-foreground">
          {setup
            ? "Create your first Passkey using your dashboard password. Future sign-ins use your fingerprint, face or device PIN."
            : "Sign in with your Passkey using your fingerprint, face or device PIN."}
        </p>
        {setup && (
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Current dashboard password"
            aria-label="Current dashboard password"
            autoComplete="current-password"
            required
            className="px-3 py-2 rounded-md border border-border bg-surface text-foreground text-sm"
          />
        )}
        {!supported && (
          <p role="alert" className="text-destructive text-sm">
            Passkeys require a supported browser and a secure connection. Open
            this dashboard in Safari, Chrome, Edge or Firefox over HTTPS.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {setup === null && !error && (
          <p role="status" className="text-sm">
            Checking sign-in options…
          </p>
        )}
        {setup === null ? (
          error && (
            <button type="button" className="quiet-btn" onClick={loadSetup}>
              Retry sign-in setup
            </button>
          )
        ) : (
          <button
            type="submit"
            disabled={busy || !supported || (setup && !password)}
            aria-busy={busy}
            className="py-2 px-4 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            {busy
              ? "Waiting for your device…"
              : setup
                ? "Create Passkey"
                : "Sign in with Passkey"}
          </button>
        )}
      </form>
    </div>
  );
}
