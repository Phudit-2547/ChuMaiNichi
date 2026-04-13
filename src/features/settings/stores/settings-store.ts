import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  isDarkMode: boolean;
  setDarkMode: (isDarkMode: boolean) => void;
}

const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      isDarkMode: true,
      setDarkMode: (isDarkMode) => set({ isDarkMode }),
    }),
    {
      name: "settings-state",
    },
  ),
);

export default useSettingsStore;
