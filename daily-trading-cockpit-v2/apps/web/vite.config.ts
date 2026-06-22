import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3101';

const proxy = {
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
