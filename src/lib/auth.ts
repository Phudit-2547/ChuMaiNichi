const STORAGE_KEY = "dashboard_password";

export function getPassword(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function setPassword(password: string): void {
  try { localStorage.setItem(STORAGE_KEY, password); } catch { /* storage unavailable */ }
}

export function clearPassword(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}

export function authHeaders(): Record<string, string> {
  const pwd = getPassword();
  if (pwd) return { Authorization: `Bearer ${pwd}` };
  return {};
}
