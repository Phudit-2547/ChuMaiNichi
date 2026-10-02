import { hasSession, passkeysEnabled } from "./session.js";
import { createHash, timingSafeEqual } from "node:crypto";

export function checkAuth(
  header: string | undefined,
  password: string | undefined,
  cookie?: string,
  origin?: string,
): boolean {
  if (passkeysEnabled()) return hasSession(cookie, origin);
  if (!password) return true;
  const token = header?.replace("Bearer ", "") ?? "";
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(password).digest();
  return timingSafeEqual(a, b);
}
