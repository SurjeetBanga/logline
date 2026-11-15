import { defineConfig } from '@playwright/test';

// The Logs panel's browser tests (src/test/ui). Run with `npm run test:layout`, after `npm run compile`
// has built media/viewer.js. A failed test keeps its trace and a screenshot in test-results/, and
// `npx playwright show-report` opens the report written to playwright-report/.

// A short panel docked under the editor, a narrow one in the side bar, and the narrowest side bar.
const SIZES = [
  { name: 'short panel', width: 2000, height: 330 },
  { name: 'side bar', width: 420, height: 300 },
  { name: 'narrowest side bar', width: 220, height: 600 },
];

export default defineConfig({
  testDir: 'src/test/ui',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Every layout check runs at each size.
    ...SIZES.map(({ name, width, height }) => ({
      name,
      testMatch: /layout\.spec\.ts/,
      use: { viewport: { width, height } },
    })),
    // Behaviour tests choose their own sizes, starting from a wide editor panel.
    { name: 'behaviour', testMatch: /behaviour\.spec\.ts/, use: { viewport: { width: 1400, height: 600 } } },
  ],
});
