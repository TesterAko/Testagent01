// browser/action-executor.js
import { buildSelector } from '../utils/selector.js';
import { captureScreenshot } from './dom-capture.js';
import { generateBugReport } from '../agent/reporter.js';

function inferType(a) {
    if (a?.type) return a.type;
    if (a?.key) return 'press';
    if (a?.value && a?.selector) return 'fill';
    return 'click';
}

async function clickSafe(page, selector) {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    await loc.click();
}

async function fillSafe(page, selector, value) {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    await loc.fill(value ?? 'test');
}

async function selectSafe(page, selector, value) {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    try { await loc.selectOption(String(value ?? '1')); } catch { await loc.click(); }
}

export async function executeActions(page, actions = [], labelPrefix = 'act') {
    for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const type = inferType(a);
        const selector = a.selector || buildSelector(a) || a.css || a.xpath && `xpath=${a.xpath}`;
        const label = `${labelPrefix}-${i}-${type}`;

        if (!selector) continue;

        try {
            if (type === 'click') await clickSafe(page, selector);
            else if (type === 'fill') await fillSafe(page, selector, a.value);
            else if (type === 'select') await selectSafe(page, selector, a.value);
            else if (type === 'press') await page.keyboard.press(a.key || 'Enter');
            else await clickSafe(page, selector);
        } catch (err) {
            console.error(`❌ Aktion fehlgeschlagen (${type} @ ${selector}):`, err?.message || err);
            // Screenshot + Bugreport
            const shot = `${label}-error`;
            await captureScreenshot(page, shot).catch(() => { });
            await generateBugReport(
                `Fehler bei Aktion "${type}" auf Selector "${selector}" – ${err?.message || err}`,
                shot
            ).catch(() => { });

            // Optional: weiter versuchen statt Abbruch
            continue;
        }
    }
}
