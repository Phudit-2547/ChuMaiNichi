import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "auto" | "light" | "dark";

interface SettingsState {
  themeMode: ThemeMode;
  autoOpenChat: boolean;
  showToolCalls: boolean;
  setThemeMode: (v: ThemeMode) => void;
  setAutoOpenChat: (v: boolean) => void;
  setShowToolCalls: (v: boolean) => void;
}

const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      themeMode: "auto",
      autoOpenChat: false,
      showToolCalls: true,
      setThemeMode: (themeMode) => set({ themeMode }),
      setAutoOpenChat: (autoOpenChat) => set({ autoOpenChat }),
      setShowToolCalls: (showToolCalls) => set({ showToolCalls }),
    }),
    { name: "settings-state" },
  ),
);

export default useSettingsStore;
