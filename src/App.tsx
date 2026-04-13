import { useState, useEffect, lazy, Suspense } from "react";
import PasswordGate from "./features/auth/components/PasswordGate";
import useAuthStore from "./features/auth/stores/auth-store";
import HeatmapSkeleton from "./features/heatmap/components/heatmap-skeleton/HeatmapSkeleton";
import AuthLoading from "./features/auth/components/AuthLoading";
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
import SettingsModal from "./features/settings/components/SettingsModal";
import useDarkMode from "./features/settings/hooks/useDarkMode";

const Heatmap = lazy(() => import("./features/heatmap/components/Heatmap"));

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const { password, getAuthHeaders } = useAuthStore();

  useDarkMode();
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
            <SettingsModal />
            <Suspense fallback={<HeatmapSkeleton />}>
              <Heatmap games={["maimai", "chunithm"]} />
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
