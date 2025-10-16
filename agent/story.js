// agent/story.js
// US-Story-Runner (führt vordefinierte Flows/Stories aus knowledge.json aus)
// - nutzt BugReporter (services/bug-reporter.js) für Bug-Reports
// - Session-Logging via agent/reporter.js
// - UI-Error-Erkennung via services/ui-errors.js
//
// Node: ESM

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

import { AuthService } from '../services/auth.js';
import { executeActions } from '../browser/action-executor.js';

import {
    recordPageState,
    makeNodeKey,
    upsertNode,
    addEdge,
    recordError
} from '../memory/memory.js';

import { detectUiErrors, openUiError, getUiErrorContent } from '../services/ui-errors.js';
import { BugReporter } from '../services/bug-reporter.js';

import { startSession, appendStep, appendError, endSession } from './reporter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() === 'true';

const MEM_DIR = path.resolve(__dirname, '../memory');
const FILE_KNOWLEDGE_JSON = path.join(MEM_DIR, 'knowledge.json');

function nowIso() { return new Date().toISOString(); }

async function loadKnowledge() {
    try {
        const k = await fs.readJson(FILE_KNOWLEDGE_JSON);
        return {
            elements: k?.elements || {},
            flows: Array.isArray(k?.flows) ? k.flows : []
        };
    } catch {
        return { elements: {}, flows: [] };
    }
}

function toSelector(id) {
    return `[wkrad-id="${id}"], [data-wkrad-id="${id}"]`;
}

function inferIntentFromStep(step = {}) {
    const id = step.id || '';
    const t = step.type || 'click';
    if (/auftrag|sendung|lieferschein|abholung|anlieferung/i.test(id)) return 'Auftragskontext prüfen';
    if (/tour|route|routing|karte|map/i.test(id)) return 'Routen-/Kartenkontext prüfen';
    if (/kunde|kunden|partner/i.test(id)) return 'Kunden-/Partnerkontext prüfen';
    if (t === 'fill') return 'Formularfeld ausfüllen';
    if (t === 'select') return 'Auswahl treffen';
    if (t === 'press') return `Taste drücken (${step.key || 'Enter'})`;
    return 'Navigation/Interaktion ausführen';
}

async function recordState(page, extra = {}) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[wkrad-id], [data-wkrad-id]'))
            .slice(0, 120)
            .map(el => el.getAttribute('wkrad-id') || el.getAttribute('data-wkrad-id'))
            .filter(Boolean)
    );
    const sig = await recordPageState({ url, title, visibleIds: ids, extra });
    return { url, title, ids, sig };
}

/**
 * Führt eine einzelne Story (= Flow) aus.
 * steps: [{id, selector?, type, value?, key?}, ...]
 */
