import NeuralMindmap from './NeuralMindmap';
import TestnetExchangeDashboard from './TestnetExchangeDashboard';

// The dashboard now surfaces only the Neural Map. The Scanner and Performance
// views were removed from the UI; their backend endpoints (/api/scan,
// /api/performance, /api/shadow, …) are untouched and continue to run.
export default function App() {
  if (window.location.pathname.startsWith('/testnet')) {
    return <TestnetExchangeDashboard />;
  }
  return <NeuralMindmap />;
}
