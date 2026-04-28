import { useState, useRef, type FormEvent } from "react";
import useAuthStore from "../stores/auth-store";
import { authenticate } from "../../../global/lib/auth";
import { SharedErrorHandler } from "../../../global/lib/error-handling";

interface Props {
  onAuthenticated: () => void;
}

export default function PasswordGate({ onAuthenticated }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { setPassword } = useAuthStore();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    setPassword(value);

    authenticate()
      .then(() => {
        onAuthenticated();
      })
      .catch((err) => {
        const errorCode = SharedErrorHandler.getErrorCode(err);
        // Surface raw server messages only in dev. The password gate renders
        // before auth, so production users could otherwise read DB hints
        // (DATABASE_URL, Neon endpoint, etc.) just by hitting the login form.
        const rawDetail =
          err instanceof Error && err.message && err.message !== errorCode
            ? err.message
            : null;
        const detail = import.meta.env.DEV ? rawDetail : null;
        switch (errorCode) {
          case "INVALID_CREDENTIALS": {
            setError("Wrong password");
            break;
          }
          case "INTERNAL_ERROR": {
            setError(
              detail
                ? `Server error: ${detail}`
                : "Server error. Check the dev console.",
            );
            break;
          }
          case "NETWORK_ERROR": {
            setError("Connection failed. Please check your network.");
            break;
          }
          case "UNKNOWN_ERROR": {
            setError(detail ? `Error: ${detail}` : "Unknown error occured.");
            break;
          }
        }
        if (rawDetail) console.error("PasswordGate auth failure:", rawDetail);
        setLoading(false);
        inputRef.current?.focus();
      });
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 w-80">
        <h2 className="m-0 text-xl">ChuMaiNichi</h2>
        <input
          ref={inputRef}
          type="password"
          placeholder="Dashboard password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          className="px-3 py-2 rounded-md border border-border bg-surface text-foreground text-sm
                     focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        {error && (
          <span className="text-destructive text-sm" role="alert">
            {error}
          </span>
        )}
        <button
          type="submit"
          disabled={loading || !value}
          className="py-2 px-4 rounded-md bg-accent text-white text-sm font-medium
                     hover:bg-accent-hover active:bg-[#7232d9]
                     disabled:opacity-50 disabled:cursor-not-allowed
                     focus:outline-none focus:ring-2 focus:ring-accent/30
                     transition-colors duration-150"
          style={loading ? { cursor: "wait" } : undefined}
        >
          {loading ? "Checking\u2026" : "Enter"}
        </button>
      </form>
    </div>
  );
}
