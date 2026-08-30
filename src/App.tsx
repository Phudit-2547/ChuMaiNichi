import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  lazy,
  Suspense,
} from "react";
import PasswordGate from "./features/auth/components/PasswordGate";
import HeatmapSkeleton from "./features/heatmap/components/heatmap-skeleton/HeatmapSkeleton";
import AuthLoading from "./features/auth/components/AuthLoading";
import { APP_CONFIG } from "./global/lib/config";
import { authenticate } from "./global/lib/auth";
import {
  triggerRefresh,
  pollRefreshStatus,
  type WorkflowStatus,
} from "./global/lib/api";
import { TooltipProvider } from "./global/components/ui/tooltip";
import ChatPanel from "./features/chat/components/ChatPanel";
import SettingsModal from "./features/settings/components/SettingsModal";
import useSettingsStore, {
  type ThemeMode,
} from "./features/settings/stores/settings-store";
import Header from "./features/shell/components/Header";
import useShellStore from "./features/shell/stores/shell-store";
import { RegionSwitch } from "./features/heatmap/components/RegionSwitch";

const Heatmap = lazy(() => import("./features/heatmap/components/Heatmap"));
const RatingImage = lazy(
  () => import("./features/rating-image/components/RatingImage"),
);

type RefreshUiStatus = WorkflowStatus | "syncing" | "failed" | "";
type EffectiveTheme = Exclude<ThemeMode, "auto">;
const LIQUID_INTERACTIVE_SELECTOR =
  ".glass-control, .chat-composer__box, .slash-menu__item";
const THEME_MEDIA = "(prefers-color-scheme: dark)";
const THEME_COLORS: Record<EffectiveTheme, string> = {
  light: "#f4f4f7",
  dark: "#0d1117",
};
const THEME_TRANSITION_MS = 280;
let themeTransitionTimeout: number | null = null;

function resolveEffectiveTheme(themeMode: ThemeMode): EffectiveTheme {
  if (themeMode !== "auto") return themeMode;
  if (typeof window === "undefined") return "light";
  return window.matchMedia(THEME_MEDIA).matches ? "dark" : "light";
}

function applyTheme(theme: EffectiveTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[theme]);
}

function commitThemeWithTransition(commit: () => void) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    commit();
    return;
  }

  const root = document.documentElement;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (themeTransitionTimeout != null) {
    window.clearTimeout(themeTransitionTimeout);
    themeTransitionTimeout = null;
  }

  if (reducedMotion.matches) {
    delete root.dataset.themeTransition;
    commit();
    return;
  }

  root.dataset.themeTransition = "fallback";
  commit();
  themeTransitionTimeout = window.setTimeout(() => {
    if (root.dataset.themeTransition === "fallback") {
      delete root.dataset.themeTransition;
    }
    themeTransitionTimeout = null;
  }, THEME_TRANSITION_MS);
}

function readPersistedBoolean(key: string, field: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const state = (parsed as { state?: unknown }).state;
    if (!state || typeof state !== "object") return null;
    const value = (state as Record<string, unknown>)[field];
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

function findLiquidInteractive(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(LIQUID_INTERACTIVE_SELECTOR);
  return el instanceof HTMLElement ? el : null;
}

function useLiquidGlassPointer() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let active: HTMLElement | null = null;
    let lastEvent: PointerEvent | null = null;
    let frame = 0;

    const clearActive = (el: HTMLElement | null) => {
      if (!el) return;
      el.style.removeProperty("--liquid-pointer-x");
      el.style.removeProperty("--liquid-pointer-y");
      el.style.removeProperty("--liquid-highlight-strength");
    };

    const commitPointer = () => {
      frame = 0;
      const event = lastEvent;
      if (!event || reducedMotion.matches) return;

      const el = findLiquidInteractive(event.target);
      if (!el) {
        clearActive(active);
        active = null;
        return;
      }

      if (active && active !== el) clearActive(active);
      active = el;

      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      el.style.setProperty("--liquid-pointer-x", `${Math.round(x)}%`);
      el.style.setProperty("--liquid-pointer-y", `${Math.round(y)}%`);
      el.style.setProperty("--liquid-highlight-strength", "0.42");
    };

    const onPointerMove = (event: PointerEvent) => {
      lastEvent = event;
      if (frame) return;
      frame = window.requestAnimationFrame(commitPointer);
    };

    const onPointerOut = (event: PointerEvent) => {
      const el = findLiquidInteractive(event.target);
      if (!el) return;
      if (event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) {
        return;
      }
      clearActive(el);
      if (active === el) active = null;
    };

    const onFocusIn = (event: FocusEvent) => {
      const el = findLiquidInteractive(event.target);
      if (!el || reducedMotion.matches) return;
      el.style.setProperty("--liquid-pointer-x", "50%");
      el.style.setProperty("--liquid-pointer-y", "12%");
      el.style.setProperty("--liquid-highlight-strength", "0.32");
    };

    const onFocusOut = (event: FocusEvent) => {
      clearActive(findLiquidInteractive(event.target));
    };

    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerout", onPointerOut, { passive: true });
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      if (frame) window.cancelAnimationFrame(frame);
      clearActive(active);
    };
  }, []);
}

