import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  autoOpenChat: boolean;
  showToolCalls: boolean;
  setAutoOpenChat: (v: boolean) => void;
  setShowToolCalls: (v: boolean) => void;
}

const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      autoOpenChat: true,
      showToolCalls: true,
      setAutoOpenChat: (autoOpenChat) => set({ autoOpenChat }),
      setShowToolCalls: (showToolCalls) => set({ showToolCalls }),
    }),
    { name: "settings-state" },
  ),
);

export default useSettingsStore;
