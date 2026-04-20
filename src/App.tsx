import { useState, useEffect, lazy, Suspense } from "react";
import PasswordGate from "./features/auth/components/PasswordGate";
import HeatmapSkeleton from "./features/heatmap/components/heatmap-skeleton/HeatmapSkeleton";
import AuthLoading from "./features/auth/components/AuthLoading";
import { APP_CONFIG } from "./global/lib/config";
import { authenticate } from "./global/lib/auth";
import { triggerRefresh } from "./global/lib/api";
import { TooltipProvider } from "./global/components/ui/tooltip";
import ChatPanel from "./features/chat/components/ChatPanel";
import SettingsModal from "./features/settings/components/SettingsModal";
import useSettingsStore from "./features/settings/stores/settings-store";
import Header from "./features/shell/components/Header";
import useShellStore from "./features/shell/stores/shell-store";

const Heatmap = lazy(() => import("./features/heatmap/components/Heatmap"));

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { chatOpen, setChatOpen, chatWidth } = useShellStore();

  useEffect(() => {
    authenticate()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
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
    setRefreshing(true);
    try {
      await triggerRefresh();
      window.setTimeout(() => setRefreshing(false), 2 * 60 * 1000);
    } catch (e) {
      console.error(e);
      setRefreshing(false);
    }
  }

  if (authed === null) return <AuthLoading />;
  if (!authed) return <PasswordGate onAuthenticated={() => setAuthed(true)} />;

  return (
    <TooltipProvider>
      <div
        className="app-shell"
        data-chat-open={chatOpen}
        style={{ "--chat-width": `${chatWidth}px` } as React.CSSProperties}
      >
        <Header
          onRefresh={handleRefresh}
          onOpenSettings={() => setSettingsOpen(true)}
          refreshing={refreshing}
        />
        <main className="app-main">
          <div className="app-main__inner">
            <Suspense fallback={<HeatmapSkeleton />}>
              <Heatmap games={APP_CONFIG.games} />
            </Suspense>
          </div>
        </main>
        <div className="overflow-hidden min-w-0">
          <ChatPanel />
        </div>
      </div>
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </TooltipProvider>
  );
}

export default App;
