import { useState, useEffect, lazy, Suspense } from "react";
import PasswordGate from "./features/auth/components/PasswordGate";
import useAuthStore from "./features/auth/stores/auth-store";
import HeatmapSkeleton from "./features/heatmap/components/heatmap-skeleton/HeatmapSkeleton";
import AuthLoading from "./features/auth/components/AuthLoading";
import { APP_CONFIG } from "./global/lib/config";
import { authenticate } from "./global/lib/auth";
import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
} from "./global/components/ui/resizable";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { TooltipProvider } from "./global/components/ui/tooltip";
import ChatPanel from "./features/chat/components/ChatPanel";
import useChatRuntime from "./features/chat/hooks/useChatRuntime";

const Heatmap = lazy(() => import("./features/heatmap/components/Heatmap"));

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const { password, getAuthHeaders } = useAuthStore();

  useEffect(() => {
    authenticate()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, [password, getAuthHeaders]);

  const runtime = useChatRuntime();

  if (authed === null) return <AuthLoading />;
  if (!authed) return <PasswordGate onAuthenticated={() => setAuthed(true)} />;

  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="75%" className="p-8 mx-auto max-w-5xl">
            <h1>ChuMaiNichi</h1>
            <Suspense fallback={<HeatmapSkeleton />}>
              <Heatmap games={APP_CONFIG.games} />
            </Suspense>
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
