import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = process.env.VITE_API_PORT ?? '3001';
const apiTarget = `http://localhost:${apiPort}`;

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routeFileIgnorePattern: '\\.test\\.tsx?$',
    }),
    react(),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/mcp': apiTarget,
    },
  },
});
