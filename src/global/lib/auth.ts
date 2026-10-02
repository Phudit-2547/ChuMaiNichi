import { verifyAuth } from "./api";

// Session verification is independent of database availability.
export async function authenticate() {
  await verifyAuth();
}
