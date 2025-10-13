// agent/explorer.js
// Autonomer Explorer:
// - Login via AuthService (ENV/.env + memory/credentials.json), keine Rückfragen
// - Strict wkrad-id only
// - Lernend: baut Nav-Graph & Page-States über memory/memory.js auf
// - Fehler -> Screenshot + recordError
// - Skip destruktive Aktionen, es sei denn ALLOW_DESTRUCTIVE=true
//
// Node: ESM

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

import { AuthService } from '../services/auth.js';
import {
    makeNodeKey,
    upsertNode,
    addEdge,
    nextTargets,
    recordPageState,
    recordError,
} from '../memory/memory.js';

import { executeActions } from '../browser/action-executor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------- Config / Defaults --------------------------------------------------

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() === 'true';
const MAX_STEPS = Number(process.env.MAX_STEPS || 60);
const ALLOW_DESTRUCTIVE = String(process.env.ALLOW_DESTRUCTIVE || 'false').toLowerCase() === 'true';

const SCREEN_DIR = path.resolve(__dirname, '../test-output/screenshots');
await fs.ensureDir(SCREEN_DIR);

// -------- Helpers ------------------------------------------------------------

function isDestructiveId(id) {
    if (ALLOW_DESTRUCTIVE) return false;
    // konservative Heuristik (Deutsch/Englisch)
    const bad = /(delete|remove|destroy|drop|truncate|erase|unlink|void|submit|save|speichern|löschen|entfernen|abschicken|übernehmen|bestätigen)/i;
    return bad.test(id || '');
}

async function visibleWkradIds(page, limit = 60) {
    const ids = await page.evaluate((lim) => {
        const isVisible = (el) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled;
        };
        return Array.from(document.querySelectorAll('[wkrad-id], [data-wkrad-id]'))
            .filter(isVisible)
            .slice(0, lim)
            .map(el => el.getAttribute('wkrad-id') || el.getAttribute('data-wkrad-id'))
            .filter(Boolean);
    }, limit);
    return ids;
}

function toSelector(id) {
    return `[wkrad-id="${id}"], [data-wkrad-id="${id}"]`;
}

