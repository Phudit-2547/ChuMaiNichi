import { useState, useEffect, lazy, Suspense } from "react";
import PasswordGate from "./features/auth/components/PasswordGate";
import useAuthStore from "./features/auth/stores/auth-store";
import HeatmapSkeleton from "./features/heatmap/components/heatmap-skeleton/HeatmapSkeleton";
import AuthLoading from "./features/auth/components/AuthLoading";
import { queryDB } from "./global/lib/api";

const Heatmap = lazy(() => import("./features/heatmap/components/Heatmap"));

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const { password, getAuthHeaders } = useAuthStore();

  useEffect(() => {
    queryDB("SELECT 1")
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, [password, getAuthHeaders]);

  if (authed === null) return <AuthLoading />;
  if (!authed) return <PasswordGate onAuthenticated={() => setAuthed(true)} />;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1>ChuMaiNichi</h1>
      <Suspense fallback={<HeatmapSkeleton />}>
        <Heatmap games={["maimai", "chunithm"]} />
      </Suspense>
    </div>
  );
}

export default App;
