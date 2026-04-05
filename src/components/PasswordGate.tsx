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

    // Test the password against /api/query with a trivial query
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
    <div style={{
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      minHeight: "100vh",
    }}>
      <form onSubmit={handleSubmit} style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        width: "300px",
      }}>
        <h2 style={{ margin: 0, fontSize: "1.25rem" }}>ChuMaiNichi</h2>
        <input
          type="password"
          placeholder="Dashboard password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          style={{
            padding: "0.5rem 0.75rem",
            borderRadius: "6px",
            border: "1px solid #30363d",
            background: "#161b22",
            color: "#e6edf3",
            fontSize: "0.9rem",
          }}
        />
        {error && <span style={{ color: "#f85149", fontSize: "0.85rem" }}>{error}</span>}
        <button
          type="submit"
          disabled={loading || !value}
          style={{
            padding: "0.5rem",
            borderRadius: "6px",
            border: "none",
            background: "#238636",
            color: "#fff",
            cursor: loading ? "wait" : "pointer",
            fontSize: "0.9rem",
          }}
        >
          {loading ? "Checking..." : "Enter"}
        </button>
      </form>
    </div>
  );
}
