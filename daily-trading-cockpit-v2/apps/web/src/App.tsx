import NeuralMindmap from './NeuralMindmap';
import ResearchDashboard from './ResearchDashboard';
import TestnetExchangeDashboard from './TestnetExchangeDashboard';

// The dashboard now surfaces only the Neural Map. The Scanner and Performance
// views were removed from the UI; their backend endpoints (/api/scan,
// /api/performance, /api/shadow, …) are untouched and continue to run.
export default function App() {
  if (window.location.pathname.startsWith('/testnet') || window.location.pathname.startsWith('/live')) {
    return <TestnetExchangeDashboard />;
  }
  if (window.location.pathname.startsWith('/research')) {
    return <ResearchDashboard />;
  }
  return <NeuralMindmap />;
}
