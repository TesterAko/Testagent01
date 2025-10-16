// services/ui-errors.js
// Erkennung & Öffnen von UI-Fehlern (Alert/Toast/Banner/Formfehler) – inkl. wkAlertPopup.
// - detectUiErrors(page): findet potenzielle Fehlermeldungen
// - openUiError(page, err): klappt Details auf (z. B. .detail Button in wkAlertPopup)
// - getUiErrorContent(page, err): extrahiert Text & HTML (komplett)

export function toSelector(id) {
    return `[wkrad-id="${id}"], [data-wkrad-id="${id}"]`;
}

/**
 * Sucht nach Fehleranzeigen. Prioritäten:
 * 1) .wkAlertPopup (euer roter Fehlerbanner)
 * 2) .alert-danger / .alert.alert-danger
 * 3) role=alert / aria-live
 * 4) Textheuristiken in typischen Klassen
 */
export async function detectUiErrors(page, { limit = 6 } = {}) {
    const errs = await page.evaluate((lim) => {
        const pickId = (el) => el.getAttribute('wkrad-id') || el.getAttribute('data-wkrad-id') || null;
        const isVisible = (el) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none';
        };
        const snapTxt = (el) => (el.innerText || el.textContent || '').trim().slice(0, 3000);

        const order = [];
        const add = (el, hint) => {
            if (!el || !isVisible(el)) return;
            const id = pickId(el);
            const role = (el.getAttribute('role') || '').toLowerCase();
            order.push({
                id,
                selector: id ? `[wkrad-id="${id}"], [data-wkrad-id="${id}"]` : null,
                role,
                text: snapTxt(el),
                hint,
                hasDetailBtn: !!el.querySelector?.('button.detail, .detail, [title="Detail"]'),
                hasCopyBtn: !!el.querySelector?.('button.copy, .copy, [title="Copy"]')
            });
        };

        // 1) spezifisch: wkAlertPopup
        document.querySelectorAll('.wkAlertPopup').forEach(el => add(el, 'wkAlertPopup'));

        // 2) generische Alerts
        document.querySelectorAll('.alert.alert-danger, .alert-danger, .alert-error, .notification-error')
            .forEach(el => add(el, 'alert-danger'));

        // 3) role=alert / aria-live
        document.querySelectorAll('[role="alert"], [aria-live="assertive"]').forEach(el => add(el, 'aria-alert'));

        // 4) Textheuristik in typischen Containern
        const reTxt = /(fehler|fehlgeschlagen|ungültig|validierung|warning|warnung|error|failed|exception)/i;
        document.querySelectorAll('.alert, .toast, .message, .notification, .banner')
            .forEach(el => {
                if (order.length >= lim) return;
                if (!isVisible(el)) return;
                const t = (el.innerText || el.textContent || '');
                if (reTxt.test(t)) add(el, 'text-hint');
            });

        // dedupe
        const seen = new Set();
        const out = [];
        for (const e of order) {
            const key = `${e.selector || e.text.slice(0, 160)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(e);
            if (out.length >= lim) break;
        }
        return out;
    }, limit);

    const score = (e) =>
        (e.hint === 'wkAlertPopup' ? 10 : 0) +
        (e.hint === 'alert-danger' ? 6 : 0) +
        (e.hint === 'aria-alert' ? 4 : 0) +
        (e.id ? 2 : 0) +
        (e.text ? Math.min(3, Math.ceil((e.text.length || 0) / 200)) : 0);

    return (errs || []).sort((a, b) => score(b) - score(a));
}

/**
 * Versucht, den Fehler aufzuklappen (Details anzeigen).
 * Für wkAlertPopup: klickt `.detail` und optional `.copy` (DOM-Text lesen wir ohnehin direkt).
 */
export async function openUiError(page, err) {
    try {
        const root = err?.selector
            ? page.locator(err.selector).first()
            : page.locator('.wkAlertPopup, .alert.alert-danger, .alert-danger').first();

        if (await root.count() === 0) return;

        const detailBtn = root.locator('button.detail, .detail, [title="Detail"]').first();
        if (await detailBtn.count() > 0) {
            await detailBtn.click({ timeout: 2000 }).catch(() => { });
            await page.waitForTimeout(200);
        }

        const copyBtn = root.locator('button.copy, .copy, [title="Copy"]').first();
        if (await copyBtn.count() > 0) {
            await copyBtn.click({ timeout: 2000 }).catch(() => { });
            await page.waitForTimeout(100);
        }
    } catch { /* noop */ }
}

/**
 * Liefert den vollständigen Text und die HTML des Fehlercontainers zurück.
 */
export async function getUiErrorContent(page, err) {
    try {
        const data = await page.evaluate((selOrNull) => {
            const pick = () => {
                if (selOrNull) {
                    const el = document.querySelector(selOrNull);
                    if (el) return el;
                }
                return document.querySelector('.wkAlertPopup') ||
                    document.querySelector('.alert.alert-danger') ||
                    document.querySelector('.alert-danger') ||
                    document.querySelector('[role="alert"]');
            };
            const el = pick();
            if (!el) return null;
            const text = (el.innerText || el.textContent || '').trim();
            const html = el.outerHTML || '';
            return { text, html };
        }, err?.selector || null);
        return data || { text: '', html: '' };
    } catch {
        return { text: '', html: '' };
    }
}
