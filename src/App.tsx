import { useState, useEffect, lazy, Suspense } from "react";
import PasswordGate from "./features/auth/components/PasswordGate";
import HeatmapSkeleton from "./features/heatmap/components/heatmap-skeleton/HeatmapSkeleton";
import AuthLoading from "./features/auth/components/AuthLoading";
import { APP_CONFIG } from "./global/lib/config";
import { authenticate } from "./global/lib/auth";
import { triggerRefresh } from "./global/lib/api";
import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
} from "./global/components/ui/resizable";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { TooltipProvider } from "./global/components/ui/tooltip";
import ChatPanel from "./features/chat/components/ChatPanel";
import useChatRuntime from "./features/chat/hooks/useChatRuntime";
import SettingsModal from "./features/settings/components/SettingsModal";
import useDarkMode from "./features/settings/hooks/useDarkMode";

const Heatmap = lazy(() => import("./features/heatmap/components/Heatmap"));

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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
        <ResizablePanelGroup orientation="horizontal" className="h-dvh">
          <ResizablePanel defaultSize="75%" className="overflow-auto">
            <div className="p-8 mx-auto max-w-5xl">
              <h1 className="flex items-center gap-3">
                ChuMaiNichi
                <button
                  className="bg-accent text-accent-foreground border-0 rounded-md w-8 h-8 text-lg cursor-pointer inline-flex items-center justify-center hover:bg-accent/80 disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  title="Trigger user data refresh"
                >
                  {refreshing ? "⟳" : "↻"}
                </button>
              </h1>
              <SettingsModal />
              <Suspense fallback={<HeatmapSkeleton />}>
                <Heatmap games={APP_CONFIG.games} />
              </Suspense>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel>
            <ChatPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}

export default App;
