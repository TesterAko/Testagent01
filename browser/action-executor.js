// browser/action-executor.js
// Führt deterministisch UI-Aktionen aus (strict wkrad-id only) und loggt klar,
// was passiert. Unterstützte Typen: click | fill | select | press
// KEINE destruktiven Aktionen (kein submit/delete) in dieser Datei.
//
// Node: ESM

function assertWkradSelector(selector) {
    if (!selector || typeof selector !== 'string') throw new Error('Ungültiger Selector (leer)');
    const ok = /\[(data-)?wkrad-id=/.test(selector);
    if (!ok) throw new Error(`Nur wkrad-id Selektoren erlaubt: ${selector}`);
}

async function waitAfterInteraction(page, beforeUrl, { navTimeout = 8000, idleTimeout = 4000 } = {}) {
    const nav = page.waitForNavigation({ waitUntil: 'load', timeout: navTimeout }).catch(() => null);
    const urlChange = page.waitForURL(u => String(u) !== String(beforeUrl), { timeout: navTimeout }).catch(() => null);
    const idle = page.waitForLoadState('networkidle', { timeout: idleTimeout }).catch(() => null);
    await Promise.race([nav, urlChange, idle]).catch(() => null);
    await page.waitForTimeout(200).catch(() => { });
}

async function clickSafe(page, selector) {
    assertWkradSelector(selector);
    const beforeUrl = page.url();
    const loc = page.locator(selector).first();

    await loc.waitFor({ state: 'visible', timeout: 8000 });
    if (!(await loc.isEnabled().catch(() => false))) throw new Error(`Element ist disabled: ${selector}`);

    const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => null);
    const urlChange = page.waitForURL(u => String(u) !== String(beforeUrl), { timeout: 8000 }).catch(() => null);

    await loc.click({ trial: false }).catch(async (e) => {
        try { await loc.click({ force: true }); } catch { throw e; }
    });

    await Promise.race([nav, urlChange]).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => null);
    await page.waitForTimeout(150).catch(() => { });
}

async function fillSafe(page, selector, value = 'test') {
    assertWkradSelector(selector);
    const beforeUrl = page.url();
    const loc = page.locator(selector).first();

    await loc.waitFor({ state: 'visible', timeout: 8000 });
    if (!(await loc.isEnabled().catch(() => false))) throw new Error(`Input ist disabled: ${selector}`);

    try { await loc.fill(''); } catch { }
    await loc.fill(String(value));

    await waitAfterInteraction(page, beforeUrl, { navTimeout: 3000, idleTimeout: 2000 });
}

async function selectSafe(page, selector, value = '') {
    assertWkradSelector(selector);
    const beforeUrl = page.url();
    const loc = page.locator(selector).first();

    await loc.waitFor({ state: 'visible', timeout: 8000 });
    if (!(await loc.isEnabled().catch(() => false))) throw new Error(`Select ist disabled: ${selector}`);

    if (!value) {
        const options = await loc.locator('option').allTextContents().catch(() => []);
        const candidate = options.find(t => (t || '').trim() !== '') || '';
        value = candidate.trim();
    }

    try {
        if (value) {
            await loc.selectOption({ label: value }).catch(async () => {
                await loc.selectOption({ value }).catch(async () => {
                    await loc.focus();
                    await page.keyboard.press('Home').catch(() => { });
                    await page.keyboard.press('Enter').catch(() => { });
                });
            });
        } else {
            await loc.focus();
            await page.keyboard.press('Enter').catch(() => { });
        }
    } catch (e) {
        throw new Error(`Select fehlgeschlagen für ${selector}: ${e?.message || e}`);
    }

    await waitAfterInteraction(page, beforeUrl, { navTimeout: 3000, idleTimeout: 2000 });
}

async function pressSafe(page, key = 'Enter') {
    await page.keyboard.press(key);
    await page.waitForTimeout(150).catch(() => { });
}

/**
 * Führt eine Liste von Aktionen deterministisch nacheinander aus.
 * Loggt für jede Aktion TRY/OK/FAIL deutlich in der Konsole.
 *
 * @param {import('playwright').Page} page
 * @param {Array<{type:'click'|'fill'|'select'|'press', selector:string, value?:string, key?:string, id?:string}>} actions
 * @param {string} label
 * @returns {Promise<{progress:boolean, before:{url:string,title:string}, after:{url:string,title:string}}>}
 */
export async function executeActions(page, actions = [], label = '') {
    const before = { url: page.url(), title: await page.title().catch(() => '') };

    for (const [i, action] of actions.entries()) {
        const { type, selector, value, key, id } = action || {};
        if (!type || !selector) throw new Error(`Ungültige Aktion: ${JSON.stringify(action)}`);
        assertWkradSelector(selector);

        const head = `[Action ${label} #${i + 1}]`;
        const tag = `${type.toUpperCase()} id=${id || ''} selector=${selector}`;
        console.log(`${head} TRY ${tag}`);

        try {
            if (type === 'click') {
                await clickSafe(page, selector);
            } else if (type === 'fill') {
                await fillSafe(page, selector, value ?? 'test');
            } else if (type === 'select') {
                await selectSafe(page, selector, value ?? '');
            } else if (type === 'press') {
                await pressSafe(page, key ?? 'Enter');
            } else {
                console.log(`${head} SKIP unknown type=${type}`);
                continue;
            }

            console.log(`${head} OK ${tag}`);
        } catch (err) {
            console.log(`${head} FAIL ${tag} :: ${String(err?.message || err)}`);
            throw err;
        }
    }

    const after = { url: page.url(), title: await page.title().catch(() => '') };
    const progress = before.url !== after.url || before.title !== after.title;
    return { progress, before, after, label };
}
