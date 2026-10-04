import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['development'], alias: { '@': '/src' } },
  server: {
    port: 5173,
    proxy: { '/api': api, '/auth': api },
  },
});
