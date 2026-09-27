const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './browser',
    outputDir: '../test-results/playwright-browser',
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 2 : 0,
    timeout: 45_000,
    expect: { timeout: 10_000 },
    reporter: process.env.CI ? [['line'], ['html', { outputFolder: '../playwright-report/browser', open: 'never' }]] : 'line',
    use: {
        baseURL: 'http://127.0.0.1:3100',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure'
    },
    projects: [{
        name: 'chromium',
        use: { ...devices['Desktop Chrome'] }
    }],
    webServer: {
        command: 'yarn browser start --hostname=127.0.0.1 --port=3100',
        cwd: '..',
        env: { ...process.env, EREBUS_E2E: '1' },
        url: 'http://127.0.0.1:3100',
        reuseExistingServer: false,
        timeout: 120_000
    }
});
