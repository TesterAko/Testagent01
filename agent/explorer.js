// agent/explorer.js
// -------------------------------------------------------------
// Modus 1: Exploratives Testen (Disponenten-Sicht) – KI-gesteuert
// - Planner (LLM): createPlanner({ mode:'explore' }) bestimmt die nächste Aktion
// - Executor: führt strikt per wkrad-id aus
// - Perception: erkennt UI-/Netzwerk-/Console-Fehler
// - BugReporter: erstellt Reports (Screenshot, DOM, Repro, KI-Zusammenfassung)
// - Memory: Zustandsgraph (recordOutcome)
//
// Neu gegenüber der vorherigen Version:
// - Perception-Start/Flush eingebaut
// - BugReporter-Aufrufe mit einheitlicher Payload
// - Robustere Fehlerpfade
// -------------------------------------------------------------

import { createPlanner } from './planner.js';
import { AuthService } from '../services/auth.js';
import { executeActions } from '../browser/action-executor.js';
import { BugReporter } from '../services/bug-reporter.js';
import {
    makeNodeKey,
    recordOutcome,
    rememberPage // optional
} from '../memory/memory.js';

import {
    startPerception,
    detectUiErrors,
    flushPerception
} from '../services/perception.js';

const HEADLESS = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
const MAX_STEPS = Number(process.env.MAX_STEPS || 80);
const ACTION_TIMEOUT_MS = Number(process.env.ACTION_TIMEOUT_MS || 10000);
const IDLE_AFTER_ACTION_MS = Number(process.env.IDLE_AFTER_ACTION_MS || 300);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 30);

export async function runExploration() {
    const { browser, page, sessionId } = await AuthService.login({ headless: HEADLESS });

    // Perception aktivieren (konsole/network/pageerror)
    startPerception(page);

    const planner = createPlanner({
        mode: 'explore',
        allowDestructive: false,
        candidateLimit: 30,
        maxDomItems: 60,
        modelName: process.env.LLM_MODEL
    });

    const history = [];
    const pushHistory = (entry) => {
        history.push({ ...entry, t: Date.now() });
        if (history.length > HISTORY_LIMIT) history.shift();
    };

    try {
        let nodeKey = await safeNodeKey(page);

        for (let step = 1; step <= MAX_STEPS; step++) {
            const action = await planner.planNextAction({ nodeKey, page, history });
            if (!action) {
                console.log('ℹ️  Keine weitere Aktion. Exploration endet.');
                break;
            }

            const startedAt = Date.now();
            try {
                await executeActions(page, [action], { timeoutPerAction: ACTION_TIMEOUT_MS });
                await waitMs(IDLE_AFTER_ACTION_MS);

                const nextNodeKey = await safeNodeKey(page);

                await recordOutcome({
                    fromKey: nodeKey,
                    toKey: nextNodeKey,
                    action,
                    ok: true,
                    durationMs: Date.now() - startedAt
                });

                pushHistory({ actionType: action.actionType, wkradId: action.wkradId, value: action.value, url: page.url() });

                // UI-Fehler prüfen → reporten → flushen
                const uiError = await detectUiErrors(page);
                if (uiError) {
                    await BugReporter.reportUiError({
                        page,
                        sessionId,
                        uiError,
                        recentSteps: [...history],
                        meta: { nodeKey, nextNodeKey }
                    });
                    flushPerception(page);
                }

                await safeRememberPage(page);
                nodeKey = nextNodeKey;

            } catch (err) {
                await recordOutcome({
                    fromKey: nodeKey,
                    toKey: nodeKey,
                    action,
                    ok: false,
                    error: String(err?.message || err),
                    durationMs: Date.now() - startedAt
                });

                await BugReporter.reportExecError({
                    page,
                    sessionId,
                    error: err,
                    recentSteps: [...history],
                    meta: { nodeKey, action }
                });
                flushPerception(page);

                if (shouldAbortAfterError(err)) {
                    console.log('⛔  Schwerer Fehler – Exploration beendet.');
                    break;
                }
            }
        }

    } finally {
        await browser.close();
    }
}

// -------------------------------------------------------------
// Helfer
// -------------------------------------------------------------

async function safeNodeKey(page) {
    try {
        return await makeNodeKey(page);
    } catch {
        return `url:${page.url()}`;
    }
}

async function safeRememberPage(page) {
    try {
        const html = await page.content();
        await rememberPage(html, []);
    } catch { }
}

function shouldAbortAfterError(err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('access denied')) return true;
    if (msg.includes('net::err_cert')) return true;
    return false;
}

function waitMs(ms) {
    return new Promise((res) => setTimeout(res, ms));
}
