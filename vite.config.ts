import { defineConfig } from 'vite';
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

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 15173,
    strictPort: true,
  },
  resolve: {
    alias,
  },
  plugins: [
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
