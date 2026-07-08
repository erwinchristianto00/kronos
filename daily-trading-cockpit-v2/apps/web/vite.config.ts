import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3101';
const testnetApiTarget = process.env.VITE_TESTNET_API_PROXY_TARGET ?? 'http://localhost:3102';
const liveApiTarget = process.env.VITE_LIVE_API_PROXY_TARGET ?? 'http://localhost:3103';

const proxy = {
  '/testnet/api': {
    target: testnetApiTarget,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/testnet/, ''),
  },
  '/live/api': {
    target: liveApiTarget,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/live/, ''),
  },
  '/api': {
    target: apiTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  // `server` = dev (vite dev). `preview` = production (vite preview serves the
  // built dist). Both proxy /api to the API so the dashboard works the same when
  // deployed headless (e.g. pm2 on a VPS) as it does locally.
  server: { proxy },
  preview: { proxy, host: true },
});
