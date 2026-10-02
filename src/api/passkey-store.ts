import { neon } from "@neondatabase/serverless";
import type { WebAuthnCredential } from "@simplewebauthn/server";

export type StoredPasskey = Omit<WebAuthnCredential, "publicKey"> & {
  publicKey: string;
};
export type Challenge = {
  challenge: string;
  purpose: "register" | "login";
  bootstrap: boolean;
};
export function passkeyStore() {
  if (!process.env.DATABASE_URL)
    throw new Error("Passkey storage is unavailable");
  const sql = neon(process.env.DATABASE_URL);
  return {
    async init() {
      await sql`CREATE TABLE IF NOT EXISTS dashboard_passkeys (id SMALLINT PRIMARY KEY CHECK (id = 1), credentials JSONB NOT NULL DEFAULT '[]')`;
      await sql`INSERT INTO dashboard_passkeys (id) VALUES (1) ON CONFLICT DO NOTHING`;
      await sql`CREATE TABLE IF NOT EXISTS dashboard_auth_challenges (id TEXT PRIMARY KEY, data JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`;
      await sql`CREATE TABLE IF NOT EXISTS dashboard_auth_attempts (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`;
    },
    async credentials(): Promise<StoredPasskey[]> {
      const rows =
        await sql`SELECT credentials FROM dashboard_passkeys WHERE id = 1`;
      return rows[0].credentials;
    },
    async rateLimit(id: string, limit = 10) {
      const rows =
        await sql`INSERT INTO dashboard_auth_attempts (id, attempts, expires_at) VALUES (${id}, 1, NOW() + INTERVAL '1 minute')
        ON CONFLICT (id) DO UPDATE SET attempts = CASE WHEN dashboard_auth_attempts.expires_at < NOW() THEN 1 ELSE dashboard_auth_attempts.attempts + 1 END,
        expires_at = CASE WHEN dashboard_auth_attempts.expires_at < NOW() THEN NOW() + INTERVAL '1 minute' ELSE dashboard_auth_attempts.expires_at END RETURNING attempts`;
      // Global bootstrap bucket bounds password guesses even across source addresses.
      return rows[0].attempts <= limit;
    },
    async challenge(id: string, data: Challenge) {
      await sql`DELETE FROM dashboard_auth_challenges WHERE expires_at < NOW()`;
      await sql`INSERT INTO dashboard_auth_challenges (id, data, expires_at) VALUES (${id}, ${JSON.stringify(data)}::jsonb, NOW() + INTERVAL '5 minutes')`;
    },
    async consume(id: string): Promise<Challenge | null> {
      const rows =
        await sql`DELETE FROM dashboard_auth_challenges WHERE id = ${id} AND expires_at > NOW() RETURNING data`;
      return rows[0]?.data ?? null;
    },
    async register(credential: StoredPasskey, bootstrap: boolean) {
      // The singleton UPDATE serializes first registration across serverless instances.
      const rows =
        await sql`UPDATE dashboard_passkeys SET credentials = credentials || ${JSON.stringify([credential])}::jsonb
        WHERE id = 1 AND jsonb_array_length(credentials) < 10
        AND (NOT ${bootstrap} OR jsonb_array_length(credentials) = 0)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(credentials) c WHERE c->>'id' = ${credential.id}) RETURNING id`;
      return rows.length === 1;
    },
    async counter(id: string, oldCounter: number, newCounter: number) {
      const rows = await sql`UPDATE dashboard_passkeys SET credentials = (
        SELECT jsonb_agg(CASE WHEN c->>'id' = ${id} THEN jsonb_set(c, '{counter}', to_jsonb(${newCounter}::bigint)) ELSE c END)
        FROM jsonb_array_elements(credentials) c)
        WHERE id = 1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(credentials) c WHERE c->>'id' = ${id} AND (c->>'counter')::bigint = ${oldCounter}) RETURNING id`;
      return rows.length === 1;
    },
  };
}
