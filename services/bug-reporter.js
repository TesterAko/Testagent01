// services/bug-reporter.js
// ----------------------------------------------------------------------
// Zweck
// ------
// Einheitliches Bug-Reporting für alle Modi:
//  - UI-Fehler (Toasts, Validierung, JS-Errors, HTTP-5xx, leere Grids, ...)
//  - Ausführungsfehler (Action fehlgeschlagen)
//  - Freiform-Reports (Custom)
// Mit:
//  - konsistenten Dateinamen & Ordnerstruktur
//  - Screenshot (optional Fullpage)
//  - DOM-Snippet (kontextual, begrenzt)
//  - Repro-Steps aus History
//  - KI-Zusammenfassung (knapp, deutsch)
//
// ENV/Config (optional):
//  - REPORT_DIR=./reports
//  - REPORT_FULLPAGE=false
//  - REPORT_MAX_DOM_CHARS=6000
//  - REPORT_MAX_HISTORY=30
//  - REPORT_MODEL= (z. B. gpt-5-reasoner)
// ----------------------------------------------------------------------

import * as fs from 'fs-extra';
import path from 'path';
import { chat } from './llm.js';

const REPORT_DIR = process.env.REPORT_DIR || './reports';
const REPORT_FULLPAGE = String(process.env.REPORT_FULLPAGE || 'false').toLowerCase() === 'true';
const REPORT_MAX_DOM_CHARS = Number(process.env.REPORT_MAX_DOM_CHARS || 6000);
const REPORT_MAX_HISTORY = Number(process.env.REPORT_MAX_HISTORY || 30);
const REPORT_MODEL = process.env.REPORT_MODEL || process.env.LLM_MODEL || undefined;

/**
 * Haupt-API
 * ---------
 * reportUiError({ page, sessionId, uiError, recentSteps, meta? })
 * reportExecError({ page, sessionId, error, recentSteps, meta? })
 * reportCustom({ page, sessionId, title, payload, recentSteps, meta? })
 */
export const BugReporter = {
    reportUiError,
    reportExecError,
    reportCustom,
};

// ----------------------------------------------------------------------
// Öffentliche Funktionen
// ----------------------------------------------------------------------

/**
 * Meldet einen UI-Fehler (detektiert durch perception).
 * @param {Object} args
 * @param {import('playwright').Page} args.page
 * @param {string} args.sessionId
 * @param {{type:string, detail:object}} args.uiError
 * @param {Array<{wkradId?:string, actionType:string, value?:string, url?:string, t?:number}>} [args.recentSteps]
 * @param {Object} [args.meta]
 */
async function reportUiError({ page, sessionId, uiError, recentSteps = [], meta = {} }) {
    const now = Date.now();
    const url = safeUrl(page);
    const kind = `ui-${uiError?.type || 'unknown'}`;
    const severity = classifySeverity(kind, uiError?.detail);

    const dir = await ensureReportDir(sessionId, now, kind);
    const nameBase = buildNameBase(now, kind);

    const screenshotPath = path.join(dir, `${nameBase}.png`);
    const domPath = path.join(dir, `${nameBase}.dom.html`);
    const metaPath = path.join(dir, `${nameBase}.json`);
    const summaryPath = path.join(dir, `${nameBase}.summary.md`);

    // 1) Screenshot
    await takeScreenshot(page, screenshotPath);

    // 2) DOM-Snippet: falls wkradId im Detail vorhanden, versuche regionalen Ausschnitt
    const domHtml = await collectDomSnippet(page, uiError?.detail?.wkradId);
    await fs.outputFile(domPath, domHtml, 'utf8');

    // 3) Roh-Metadaten
    const payload = {
        kind,
        severity,
        when: new Date(now).toISOString(),
        sessionId,
        url,
        detail: uiError?.detail || null,
        meta: meta || {},
        steps: trimHistory(recentSteps),
    };
    await fs.outputJson(metaPath, payload, { spaces: 2 });

    // 4) KI-Zusammenfassung & Repro-Steps (Markdown)
    const md = await buildSummaryMarkdown({
        title: `UI-Fehler: ${kind}`,
        url,
        severity,
        detail: uiError?.detail,
        steps: payload.steps
    });
    await fs.outputFile(summaryPath, md, 'utf8');

    console.log(`🐞 UI-Report gespeichert: ${summaryPath}`);
}

/**
 * Meldet einen Ausführungsfehler (z. B. Click/Fill schlug fehl).
 * @param {Object} args
 * @param {import('playwright').Page} args.page
 * @param {string} args.sessionId
 * @param {Error|string} args.error
 * @param {Array} [args.recentSteps]
 * @param {Object} [args.meta]
 */
