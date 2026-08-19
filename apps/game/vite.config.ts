import { defineConfig } from 'vite';

export default defineConfig({
  // Relative, so the built game runs from a subdirectory or straight off the
  // filesystem — a release zip should work by opening index.html.
  base: './',
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
});
