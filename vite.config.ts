import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

const alias = {
  '@': path.resolve(__dirname, 'src'),
  '@main': path.resolve(__dirname, 'src/main'),
  '@preload': path.resolve(__dirname, 'src/preload'),
  '@renderer': path.resolve(__dirname, 'src/renderer'),
  '@shared': path.resolve(__dirname, 'src/shared'),
};

/**
 * index.html carries the packaged app's Content-Security-Policy. The dev server needs an inline script and a
 * socket for hot reload, which that policy forbids, so the policy is removed from the page it serves.
 */
function devServerWithoutContentSecurityPolicy(): Plugin {
  return {
    name: 'dev-server-without-content-security-policy',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace(/[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n?/, ''),
    },
  };
}

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 15173,
    strictPort: true,
  },
  resolve: {
    alias,
    // Force a single copy of these packages in every bundle. Multiple copies
    // break @lezer NodeProp id identity across packages (each copy has its own
    // id counter), which crashes CodeMirror's highlight plugin silently and
    // leaves the editor without syntax highlighting. See HANDOFF.md 2026-08-30.
    dedupe: ['@lezer/common', '@lezer/highlight', '@lezer/lr'],
  },
  plugins: [
    devServerWithoutContentSecurityPolicy(),
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        vite: {
          resolve: { alias },
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['electron', 'better-sqlite3', 'electron-store'],
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart: (startup) => {
          startup.reload();
        },
        vite: {
          resolve: { alias },
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  clearScreen: false,
});
