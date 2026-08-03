import { verifyAuth } from "./api";

// Verify the dashboard password against /api/auth, which checks the password
// only — no database round-trip. This keeps login working when the database
// is down or DATABASE_URL is misconfigured; those errors surface later in the
// data panels instead of blocking sign-in.
export async function authenticate() {
  await verifyAuth();
}
