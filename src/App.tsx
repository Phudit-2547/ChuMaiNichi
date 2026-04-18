import { useState, useEffect, lazy, Suspense } from "react";
import PasswordGate from "./features/auth/components/PasswordGate";
import HeatmapSkeleton from "./features/heatmap/components/heatmap-skeleton/HeatmapSkeleton";
import AuthLoading from "./features/auth/components/AuthLoading";
import { APP_CONFIG } from "./global/lib/config";
import { authenticate } from "./global/lib/auth";
import { triggerRefresh } from "./global/lib/api";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { TooltipProvider } from "./global/components/ui/tooltip";
import ChatPanel from "./features/chat/components/ChatPanel";
import useChatRuntime from "./features/chat/hooks/useChatRuntime";
import SettingsModal from "./features/settings/components/SettingsModal";
import useDarkMode from "./features/settings/hooks/useDarkMode";
import Header from "./features/shell/components/Header";
import useShellStore from "./features/shell/stores/shell-store";

const Heatmap = lazy(() => import("./features/heatmap/components/Heatmap"));

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { chatOpen } = useShellStore();

  useDarkMode();
  useEffect(() => {
    authenticate()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  const runtime = useChatRuntime();

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const { run_url } = await triggerRefresh();
      window.open(run_url, "_blank");
    } catch (e) {
      console.error(e);
    } finally {
      setRefreshing(false);
    }
  }

  if (authed === null) return <AuthLoading />;
  if (!authed) return <PasswordGate onAuthenticated={() => setAuthed(true)} />;

  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="app-shell" data-chat-open={chatOpen}>
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
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}

export default App;