async function runSingleStory({ page, flow, session, bugReporter }) {
    const name = flow?.name || 'Unnamed-Story';
    console.log(`[Story] Starte: ${name}`);

    let nodeA = await makeNodeKey(page);
    await upsertNode(nodeA, `Story:${name}`);
    let before = await recordState(page, { phase: 'story-start', story: name });

    const recentSteps = [];

    const pushRecent = (entry) => {
        recentSteps.push(entry);
        if (recentSteps.length > 20) recentSteps.shift();
    };

    for (let i = 0; i < (flow.steps || []).length; i++) {
        const s = flow.steps[i] || {};
        const action = {
            type: s.type || 'click',
            id: s.id || null,
            selector: s.selector || (s.id ? toSelector(s.id) : null),
            value: s.value,
            key: s.key,
            source: 'story'
        };
        const intent = inferIntentFromStep(action);

        console.log(`[Story] Schritt ${i + 1}/${flow.steps.length}: KI-Absicht: ${intent}`);
        console.log(`[Story] Schritt ${i + 1}/${flow.steps.length}: Ausführen -> ${action.type} auf ${action.id || action.selector}`);
        await appendStep(session.filePath, { phase: 'try', story: name, index: i + 1, intent, action });

        try {
            await executeActions(page, [action], `story-${name}-${i + 1}`);

            const after = await recordState(page, { phase: 'story-after', story: name, index: i + 1, action });
            const nodeB = await makeNodeKey(page);
            await upsertNode(nodeB);
            await addEdge(nodeA, nodeB, action);

            const stateChanged = (before.url !== after.url) || (before.title !== after.title) || (before.sig !== after.sig);
            pushRecent({ intent, action, before, after, outcome: stateChanged ? 'progress' : 'nostate' });

            if (stateChanged) {
                console.log(`[Story] ✅ Fortschritt: Node ${nodeA} -> ${nodeB} | URL "${before.url}" -> "${after.url}"`);
            } else {
                console.log(`[Story] ➖ Kein Zustandswechsel (nostate) | URL bleibt "${after.url}"`);
            }

            // UI-Fehler prüfen
            const uiErrors = await detectUiErrors(page, { limit: 4 });
            if (uiErrors.length) {
                const first = uiErrors[0];
                await openUiError(page, first);
                const content = await getUiErrorContent(page, first);

                const expected = `Schritt ${i + 1}: "${intent}" sollte ohne UI-Fehler durchlaufen.`;
                const actual = `UI-Fehler erkannt${first.id ? ` (id=${first.id})` : ''} – Quelle=${first.hint}\n` +
                    `Text:\n${(content?.text || first.text || '').slice(0, 4000)}\n`;

                const rep = await bugReporter.reportUiError({
                    page,
                    uiError: { ...first, text: content?.text || first.text || '' },
                    lastSteps: recentSteps.slice(-5),
                    expected,
                    actual,
                    context: { story: name, index: i + 1, nodeA, nodeB },
                    title: `Story UI-Fehler (${name})`
                });

                await appendError(session.filePath, {
                    type: 'ui-error',
                    story: name,
                    index: i + 1,
                    action,
                    report: rep
                });
                console.log(`[Story] 🚨 UI-Fehler protokolliert (Report: ${rep.jsonPath})`);
            }

            nodeA = nodeB;
            before = after;

        } catch (err) {
            // Ausführungsfehler → BugReport
            const rep = await bugReporter.reportExecError({
                page,
                error: err,
                lastSteps: recentSteps.slice(-5),
                expected: `Schritt ${i + 1}: "${intent}" sollte fehlerfrei laufen.`,
                actual: `Exception: ${String(err?.message || err)}`,
                context: { story: name, index: i + 1, nodeA },
                title: `Story Ausführungsfehler (${name})`
            });

            await appendError(session.filePath, {
                type: 'exec-error',
                story: name,
                index: i + 1,
                action,
                report: rep
            });

            await recordError({
                type: 'story-exec',
                message: String(err?.message || err),
                stack: String(err?.stack || ''),
                screenshotPath: rep.imagePath,
                pageUrl: page.url(),
                context: { story: name, index: i + 1, action }
            });

            console.log(`[Story] ❌ Fehler in Schritt ${i + 1}: ${String(err?.message || err)}`);
            // Story fortsetzen? Hier brechen wir ab – passe es an, wenn du „continue on error“ willst.
            break;
        }
    }

    console.log(`[Story] Ende: ${name}`);
}

/**
 * Öffentliche Runner-API
 * - runs alle Flows aus knowledge.json
 */
export async function runUserStories({ baseUrl = BASE_URL, headless = HEADLESS } = {}) {
    const { flows } = await loadKnowledge();
    if (!flows.length) {
        console.log('[Story] Keine Flows in memory/knowledge.json gefunden.');
        return;
    }

    let browser, context, page;
    const session = await startSession('stories');
    const bugReporter = new BugReporter({});

    try {
        browser = await chromium.launch({ headless });
        context = await browser.newContext();
        page = await context.newPage();

        const auth = new AuthService();
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await auth.ensureLoggedIn(page);

        // Stories nacheinander ausführen
        for (const flow of flows) {
            await runSingleStory({ page, flow, session, bugReporter });
        }

        await endSession(session.filePath, { result: 'finished', stories: flows.length, endedAt: nowIso() });

    } catch (fatal) {
        await appendError(session.filePath, { type: 'fatal', message: String(fatal?.message || fatal) });
        throw fatal;

    } finally {
        if (browser) await browser.close().catch(() => { });
    }
}

// Aliase, damit index.js flexibel bleibt:
export async function runStoryMode(opts) { return runUserStories(opts); }
export async function runStories(opts) { return runUserStories(opts); }
export async function run(opts) { return runUserStories(opts); }

// Alias, damit index.js mit runUserStory (singular) weiter funktioniert
export async function runUserStory(opts) {
    return runUserStories(opts);
}