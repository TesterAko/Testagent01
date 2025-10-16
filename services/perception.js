// services/perception.js
// ---------------------------------------------------------------------
// Zweck
// ------
// Zentralisierte UI-Fehlererkennung für exploratives & Story-Testing.
// - Pufferung von Console- und Request-Fehlern pro Page (WeakMap)
// - DOM-Scans nach typischen Fehlersignalen (Toast, Alert, Validation)
// - einfache Heuristik für "leere Grids"
//
// Öffentliche API
// ---------------
// - startPerception(page):   Attacht Event-Listener und initialisiert Puffer
// - detectUiErrors(page):    Liest Puffer & DOM, gibt erstes relevantes Finding zurück { type, detail }
// - flushPerception(page):   Leert die Puffer (z. B. nach Report)
// - stopPerception(page):    Entfernt Listener (optional)
//
// Hinweise
// --------
// - detectUiErrors() ist "lazy": Wenn noch nicht gestartet, wird startPerception(page) intern aufgerufen.
// - Keine externen Abhängigkeiten. Playwright Page-Objekt wird erwartet.
// - DOM-Selektoren sind konservativ & nicht projektspezifisch. Für eure App
//   können zusätzlich wkrad-id-basierte Toast/Alert-IDs ergänzt werden.
// ---------------------------------------------------------------------

/** @typedef {import('playwright').Page} Page */

const pageState = new WeakMap();
/**
 * Struktur:
 * {
 *   consoles: [{type:'error'|'warning', text, location?, ts}],
 *   requests: [{type:'failed'|'http-error', url, status?, method, ts}],
 *   pageErrors: [{message, name?, stack?, ts}]
 * }
 */

// -------------------------------
// Public API
// -------------------------------

/**
 * Listener anhängen und Puffer initialisieren.
 * @param {Page} page
 */
export function startPerception(page) {
    if (pageState.has(page)) return; // bereits aktiv

    const state = {
        consoles: [],
        requests: [],
        pageErrors: [],
        // Listener-Refs für sauberes teardown
        _onConsole: null,
        _onRequestFailed: null,
        _onResponse: null,
        _onPageError: null
    };

    state._onConsole = (msg) => {
        try {
            const type = (msg.type && msg.type()) || 'log';
            if (type !== 'error' && type !== 'warning') return;
            const text = msg.text ? msg.text() : String(msg);
            // location() kann fehlschlagen, daher try/catch
            let location = null;
            try { location = msg.location && msg.location(); } catch { }
            state.consoles.push({
                type,
                text: truncate(text, 800),
                location,
                ts: Date.now()
            });
            keepLast(state.consoles, 50);
        } catch { }
    };

    state._onRequestFailed = (req) => {
        try {
            state.requests.push({
                type: 'failed',
                url: safe(req.url()),
                method: safe(req.method && req.method()),
                errorText: safe(req.failure && req.failure()?.errorText),
                ts: Date.now()
            });
            keepLast(state.requests, 50);
        } catch { }
    };

    state._onResponse = (res) => {
        try {
            const status = res.status();
            if (status >= 500) {
                state.requests.push({
                    type: 'http-error',
                    url: safe(res.url()),
                    method: safe(res.request()?.method?.()),
                    status,
                    ts: Date.now()
                });
                keepLast(state.requests, 50);
            }
        } catch { }
    };

    state._onPageError = (err) => {
        try {
            state.pageErrors.push({
                message: safe(err?.message),
                name: safe(err?.name),
                stack: truncate(safe(err?.stack), 1200),
                ts: Date.now()
            });
            keepLast(state.pageErrors, 20);
        } catch { }
    };

    page.on('console', state._onConsole);
    page.on('requestfailed', state._onRequestFailed);
    page.on('response', state._onResponse);
    page.on('pageerror', state._onPageError);

    pageState.set(page, state);
}

/**
 * Liest Puffer & DOM und gibt das *erste relevante Finding* zurück – oder null.
 * @param {Page} page
 * @returns {Promise<null|{type:string, detail:object}>}
 */
export async function detectUiErrors(page) {
    ensureStarted(page);

    // 1) Harte Fehler prio: Uncaught Exceptions
    const uncaught = takeFirstUnreported(pageState.get(page).pageErrors);
    if (uncaught) {
        return {
            type: 'page-error',
            detail: uncaught
        };
    }

    // 2) Console-Errors
    const consoleErr = takeFirstUnreported(pageState.get(page).consoles, (e) => e.type === 'error');
    if (consoleErr) {
        return {
            type: 'console-error',
            detail: consoleErr
        };
    }

    // 3) HTTP 5xx / Requests failed
    const reqErr = takeFirstUnreported(pageState.get(page).requests, (r) => r.type === 'failed' || r.type === 'http-error');
    if (reqErr) {
        return {
            type: reqErr.type === 'failed' ? 'network-failed' : 'http-5xx',
            detail: reqErr
        };
    }

    // 4) DOM-basierte Hinweise: Fehlertoasts, Alerts, Validierungen
    const domFinding = await scanDomForProblems(page);
    if (domFinding) return domFinding;

    // 5) Leere Grids/Tabellen (Heuristik)
    const emptyGrid = await detectEmptyGrid(page);
    if (emptyGrid) return emptyGrid;

    return null;
}

/**
 * Puffer leeren (z. B. nach erfolgreichem Report).
 * @param {Page} page
 */
export function flushPerception(page) {
    const st = pageState.get(page);
    if (!st) return;
    st.consoles.length = 0;
    st.requests.length = 0;
    st.pageErrors.length = 0;
}

/**
 * Listener entfernen und Puffer verwerfen.
 * @param {Page} page
 */
