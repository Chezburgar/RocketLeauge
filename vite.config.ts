import { defineConfig } from 'vite';

// `base: './'` keeps every asset path relative so the build works on GitHub Pages
// (served from /<repo>/) as well as any other static host.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  server: { host: true },
});
