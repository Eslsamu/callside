import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { entries: ['index.html'] },
  server: {
    host: '127.0.0.1',
    watch: {
      ignored: [
        '**/release/**',
        '**/dist-server/**',
        '**/test-results/**',
        '**/playwright-report/**',
        '**/.impeccable/**',
      ],
    },
  },
});
