import { useState, useEffect, lazy, Suspense } from "react";
import PasswordGate from "./components/PasswordGate";
import useAuthStore from "./stores/auth-store";

const Heatmap = lazy(() => import("./components/Heatmap"));

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
      <div className="app-loading" aria-label="Checking authentication">
        <span className="app-loading-text">ChuMaiNichi</span>
      </div>
    );
  if (!authed) return <PasswordGate onAuthenticated={() => setAuthed(true)} />;

  return (
    <div className="app-container">
      <h1 className="app-title">ChuMaiNichi</h1>
      <Suspense
        fallback={
          <div className="heatmap-skeleton" aria-label="Loading">
            <div className="heatmap-skeleton-block">
              <div className="heatmap-skeleton-title" />
              <div className="heatmap-skeleton-grid" />
            </div>
            <div className="heatmap-skeleton-block">
              <div className="heatmap-skeleton-title" />
              <div className="heatmap-skeleton-grid" />
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
