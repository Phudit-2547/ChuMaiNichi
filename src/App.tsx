import { useState, useEffect, lazy, Suspense } from "react";
import PasswordGate from "./features/auth/components/PasswordGate";
import useAuthStore from "./features/auth/stores/auth-store";
import HeatmapSkeleton from "./features/heatmap/components/HeatmapSkeleton";
import AuthLoading from "./features/auth/components/AuthLoading";
import { APP_CONFIG } from "./global/lib/config";

const Heatmap = lazy(() => import("./features/heatmap/components/Heatmap"));

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const { password, getAuthHeaders } = useAuthStore();

  useEffect(() => {
    if (!password) {
      fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      })
        .then((res) => {
          setAuthed(res.status !== 401);
        })
        .catch(() => setAuthed(false));
      return;
    }
    fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ sql: "SELECT 1" }),
    })
      .then((res) => {
        setAuthed(res.status !== 401);
      })
      .catch(() => setAuthed(false));
  }, [password, getAuthHeaders]);

  if (authed === null) return <AuthLoading />;
  if (!authed) return <PasswordGate onAuthenticated={() => setAuthed(true)} />;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1>ChuMaiNichi</h1>
      <Suspense fallback={<HeatmapSkeleton />}>
        <Heatmap games={APP_CONFIG.games} />
      </Suspense>
    </div>
  );
}

export default App;
