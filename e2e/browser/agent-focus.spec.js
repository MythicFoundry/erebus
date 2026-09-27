const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

async function openNewSession(page) {
    await page.locator('.erebus-session-rail').getByRole('button', { name: 'New session' }).click();
    return page.getByRole('dialog', { name: 'New agent session' });
}

test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.erebus-focus-root')).toBeVisible();
});

test('starts empty without demo sessions and exposes working creation controls', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Start focused work' })).toBeVisible();
    await expect(page.getByText('Agent upgrade — modularize provider layer')).toHaveCount(0);

    const newSessionButton = page.locator('.erebus-session-rail').getByRole('button', { name: 'New session' });
    const dialog = await openNewSession(page);
    await expect(dialog.locator('select')).toBeFocused();
    await expect(dialog.getByRole('button', { name: /Create Spec/ })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(newSessionButton).toBeFocused();
});

test('creates a complete Spec workflow with reviewable tasks and real access choices', async ({ page }) => {
    const dialog = await openNewSession(page);
    await dialog.getByRole('button', { name: /Create Spec/ }).click();

    await expect(page.getByRole('main').getByRole('heading', { name: 'Spec — Untitled task' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Clarify requirements/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Implement and verify/ })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message the agent' }))
        .toContainText('Start this Spec workflow');

    await page.getByRole('button', { name: /Approve safe tools/ }).click();
    const accessMenu = page.getByRole('menu', { name: 'Select access mode' });
    await expect(accessMenu.getByRole('menuitemradio', { name: /Ask for approval/ })).toBeVisible();
    await expect(accessMenu.getByRole('menuitemradio', { name: /Approve safe tools/ })).toBeVisible();
    await expect(accessMenu.getByRole('menuitemradio', { name: /Allow session tools/ })).toBeVisible();
    await expect(accessMenu.getByRole('menuitemradio', { name: /Configured policy/ })).toBeVisible();
});

test('removing the last session returns to a stable empty view', async ({ page }) => {
    const dialog = await openNewSession(page);
    await dialog.getByRole('button', { name: /Create Spec/ }).click();

    await page.getByRole('button', { name: 'Manage Spec — Untitled task' }).click();
    page.once('dialog', confirmation => confirmation.accept());
    await page.getByRole('menuitem', { name: 'Remove session' }).click();

    await expect(page.getByRole('heading', { name: 'Start focused work' })).toBeVisible();
    await expect(page.locator('.erebus-composer-wrap')).toHaveCount(0);
});

test('recovers from malformed persisted data instead of crashing', async ({ page }) => {
    await page.evaluate(() => {
        localStorage.setItem('erebus.agentFocus.localSessions', '{not valid json');
        localStorage.setItem('erebus.agentFocus.projects', JSON.stringify([{ id: 4 }]));
        localStorage.setItem('erebus.agentFocus.projectCategories', JSON.stringify([false, { id: 'ok', name: 9 }]));
    });
    await page.reload();

    await expect(page.locator('.erebus-focus-root')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Start focused work' })).toBeVisible();
});

test('caps large project rendering and progressively reveals sessions', async ({ page }) => {
    const sessions = Array.from({ length: 1200 }, (_, index) => ({
        id: `load-${index}`,
        provider: 'erebus',
        workspace: 'Load Test',
        title: `Load session ${index}`,
        summary: 'Performance fixture',
        updated: 'now',
        status: 'paused',
        kind: 'local',
        monogram: 'LT',
        accent: '#9b6cff',
        messages: [],
        requirement: 'Test progressive rendering',
        designNotes: [],
        tasks: [],
        changedFiles: []
    }));
    await page.evaluate(value => {
        localStorage.setItem('erebus.agentFocus.localSessions', JSON.stringify(value));
        localStorage.setItem('erebus.agentFocus.selectedSession', 'load-0');
    }, sessions);
    await page.reload();

    await expect(page.locator('.erebus-session-row-shell')).toHaveCount(50);
    const showMore = page.getByRole('button', { name: /Show 50 more/ });
    await expect(showMore).toContainText('50 of 1200 shown');
    await showMore.click();
    await expect(page.locator('.erebus-session-row-shell')).toHaveCount(100);
});

test('has no serious or critical accessibility violations in Agent Focus', async ({ page }) => {
    const results = await new AxeBuilder({ page })
        .include('.erebus-focus-root')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
    const blocking = results.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical');
    expect(blocking, blocking.map(violation => `${violation.id}: ${violation.help}`).join('\n')).toEqual([]);
});
