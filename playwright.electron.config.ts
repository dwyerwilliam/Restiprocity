import { defineConfig } from '@playwright/test';

// Native Electron smoke tests. These launch the real Electron runtime via
// Playwright's `_electron.launch` and talk to the app through its actual
// preload/IPC bridge — no mocks, no preview server. Requires `vite build`
// output in `dist/` + `dist-electron/` (run `npm run build:renderer` first).
export default defineConfig({
  testDir: './tests/electron',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  projects: [
    {
      name: 'electron',
    },
  ],
});
