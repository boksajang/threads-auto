import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // Chromium 캐시/DB는 Windows에서 잠길 수 있으며 HMR 대상이 아니다.
      ignored: ['**/data/**', '**/test-artifacts/**', '**/.diagnostics/**', '**/artifacts/**', '**/out/**'],
    },
  },
  build: { sourcemap: true },
});
