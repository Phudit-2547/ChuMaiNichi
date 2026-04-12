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

const Heatmap = lazy(() => import("./features/heatmap/components/Heatmap"));

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const { password, getAuthHeaders } = useAuthStore();

  useEffect(() => {
    authenticate()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, [password, getAuthHeaders]);

  if (authed === null) return <AuthLoading />;
  if (!authed) return <PasswordGate onAuthenticated={() => setAuthed(true)} />;

  return (
    <ResizablePanelGroup orientation="horizontal" className="max-w-5xl">
      <ResizablePanel defaultSize="75%" className="p-8 mx-auto">
        <h1>ChuMaiNichi</h1>
        <Suspense fallback={<HeatmapSkeleton />}>
          <Heatmap games={["maimai", "chunithm"]} />
        </Suspense>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel>Chat</ResizablePanel>
    </ResizablePanelGroup>
  );
}

export default App;
