import { defineConfig } from 'vite';

// Root is the project folder: index.html here, public/ for assets, dist/ for the Pages build.
export default defineConfig({
  base: '/weekend-projects/02-fleet-planner/',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 900 },
  worker: { format: 'es' },
  server: { port: 5173 },
});