async function reportExecError({ page, sessionId, error, recentSteps = [], meta = {} }) {
    const now = Date.now();
    const url = safeUrl(page);
    const kind = 'exec-error';
    const severity = classifySeverity(kind, { message: String(error?.message || error || '') });

    const dir = await ensureReportDir(sessionId, now, kind);
    const nameBase = buildNameBase(now, kind);

    const screenshotPath = path.join(dir, `${nameBase}.png`);
    const domPath = path.join(dir, `${nameBase}.dom.html`);
    const metaPath = path.join(dir, `${nameBase}.json`);
    const summaryPath = path.join(dir, `${nameBase}.summary.md`);

    await takeScreenshot(page, screenshotPath);

    const domHtml = await collectDomSnippet(page, meta?.action?.wkradId);
    await fs.outputFile(domPath, domHtml, 'utf8');

    const payload = {
        kind,
        severity,
        when: new Date(now).toISOString(),
        sessionId,
        url,
        error: serializeError(error),
        meta: meta || {},
        steps: trimHistory(recentSteps),
    };
    await fs.outputJson(metaPath, payload, { spaces: 2 });

    const md = await buildSummaryMarkdown({
        title: `Ausführungsfehler`,
        url,
        severity,
        detail: payload.error,
        steps: payload.steps
    });
    await fs.outputFile(summaryPath, md, 'utf8');

    console.log(`🐞 Exec-Report gespeichert: ${summaryPath}`);
}

/**
 * Freiform-Report, wenn du manuell etwas melden willst.
 */
async function reportCustom({ page, sessionId, title, payload = {}, recentSteps = [], meta = {} }) {
    const now = Date.now();
    const url = safeUrl(page);
    const kind = 'custom';
    const severity = classifySeverity(kind, payload);

    const dir = await ensureReportDir(sessionId, now, kind);
    const nameBase = buildNameBase(now, sanitizeTitle(title) || kind);

    const screenshotPath = path.join(dir, `${nameBase}.png`);
    const domPath = path.join(dir, `${nameBase}.dom.html`);
    const metaPath = path.join(dir, `${nameBase}.json`);
    const summaryPath = path.join(dir, `${nameBase}.summary.md`);

    await takeScreenshot(page, screenshotPath);

    const domHtml = await collectDomSnippet(page, payload?.wkradId);
    await fs.outputFile(domPath, domHtml, 'utf8');

    const data = {
        kind,
        severity,
        title,
        when: new Date(now).toISOString(),
        sessionId,
        url,
        payload,
        meta,
        steps: trimHistory(recentSteps),
    };
    await fs.outputJson(metaPath, data, { spaces: 2 });

    const md = await buildSummaryMarkdown({
        title: title || 'Bugreport',
        url,
        severity,
        detail: payload,
        steps: data.steps
    });
    await fs.outputFile(summaryPath, md, 'utf8');

    console.log(`🐞 Custom-Report gespeichert: ${summaryPath}`);
}

// ----------------------------------------------------------------------
// Interne Helfer
// ----------------------------------------------------------------------

function serializeError(err) {
    if (!err) return null;
    return {
        message: String(err?.message || err),
        name: err?.name || undefined,
        stack: err?.stack ? String(err.stack).split('\n').slice(0, 20).join('\n') : undefined,
    };
}

function sanitizeTitle(t) {
    if (!t) return '';
    return String(t).replace(/[^\w\-.]+/g, '_').slice(0, 60);
}

