import { defineConfig } from 'vite';

// Dev: vite serves the client on 5173 and proxies websocket traffic to the
// game server on 8080. Production: the game server serves dist/ itself, so
// the client always talks to its own origin.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  // Game assets are large binary blobs; keep them out of the module graph.
  assetsInclude: ['**/*.gltf', '**/*.glb', '**/*.bin'],
});
