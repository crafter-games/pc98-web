import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  base: './',
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['@pc98-web/core'] },
});