function buildNameBase(ts, kind) {
    const d = new Date(ts);
    const stamp = [
        d.getFullYear(),
        pad2(d.getMonth() + 1),
        pad2(d.getDate()),
        '-',
        pad2(d.getHours()),
        pad2(d.getMinutes()),
        pad2(d.getSeconds())
    ].join('');
    return `${stamp}-${kind}`;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

async function ensureReportDir(sessionId, ts, kind) {
    const day = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
    const dir = path.join(REPORT_DIR, day, sessionId, kind);
    await fs.ensureDir(dir);
    return dir;
}

async function takeScreenshot(page, filePath) {
    try {
        await page.screenshot({
            path: filePath,
            fullPage: REPORT_FULLPAGE
        });
    } catch (e) {
        // wenn Fullpage fehlschlägt, versuche normalen Viewport
        try {
            await page.screenshot({ path: filePath, fullPage: false });
        } catch { }
    }
}

function trimHistory(history) {
    if (!Array.isArray(history)) return [];
    const h = history.slice(-REPORT_MAX_HISTORY);
    // kompakter machen
    return h.map(({ wkradId, actionType, value, url, t }) => ({
        t, url, actionType, wkradId, value
    }));
}

function safeUrl(page) {
    try { return page.url(); } catch { return ''; }
}

/**
 * Holt ein DOM-Snippet:
 * - wenn wkradId gegeben: versucht, das Element + Umfeld (outerHTML + next/prev siblings) zu dumpen
 * - sonst: <body> (begrenzt)
 */
async function collectDomSnippet(page, focusWkradId) {
    try {
        const html = await page.evaluate((id, limit) => {
            const clamp = (s, n) => (s.length <= n ? s : s.slice(0, n) + '…');

            function nodeHtml(el) {
                if (!el) return '';
                return el.outerHTML || el.innerHTML || '';
            }

            let out = '';
            if (id) {
                const el = document.querySelector(`[wkrad-id="${id}"], [data-wkrad-id="${id}"]`);
                if (el) {
                    const prev = el.previousElementSibling;
                    const next = el.nextElementSibling;
                    out += `<!-- Focus: ${id} -->\n`;
                    out += clamp(nodeHtml(prev), limit / 4) + '\n';
                    out += clamp(nodeHtml(el), limit / 2) + '\n';
                    out += clamp(nodeHtml(next), limit / 4) + '\n';
                    return out;
                }
            }
            // Fallback: Body
            const body = document.querySelector('body');
            out = nodeHtml(body);
            return clamp(out, limit);
        }, focusWkradId || null, REPORT_MAX_DOM_CHARS);

        return html || '';
    } catch {
        return '';
    }
}

/**
 * Sehr einfache Schweregrad-Heuristik.
 * Du kannst das später mit LLM veredeln.
 */
function classifySeverity(kind, detail) {
    const k = String(kind || '').toLowerCase();
    const msg = JSON.stringify(detail || {}).toLowerCase();

    // harte Kandidaten → high
    if (k.includes('page-error')) return 'high';
    if (k.includes('http-5xx')) return 'high';
    if (msg.includes('uncaught') || msg.includes('referenceerror') || msg.includes('typeerror')) return 'high';

    // exec-error mit Timeout → medium
    if (k.includes('exec-error') && (msg.includes('timeout') || msg.includes('wait'))) return 'medium';

    // empty-grid/validation → low/medium
    if (k.includes('empty-grid')) return 'medium';
    if (k.includes('validation')) return 'low';

    // default
    return 'medium';
}

/**
 * Erstellt eine kurze, deutschsprachige Markdown-Zusammenfassung inkl. Repro-Steps.
 * Nutzt LLM, wenn konfiguriert, sonst statische Fassung.
 */
async function buildSummaryMarkdown({ title, url, severity, detail, steps }) {
    const header = `# ${escapeMd(title || 'Bugreport')}\n\n- **Schweregrad:** ${severity}\n- **URL:** ${escapeMd(url || '')}\n- **Zeit:** ${new Date().toISOString()}\n\n`;

    const stepsMd = stepsToMarkdown(steps);

    if (!REPORT_MODEL) {
        // Fallback ohne LLM
        return (
            header +
            '## Kurzbeschreibung\n' +
            'Automatisch generierter Report ohne KI-Zusammenfassung.\n\n' +
            '## Details\n' +
            '```json\n' + safeJson(detail) + '\n```\n\n' +
            '## Repro-Steps\n' + stepsMd
        );
    }

    try {
        const sys = [
            'Du bist ein präziser QA-Assistent. Fasse den Fehler kurz und prägnant zusammen.',
            'Sprache: Deutsch. Max. 6 Sätze.',
            'Nutze die Repro-Steps, um eine knappe, überprüfbare Beschreibung zu erstellen.',
            'Kein Marketing-Blabla.'
        ].join('\n');

        const user = {
            title, url, severity,
            detail,
            steps
        };

        const res = await chat({
            system: sys,
            messages: [
                { role: 'user', content: JSON.stringify(user, null, 2) }
            ],
            model: REPORT_MODEL
        });

        const summary = (res && res.text ? String(res.text).trim() : '') || 'Keine KI-Zusammenfassung verfügbar.';
        return (
            header +
            '## Kurzbeschreibung (KI)\n' + summary + '\n\n' +
            '## Details\n' +
            '```json\n' + safeJson(detail) + '\n```\n\n' +
            '## Repro-Steps\n' + stepsMd
        );
    } catch {
        // Fallback bei LLM-Fehlern
        return (
            header +
            '## Kurzbeschreibung\n' +
            'Automatisch generierter Report (KI nicht verfügbar).\n\n' +
            '## Details\n' +
            '```json\n' + safeJson(detail) + '\n```\n\n' +
            '## Repro-Steps\n' + stepsMd
        );
    }
}

function stepsToMarkdown(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return '_Keine Schritte erfasst._\n';
    const lines = steps.map((s, i) => {
        const ts = s.t ? new Date(s.t).toISOString().split('T')[1].replace('Z', '') : '';
        const val = s.value ? ` value="${escapeMd(String(s.value))}"` : '';
        const url = s.url ? ` (${escapeMd(s.url)})` : '';
        return `${i + 1}. [${ts}] ${s.actionType} ${s.wkradId || ''}${val}${url}`;
    });
    return lines.join('\n') + '\n';
}

function safeJson(obj) {
    try {
        return JSON.stringify(obj ?? {}, null, 2);
    } catch {
        return '{}';
    }
}

function escapeMd(s) {
    return String(s || '').replace(/([_*`])/g, '\\$1');
}