function dedupeBySelector(actions) {
    const seen = new Set();
    return actions.filter(a => {
        const key = `${a.type}:${a.selector}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// DOM-Discovery: generiert sichere, nicht-destruktive Default-Aktionen
async function discoverActions(page, limit = 8) {
    const actions = await page.evaluate((lim) => {
        const isVisible = (el) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled;
        };
        const pick = (id) => `[wkrad-id="${id}"], [data-wkrad-id="${id}"]`;

        const out = [];
        const els = Array.from(document.querySelectorAll('[wkrad-id], [data-wkrad-id]')).filter(isVisible);

        for (const el of els) {
            const id = el.getAttribute('wkrad-id') || el.getAttribute('data-wkrad-id');
            if (!id) continue;
            const tag = el.tagName.toLowerCase();
            const role = (el.getAttribute('role') || '').toLowerCase();
            const type = (el.getAttribute('type') || '').toLowerCase();

            if (tag === 'button' || role === 'button' || tag === 'a') {
                out.push({ type: 'click', selector: pick(id), id });
            } else if (tag === 'input' && (type === 'text' || type === 'email' || type === 'search')) {
                out.push({ type: 'fill', selector: pick(id), value: 'test', id });
            } else if (tag === 'select') {
                out.push({ type: 'select', selector: pick(id), value: '', id }); // leere Option → sicher
            }
            if (out.length >= lim) break;
        }
        return out;
    }, limit);

    // Filter destruktive Kandidaten
    const safe = actions.filter(a => !/(password|passwort)/i.test(a.id || ''));
    return safe;
}

// -------- Explorer -----------------------------------------------------------

export class Explorer {
    constructor({ baseUrl = BASE_URL, headless = HEADLESS } = {}) {
        this.baseUrl = baseUrl;
        this.headless = headless;
        this.auth = new AuthService();
        this._attempted = new Map();
    }

    async _screenshot(page, label) {
        const file = path.join(SCREEN_DIR, `${Date.now()}_${label || 'shot'}.png`);
        try { await page.screenshot({ path: file, fullPage: true }); } catch { }
        return file;
    }

    _markAttempt(nodeKey, selector) {
        if (!selector) return;
        const set = this._attempted.get(nodeKey) || new Set();
        set.add(selector);
        this._attempted.set(nodeKey, set);
    }

    _wasAttempted(nodeKey, selector) {
        if (!selector) return false;
        const set = this._attempted.get(nodeKey);
        return set ? set.has(selector) : false;
    }

    async _recordState(page, extra = {}) {
        const url = page.url();
        const title = await page.title().catch(() => '');
        const ids = await visibleWkradIds(page, 80);
        const sig = await recordPageState({ url, title, visibleIds: ids, extra });
        return { url, title, ids, sig };
    }

    // kombiniert: 1) Memory-Targets (untererforschte Kanten) 2) Fresh Discovery
    async _planNextActions(page, nodeKey, limit = 8) {
        const memTargets = await nextTargets(nodeKey, Math.max(2, Math.floor(limit / 2))) || [];
        const disc = await discoverActions(page, limit);
        const merged = [
            // Memory-Targets zuerst (falls noch sichtbar)
            ...memTargets
                .filter(a => a && a.selector)
                .map(a => ({ ...a, source: 'memory' })),
            // dann neue Kandidaten
            ...disc.map(a => ({ ...a, source: 'discover' })),
        ]
            .filter(a => !isDestructiveId(a?.id)) // Sicherheitsfilter
            .filter(Boolean);

        const deduped = dedupeBySelector(merged);
        const fresh = deduped.filter(a => !this._wasAttempted(nodeKey, a.selector));
        const prioritized = fresh.length ? fresh : deduped;

        return prioritized.slice(0, limit);
    }

    async run({ page: extPage } = {}) {
        let browser, page;

        try {
            if (!extPage) {
                browser = await chromium.launch({ headless: this.headless });
                const ctx = await browser.newContext();
                page = await ctx.newPage();
                await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            } else {
                page = extPage;
            }

            // --- 1) Login ohne Rückfragen ---
            await this.auth.ensureLoggedIn(page);

            // --- 2) Ersten State/NodKey erfassen ---
            let nodeA = await makeNodeKey(page);
            await upsertNode(nodeA, 'Start');
            await this._recordState(page, { phase: 'start' });

            // --- 3) Exploration Loop ---
            for (let step = 0; step < MAX_STEPS; step++) {
                // Plan
                const plans = await this._planNextActions(page, nodeA, 8);
                if (!plans.length) {
                    // nichts Sichtbares mehr → fertig
                    break;
                }

                // Wähle erste sichere Aktion und markiere sie, damit wir sie nicht endlos wiederholen
                const action = plans[0];
                this._markAttempt(nodeA, action?.selector);

                try {
                    const ctx = page.context();
                    const popupPromise = ctx.waitForEvent('page', { timeout: 4000 }).catch(() => null);

                    // Execute (immer 1 Aktion, damit Nav-Graph präzise bleibt)
                    await executeActions(page, [action], `auto-step-${step}`);

                    // kleine Wartezeit + Netzleerlauf
                    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

                    const popup = await popupPromise;
                    if (popup) {
                        await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => { });
                        page = popup;
                    }

                    // Nachher: neuer Knoten
                    const nodeB = await makeNodeKey(page);
                    await upsertNode(nodeB);
                    await addEdge(nodeA, nodeB, action);

                    await this._recordState(page, { phase: 'after', step, action });

                    // weiter vom neuen Knoten aus
                    nodeA = nodeB;
                } catch (err) {
                    const shot = await this._screenshot(page, `error_step_${step}`);
                    await recordError({
                        type: 'explore-exec',
                        message: String(err?.message || err),
                        stack: String(err?.stack || ''),
                        screenshotPath: shot,
                        pageUrl: page.url(),
                        context: { step, action }
                    });
                    // versuche mit nächster Aktion weiterzumachen
                    continue;
                }
            }

        } catch (fatal) {
            // Top-Level Fehler
            try {
                if (page) {
                    const shot = await this._screenshot(page, 'fatal');
                    await recordError({
                        type: 'explore-fatal',
                        message: String(fatal?.message || fatal),
                        stack: String(fatal?.stack || ''),
                        screenshotPath: shot,
                        pageUrl: page?.url?.() || '',
                        context: { baseUrl: this.baseUrl }
                    });
                }
            } catch { }
            throw fatal;
        } finally {
            if (browser) await browser.close().catch(() => { });
        }
    }
}

// Bequemer Compatibility-Export
export async function runExploration(opts) {
    const ex = new Explorer();
    await ex.run(opts);
}
