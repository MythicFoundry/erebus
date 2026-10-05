const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const applicationRoot = path.join(repositoryRoot, 'applications', 'electron');
const mainScript = path.join(applicationRoot, 'scripts', 'theia-electron-main.js');

test('runs Agent Focus in a resizable Electron window with functional workflow controls', async () => {
    const userDataDirectory = test.info().outputPath('electron-user-data');
    const electronApp = await electron.launch({
        executablePath: require('electron'),
        args: [mainScript, '--plugins=local-dir:../../plugins'],
        cwd: applicationRoot,
        env: {
            ...process.env,
            EREBUS_E2E: '1',
            THEIA_CONFIG_DIR: userDataDirectory,
            THEIA_NO_SPLASH: '1'
        }
    });

    try {
        const page = await electronApp.firstWindow();
        await expect(page.locator('#theia-app-shell')).toBeVisible();
        await expect(page.locator('.erebus-focus-root')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Start focused work' })).toBeVisible();

        const nativeState = await electronApp.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
            return window ? {
                resizable: window.isResizable(),
                minimizable: window.isMinimizable(),
                maximizable: window.isMaximizable()
            } : undefined;
        });
        expect(nativeState).toEqual({ resizable: true, minimizable: true, maximizable: true });

        await page.locator('.erebus-session-rail').getByRole('button', { name: 'New session' }).click();
        const dialog = page.getByRole('dialog', { name: 'New agent session' });
        await dialog.getByRole('button', { name: /^Bug Fix/ }).click();
        await dialog.getByRole('button', { name: /Create Bug Fix/ }).click();
        await expect(page.getByRole('main').getByRole('heading', { name: 'Bug Fix - Untitled task' })).toBeVisible();
        await expect(page.getByRole('button', { name: /Reproduce the failure/ })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Stop agent' })).toHaveCount(0);
    } finally {
        await electronApp.close();
    }
});
