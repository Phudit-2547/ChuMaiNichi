import { useState, type FormEvent } from "react";
import { setPassword } from "../lib/auth";

interface Props {
  onAuthenticated: () => void;
}

export default function PasswordGate({ onAuthenticated }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${value}`,
        },
        body: JSON.stringify({ sql: "SELECT 1" }),
      });
      if (res.status === 401) {
        setError("Wrong password");
        setLoading(false);
        return;
      }
      setPassword(value);
      onAuthenticated();
    } catch {
      setError("Connection failed");
      setLoading(false);
    }
  }

  return (
    <div className="password-gate">
      <form onSubmit={handleSubmit} className="password-gate-form">
        <h2 className="password-gate-title">ChuMaiNichi</h2>
        <input
          type="password"
          placeholder="Dashboard password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          className="password-gate-input"
        />
        {error && <span className="password-gate-error">{error}</span>}
        <button
          type="submit"
          disabled={loading || !value}
          className="password-gate-btn"
          style={loading ? { cursor: "wait" } : undefined}
        >
          {loading ? "Checking\u2026" : "Enter"}
        </button>
      </form>
    </div>
  );
}
