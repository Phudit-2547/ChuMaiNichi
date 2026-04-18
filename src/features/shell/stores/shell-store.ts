import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ShellState {
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  toggleChat: () => void;
}

const useShellStore = create<ShellState>()(
  persist(
    (set, get) => ({
      chatOpen: true,
      setChatOpen: (chatOpen) => set({ chatOpen }),
      toggleChat: () => set({ chatOpen: !get().chatOpen }),
    }),
    {
      name: "shell-state",
    },
  ),
);

export default useShellStore;
