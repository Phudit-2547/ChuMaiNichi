import { create } from "zustand";
import { bangkokToday } from "../../../global/lib/play-log";

interface PlayLogState {
  open: boolean;
  date: string;
  /** Bumped when the editor closes after a successful save, so the heatmap reloads. */
  savedNonce: number;
  /** Bumped on every open or day change; the editor stays inert until that load finishes. */
  session: number;
  openDay: (date?: string) => void;
  close: (saved: boolean) => void;
}

const usePlayLogStore = create<PlayLogState>()((set) => ({
  open: false,
  date: bangkokToday(),
  savedNonce: 0,
  session: 0,
  openDay: (date) =>
    set((state) => ({ open: true, date: date ?? bangkokToday(), session: state.session + 1 })),
  close: (saved) =>
    set((state) => ({
      open: false,
      savedNonce: saved ? state.savedNonce + 1 : state.savedNonce,
    })),
}));

export default usePlayLogStore;
