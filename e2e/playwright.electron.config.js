const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './electron',
    outputDir: '../test-results/playwright-electron',
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    timeout: 90_000,
    expect: { timeout: 20_000 },
    reporter: process.env.CI ? [['line'], ['html', { outputFolder: '../playwright-report/electron', open: 'never' }]] : 'line',
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure'
    }
});
