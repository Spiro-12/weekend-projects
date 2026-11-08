// Spike a's own Vite config (the app's vite.config.ts is lead-owned). Run from 02-fleet-planner/:
//   dev:   npx vite --config spikes/a-render/vite.config.ts         -> http://localhost:5191/weekend-projects/02-fleet-planner/
//   build: npx vite build --config spikes/a-render/vite.config.ts   -> spikes/a-render/out/dist (gitignored)
//   serve: npx tsx scripts/serve-gz.ts spikes/a-render/out/dist 5191 (gzipped like GitHub Pages)
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: '/weekend-projects/02-fleet-planner/',
  publicDir: 'public',
  build: { outDir: 'out/dist', emptyOutDir: true, target: 'es2022', manifest: true, chunkSizeWarningLimit: 900 },
  server: { port: 5191, strictPort: true, fs: { allow: ['../..'] } },
  preview: { port: 5191, strictPort: true },
});
