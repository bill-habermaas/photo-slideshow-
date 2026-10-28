import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// In development the Go API runs on :8080 (or API_URL); Vite proxies /api to it.
// In the Docker image nginx does the same job.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.API_URL ?? 'http://localhost:8080',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
