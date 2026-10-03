import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: { external: ['better-sqlite3'], output: { entryFileNames: 'main.js' } },
  },
});
