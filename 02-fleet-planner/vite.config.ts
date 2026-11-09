import { defineConfig } from 'vite';

// Root is the project folder: index.html here, public/ for assets, dist/ for the Pages build.
export default defineConfig({
  base: '/weekend-projects/02-fleet-planner/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    // sim.html: the sim-only page for the cross-engine determinism test (src/app/sim-page.ts).
    rolldownOptions: { input: { main: 'index.html', sim: 'sim.html' } },
  },
  worker: { format: 'es' },
  server: { port: 5173 },
});
