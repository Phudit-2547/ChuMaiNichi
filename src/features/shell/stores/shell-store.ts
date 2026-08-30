import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  isDataRegion,
  type DataRegion,
} from "../../../global/lib/regions";

export const CHAT_WIDTH_MIN = 300;
export const CHAT_WIDTH_MAX = 720;
export const CHAT_WIDTH_DEFAULT = 420;

interface ShellState {
  chatOpen: boolean;
  chatWidth: number;
  dataRegion: DataRegion;
  setChatOpen: (open: boolean) => void;
  toggleChat: () => void;
  setChatWidth: (w: number) => void;
  setDataRegion: (region: DataRegion) => void;
}

function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return CHAT_WIDTH_DEFAULT;
  return Math.max(CHAT_WIDTH_MIN, Math.min(CHAT_WIDTH_MAX, Math.round(w)));
}

const useShellStore = create<ShellState>()(
  persist(
    (set, get) => ({
      chatOpen: false,
      chatWidth: CHAT_WIDTH_DEFAULT,
      dataRegion: "international",
      setChatOpen: (chatOpen) => set({ chatOpen }),
      toggleChat: () => set({ chatOpen: !get().chatOpen }),
      setChatWidth: (w) => set({ chatWidth: clampWidth(w) }),
      setDataRegion: (dataRegion) => set({ dataRegion }),
    }),
    {
      name: "shell-state",
      merge: (persisted, current) => {
        const stored = persisted as Partial<ShellState> | undefined;
        return {
          ...current,
          ...stored,
          dataRegion: isDataRegion(stored?.dataRegion)
            ? stored.dataRegion
            : "international",
        };
      },
    },
  ),
);

export default useShellStore;
