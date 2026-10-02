import { create } from "zustand";

// Remove the legacy persisted password. Authentication now uses an HttpOnly
// same-origin cookie; client code never reads or stores the session token.
if (typeof window !== "undefined") window.localStorage.removeItem("user-state");
const useAuthStore = create<{ getAuthHeaders: () => Record<string, string> }>(
  () => ({
    getAuthHeaders: () => ({}),
  }),
);
export default useAuthStore;