export function stopPerception(page) {
    const st = pageState.get(page);
    if (!st) return;

    try { st._onConsole && page.off('console', st._onConsole); } catch { }
    try { st._onRequestFailed && page.off('requestfailed', st._onRequestFailed); } catch { }
    try { st._onResponse && page.off('response', st._onResponse); } catch { }
    try { st._onPageError && page.off('pageerror', st._onPageError); } catch { }

    pageState.delete(page);
}

// -------------------------------
// Interne Helfer
// -------------------------------

function ensureStarted(page) {
    if (!pageState.has(page)) startPerception(page);
}

function keepLast(arr, max) {
    if (arr.length > max) arr.splice(0, arr.length - max);
}

function truncate(s, max) {
    s = String(s ?? '');
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function safe(x) {
    if (x == null) return null;
    try { return typeof x === 'string' ? x : String(x); } catch { return null; }
}

function markReported(item) {
    if (!item) return;
    item._reported = true;
}

function takeFirstUnreported(list, predicate = () => true) {
    if (!Array.isArray(list)) return null;
    for (const it of list) {
        if (it && !it._reported && predicate(it)) {
            markReported(it);
            return it;
        }
    }
    return null;
}

// -------------------------------
// DOM-Scanner
// -------------------------------

/**
 * Sucht nach sichtbaren Fehlertoasts/Alerts/Validierungshinweisen.
 * Berücksichtigt auch mögliche wkrad-/data-wkrad-id Patterns.
 * @param {Page} page
 */
async function scanDomForProblems(page) {
    try {
        const res = await page.evaluate(() => {
            function isVisible(el) {
                const r = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            }

            const findings = [];

            // 1) Typische Toasts/Alerts nach Klassen/Aria
            const toastSelectors = [
                '.toast.toast-error',
                '.toast-error',
                '.alert.alert-error',
                '.alert-error',
                '[role="alert"]',
                '[aria-live="assertive"]'
            ];
            for (const sel of toastSelectors) {
                document.querySelectorAll(sel).forEach(el => {
                    if (!isVisible(el)) return;
                    const text = (el.innerText || '').trim();
                    if (!text) return;
                    findings.push({ type: 'toast-error', text: text.slice(0, 300), selector: sel });
                });
            }

            // 2) Validierungsfehler an Inputs (aria-invalid / Fehlermeldungen in Nähe)
            const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
            inputs.forEach(input => {
                if (!isVisible(input)) return;
                const invalid = input.getAttribute('aria-invalid') === 'true' || input.classList.contains('is-invalid');
                if (!invalid) return;

                // Fehlermeldung nahe dem Element suchen
                let msg = '';
                const describedBy = input.getAttribute('aria-describedby');
                if (describedBy) {
                    describedBy.split(/\s+/).forEach(id => {
                        const el = document.getElementById(id);
                        if (el && isVisible(el)) msg += ' ' + (el.innerText || '').trim();
                    });
                }
                // Fallback: siblings mit .error, .invalid
                if (!msg) {
                    const sibErr = input.closest('.form-group, .field, .input-group')?.querySelector('.error, .invalid-feedback, .validation-error');
                    if (sibErr && isVisible(sibErr)) msg = (sibErr.innerText || '').trim();
                }

                findings.push({
                    type: 'validation',
                    text: msg || 'Ungültige Eingabe markiert',
                    wkradId: input.getAttribute('wkrad-id') || input.getAttribute('data-wkrad-id') || null
                });
            });

            // 3) wkrad-id-basiert: generische Fehlermarker (falls App solche hat)
            const wkradErrorHints = [
                // Beispielhafte IDs; bei Bedarf projektspezifisch ergänzen
                'Toast.Error', 'Alert.Error', 'Validation.Error'
            ];
            wkradErrorHints.forEach(id => {
                const el = document.querySelector(`[wkrad-id="${id}"], [data-wkrad-id="${id}"]`);
                if (el && isVisible(el)) {
                    findings.push({ type: 'toast-error', text: (el.innerText || '').trim().slice(0, 300), wkradId: id });
                }
            });

            return findings[0] || null;
        });

        if (res) {
            return { type: res.type, detail: res };
        }
    } catch {
        // DOM-Scan darf nie den Lauf crashen
    }
    return null;
}

/**
 * Heuristik: erkennt "leere" Grids/Tabellen (kein Daten-Row, aber Grid sichtbar)
 * @param {Page} page
 */
async function detectEmptyGrid(page) {
    try {
        const res = await page.evaluate(() => {
            function isVisible(el) {
                const r = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            }

            // Kandidaten: Tabellen/Grids mit Header aber ohne Datenzeilen
            const tables = Array.from(document.querySelectorAll('table'));
            for (const t of tables) {
                if (!isVisible(t)) continue;
                const hasHeader = !!t.querySelector('thead th, tr th');
                const dataRows = t.querySelectorAll('tbody tr');
                const visibleRows = Array.from(dataRows).filter(r => isVisible(r));
                if (hasHeader && visibleRows.length === 0) {
                    // leere Tabelle → nur dann melden, wenn es nicht explizit ein "no data"-Hint gibt
                    const noDataHint = t.closest('.grid, .table-wrapper, .datatable')?.querySelector('.no-data, .empty, .placeholder, [wkrad-id="Grid.NoData"], [data-wkrad-id="Grid.NoData"]');
                    if (!noDataHint || !isVisible(noDataHint)) {
                        return {
                            type: 'empty-grid',
                            selector: 'table',
                            text: 'Tabelle sichtbar, aber keine Datenzeilen gefunden.'
                        };
                    }
                }
            }

            return null;
        });

        if (res) return { type: res.type, detail: res };
    } catch { }
    return null;
}
