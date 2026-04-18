import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AuthState {
  password: string | null;
  setPassword: (password: string) => void;
  clearPassword: () => void;
  getAuthHeaders: () => { Authorization?: string };
}

const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      password: null,
      setPassword: (password: string) => set({ password }),
      clearPassword: () => set({ password: null }),
      getAuthHeaders: () => {
        return { Authorization: `Bearer ${get().password}` };
      },
    }),
    {
      name: "user-state",
    },
  ),
);

export default useAuthStore;
