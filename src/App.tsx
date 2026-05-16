import { useState, useEffect, lazy, Suspense } from "react";
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
import useSettingsStore from "./features/settings/stores/settings-store";
import Header from "./features/shell/components/Header";
import useShellStore from "./features/shell/stores/shell-store";

const Heatmap = lazy(() => import("./features/heatmap/components/Heatmap"));
const RatingImage = lazy(
  () => import("./features/rating-image/components/RatingImage"),
);

type RefreshUiStatus = WorkflowStatus | "syncing" | "failed" | "";

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<RefreshUiStatus>("");
  const [refreshNonce, setRefreshNonce] = useState(0);
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
        style={{ "--chat-width": `${chatWidth}px` } as React.CSSProperties}
      >
        <Header
          onRefresh={handleRefresh}
          onOpenSettings={() => setSettingsOpen(true)}
          refreshing={refreshing}
          refreshStatus={refreshStatus}
        />
        <main className="app-main">
          <div className="app-main__inner">
            <Suspense fallback={<HeatmapSkeleton />}>
              <Heatmap games={APP_CONFIG.games} refreshNonce={refreshNonce} />
            </Suspense>
            <Suspense fallback={null}>
              <RatingImage
                games={APP_CONFIG.games}
                refreshNonce={refreshNonce}
              />
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
