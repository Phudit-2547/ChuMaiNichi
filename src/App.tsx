import Heatmap from "./components/Heatmap"

function App() {
  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1.5rem' }}>ChuMaiNichi</h1>
      <Heatmap games={["maimai", "chunithm"]} />
    </div>
  )
}

export default App
