import { create } from "zustand";
import { persist } from "zustand/middleware";

export const CHAT_WIDTH_MIN = 300;
export const CHAT_WIDTH_MAX = 720;
export const CHAT_WIDTH_DEFAULT = 420;

interface ShellState {
  chatOpen: boolean;
  chatWidth: number;
  setChatOpen: (open: boolean) => void;
  toggleChat: () => void;
  setChatWidth: (w: number) => void;
}

function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return CHAT_WIDTH_DEFAULT;
  return Math.max(CHAT_WIDTH_MIN, Math.min(CHAT_WIDTH_MAX, Math.round(w)));
}

const useShellStore = create<ShellState>()(
  persist(
    (set, get) => ({
      chatOpen: true,
      chatWidth: CHAT_WIDTH_DEFAULT,
      setChatOpen: (chatOpen) => set({ chatOpen }),
      toggleChat: () => set({ chatOpen: !get().chatOpen }),
      setChatWidth: (w) => set({ chatWidth: clampWidth(w) }),
    }),
    {
      name: "shell-state",
    },
  ),
);

export default useShellStore;