function useEffectiveTheme(themeMode: ThemeMode) {
  const effectiveThemeRef = useRef<EffectiveTheme>(
    resolveEffectiveTheme(themeMode),
  );

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(THEME_MEDIA);

    const commitTheme = (next: EffectiveTheme) => {
      effectiveThemeRef.current = next;
      applyTheme(next);
    };

    const update = () => {
      const next = resolveEffectiveTheme(themeMode);
      const current = effectiveThemeRef.current;
      if (current === next) {
        applyTheme(next);
        return;
      }
      commitThemeWithTransition(() => commitTheme(next));
    };

    update();
    if (themeMode === "auto") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
  }, [themeMode]);
}

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<RefreshUiStatus>("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
    chatOpen,
    setChatOpen,
    chatWidth,
    dataRegion,
    setDataRegion,
  } = useShellStore();
  const themeMode = useSettingsStore((state) => state.themeMode);
  useEffectiveTheme(themeMode);
  useLiquidGlassPointer();

  useEffect(() => {
    authenticate()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
    const storedChatOpen = readPersistedBoolean("shell-state", "chatOpen");
    if (storedChatOpen != null) {
      setChatOpen(storedChatOpen);
      return;
    }
    const { autoOpenChat } = useSettingsStore.getState();
    const isDesktop =
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 1201px)").matches;
    setChatOpen(autoOpenChat && isDesktop);
  }, [setChatOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 1200px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setChatOpen(false);
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [setChatOpen]);

  async function handleRefresh() {
    if (dataRegion !== "international") return;
    setRefreshing(true);
    setRefreshStatus("queued");
    try {
      const { run_id } = await triggerRefresh();
      if (!run_id) throw new Error("No run_id returned");
      const result = await pollRefreshStatus(run_id, (status) => {
        setRefreshStatus(status);
      });
      if (result.conclusion && result.conclusion !== "success") {
        throw new Error(`Workflow finished with conclusion: ${result.conclusion}`);
      }
      setRefreshStatus("syncing");
      setRefreshNonce((n) => n + 1);
      setRefreshStatus("completed");
    } catch (e) {
      console.error("[Refresh] error:", e);
      setRefreshStatus("failed");
    } finally {
      setRefreshing(false);
      window.setTimeout(() => setRefreshStatus(""), 2500);
    }
  }

  if (authed === null) return <AuthLoading />;
  if (!authed) return <PasswordGate onAuthenticated={() => setAuthed(true)} />;

  return (
    <TooltipProvider>
      <div
        className="app-shell"
        data-chat-open={chatOpen}
        data-region={dataRegion}
        style={{ "--chat-width": `${chatWidth}px` } as React.CSSProperties}
      >
        <Header
          onRefresh={handleRefresh}
          onOpenSettings={() => setSettingsOpen(true)}
          refreshing={refreshing}
          refreshStatus={refreshStatus}
          refreshAvailable={dataRegion === "international"}
        />
        <main className="app-main">
          <div className="app-main__inner">
            <div className="page-context-toolbar">
              <RegionSwitch
                value={dataRegion}
                onChange={setDataRegion}
              />
              <span className="page-context-toolbar__source">
                {dataRegion === "japan"
                  ? "Obsidian Journal archive"
                  : "Live International data"}
              </span>
            </div>
            <Suspense fallback={<HeatmapSkeleton />}>
              <Heatmap
                key={dataRegion}
                games={APP_CONFIG.games}
                region={dataRegion}
                refreshNonce={refreshNonce}
              />
            </Suspense>
            {dataRegion === "international" && (
              <Suspense fallback={null}>
                <RatingImage
                  games={APP_CONFIG.games}
                  refreshNonce={refreshNonce}
                />
              </Suspense>
            )}
          </div>
        </main>
        <div className="overflow-hidden min-w-0">
          <ChatPanel key={dataRegion} region={dataRegion} />
        </div>
      </div>
      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        region={dataRegion}
      />
    </TooltipProvider>
  );
}

export default App;
