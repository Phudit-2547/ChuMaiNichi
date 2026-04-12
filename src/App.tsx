import { useState, useEffect, lazy, Suspense } from "react";
import PasswordGate from "./features/auth/components/PasswordGate";
import useAuthStore from "./features/auth/stores/auth-store";

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

  if (authed === null)
    return (
      <div
        className="flex items-center justify-center min-h-screen"
        aria-label="Checking authentication"
      >
        <span className="text-xl text-muted animate-skeleton-pulse">
          ChuMaiNichi
        </span>
      </div>
    );
  if (!authed) return <PasswordGate onAuthenticated={() => setAuthed(true)} />;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1>ChuMaiNichi</h1>
      <Suspense
        fallback={
          <div className="flex flex-col gap-8" aria-label="Loading">
            <div className="flex flex-col gap-2">
              <div className="w-20 h-[1.1rem] bg-surface rounded animate-skeleton-pulse" />
              <div className="w-full max-w-235 h-30 bg-surface rounded animate-skeleton-pulse" />
            </div>
            <div className="flex flex-col gap-2">
              <div className="w-20 h-[1.1rem] bg-surface rounded animate-skeleton-pulse" />
              <div className="w-full max-w-235 h-30 bg-surface rounded animate-skeleton-pulse" />
            </div>
          </div>
        }
      >
        <Heatmap games={["maimai", "chunithm"]} />
      </Suspense>
    </div>
  );
}

export default App;
