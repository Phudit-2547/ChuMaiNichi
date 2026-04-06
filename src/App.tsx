import { useState, useEffect } from "react"
import Heatmap from "./components/Heatmap"
import PasswordGate from "./components/PasswordGate"
import { getPassword, authHeaders } from "./lib/auth"

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    const pwd = getPassword()
    if (!pwd) {
      fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      }).then((res) => {
        setAuthed(res.status !== 401)
      }).catch(() => setAuthed(false))
      return
    }
    fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ sql: "SELECT 1" }),
    }).then((res) => {
      setAuthed(res.status !== 401)
    }).catch(() => setAuthed(false))
  }, [])

  if (authed === null) return null
  if (!authed) return <PasswordGate onAuthenticated={() => setAuthed(true)} />

  return (
    <div className="app-container">
      <h1 className="app-title">ChuMaiNichi</h1>
      <Heatmap games={["maimai", "chunithm"]} />
    </div>
  )
}

export default App
