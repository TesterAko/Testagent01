// agent/planner.js
// ---------------------------------------------------------
// Ziel: Die KI (LLM) plant die nächste Aktion vollautonom.
// - Eingaben: aktueller Seitenzustand (nodeKey, DOM-Snapshot light),
//             bekannte Kandidaten aus Knowledge + sichtbare DOM-Elemente
// - Ausgabe: { wkradId, actionType, value?, meta? } für executeActions()
// - Safety: ausschließlich wkrad-id-Selektoren; destruktive Aktionen blocken,
//           robuste Validierung; Fallback auf Heuristik bei LLM-Fehlern.
//
// Abhängigkeiten (lokal im Projekt):
// - memory/memory.js: nextTargets, getIntentForId, isDestructiveId
// - services/llm.js:  chat({ system, messages, response_format? })  -> { text }
//   (kleiner Wrapper um OpenAI/sonstige Modelle; kein Prompt an der CLI)
// ---------------------------------------------------------

import { nextTargets, getIntentForId, isDestructiveId } from '../memory/memory.js';
import { chat } from '../services/llm.js'; // <- Du hast bereits OpenAI-Calls im Projekt
import * as fs from 'fs-extra';

/**
 * Factory zum Erstellen eines KI-Planers.
 * @param {Object} opts
 * @param {boolean} [opts.allowDestructive=false]  Erlaube destruktive Aktionen?
 * @param {number}  [opts.maxDomItems=40]         Wie viele DOM-Elemente werden der KI gegeben?
 * @param {number}  [opts.candidateLimit=20]      Wie viele Kandidaten rankt die KI maximal?
 * @param {string}  [opts.modelName]              Optional: Modellname im llm.js
 */
export function createPlanner({
    allowDestructive = false,
    maxDomItems = 40,
    candidateLimit = 20,
    modelName
} = {}) {
    return new PlannerImpl({ allowDestructive, maxDomItems, candidateLimit, modelName });
}

class PlannerImpl {
    constructor({ allowDestructive, maxDomItems, candidateLimit, modelName }) {
        this.allowDestructive = allowDestructive;
        this.maxDomItems = maxDomItems;
        this.candidateLimit = candidateLimit;
        this.modelName = modelName;
    }

    /**
     * Plant die nächste Aktion via LLM (mit robustem Fallback).
     * @param {Object} ctx
     * @param {string} ctx.nodeKey
     * @param {import('playwright').Page} ctx.page
     * @param {Array<{wkradId:string,actionType?:string,value?:string}>} [ctx.history] – letzte Schritte
     */
    async planNextAction({ nodeKey, page, history = [] }) {
        // 1) Kandidaten aus Wissen
        let known = [];
        try {
            known = await nextTargets(nodeKey, this.candidateLimit);
        } catch {
            known = [];
        }

        // 2) Sichtbare DOM-Kandidaten (wkrad-id only)
        const domSnapshot = await collectDomSnapshot(page, this.maxDomItems);
        const domCandidates = domSnapshot.map(d => ({ wkradId: d.wkradId, source: 'dom' }));

        // 3) Konsolidieren (unique by wkradId)
        const map = new Map();
        for (const c of [...known, ...domCandidates]) {
            if (!c?.wkradId) continue;
            if (!map.has(c.wkradId)) map.set(c.wkradId, c);
        }
        const candidates = Array.from(map.values()).slice(0, this.candidateLimit);

        if (candidates.length === 0) return null;

        // 4) Intents (falls vorhanden) anreichern (nicht interaktiv!)
        for (const c of candidates) {
            c.intent = await safeGetIntent(c.wkradId);
            c.isDestructive = !!isDestructiveId(c.wkradId);
            c.isLikelyNav = guessNavById(c.wkradId, c.intent);
        }

        // 5) KI-Ranking & Aktionsvorschlag
        let proposed = null;
        try {
            proposed = await rankAndProposeWithLLM({
                modelName: this.modelName,
                url: page.url(),
                nodeKey,
                history,
                domSnapshot,
                candidates
            });
        } catch (e) {
            // Falls das LLM hart ausfällt, einfach auf Heuristik zurückfallen
            // (keine Interaktion, deterministisch)
            return heuristicFallback(candidates, { allowDestructive: this.allowDestructive });
        }

        // 6) Validierung & Safety
        const validated = validateProposal(proposed, candidates, {
            allowDestructive: this.allowDestructive
        });

        if (!validated) {
            // LLM hat Unsinn geliefert -> Fallback Heuristik
            return heuristicFallback(candidates, { allowDestructive: this.allowDestructive });
        }

        return validated;
    }
}

// ---------------------------------------------------------
// LLM-Integration
// ---------------------------------------------------------

/**
 * Ruft das LLM auf, um Kandidaten zu ranken und genau eine Aktion vorzuschlagen.
 * Das LLM bekommt nur: URL, nodeKey, kompakte DOM-Liste, Kandidatenliste, History.
 * Es MUSS als JSON antworten: { wkradId, actionType, value?, reason }
 */
async function rankAndProposeWithLLM({ modelName, url, nodeKey, history, domSnapshot, candidates }) {
    // kompakte Inputs bauen (schlank halten!)
    const compactDom = domSnapshot.map(d => ({
        id: d.wkradId,
        tag: d.tag,
        role: d.role,
        text: d.text,
        enabled: d.enabled,
        visible: d.visible
    }));

    const compactCands = candidates.map(c => ({
        id: c.wkradId,
        source: c.source || 'knowledge',
        intent: c.intent?.type || null,
        valueHint: c.intent?.valueHint || null,
        isDestructive: !!c.isDestructive,
        isLikelyNav: !!c.isLikelyNav
    }));

    const compactHistory = (history || []).slice(-10).map(h => ({
        id: h.wkradId,
        type: h.actionType,
        value: h.value || null
    }));

    const system = [
        'Du bist ein Testagent-Planer. Du planst die NÄCHSTE Benutzereingabe für exploratives Testen.',
        'Harte Regeln:',
        '- Verwende ausschließlich Elemente mit wkrad-id.',
        '- Gib GENAU EINEN Schritt zurück.',
        '- Antworte als striktes JSON-Objekt, ohne Fließtext.',
        '- Erfinde keine wkrad-id. Nutze nur aus Kandidatenliste.',
        '- Vermeide destruktive/gefährliche Aktionen (Löschen, Logout, Abbrechen von Prozessen).',
        '- Nutze valueHint für Eingaben/Select, wenn vorhanden.',
        'Erlaubte actionType: "click" | "fill" | "select" | "press".'
    ].join('\n');

    const user = {
        url,
        nodeKey,
        history: compactHistory,
        candidates: compactCands,
        dom: compactDom,
        task: 'Wähle die sinnvollste nächste Aktion, um in der App weiter zu navigieren oder Felder sinnvoll zu befüllen.'
    };

    const assistantFormatHint = [
        '{',
        '  "wkradId": "<KANDIDAT_ID>",',
        '  "actionType": "click|fill|select|press",',
        '  "value": "<optional>",',
        '  "reason": "<kurz, warum>"',
        '}'
    ].join('\n');

    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user, null, 2) },
        { role: 'user', content: `Antworte NUR mit JSON exakt in diesem Schema:\n${assistantFormatHint}` }
    ];

    const res = await chat({
        system,
        messages,
        // Wenn dein llm.js response_format unterstützt: JSON erzwingen
        response_format: { type: 'json_object' },
        model: modelName
    });

    const text = (res && res.text) ? String(res.text).trim() : '';
    if (!text) throw new Error('LLM: leere Antwort');

    let obj = null;
    try {
        obj = JSON.parse(text);
    } catch {
        // Model hat evtl. Text drumrum – heuristischer JSON-Extrakt
        const m = text.match(/\{[\s\S]*\}$/);
        obj = m ? JSON.parse(m[0]) : null;
    }
    if (!obj || typeof obj !== 'object') throw new Error('LLM: ungültiges JSON');

    return {
        wkradId: String(obj.wkradId || ''),
        actionType: String(obj.actionType || '').toLowerCase(),
        value: typeof obj.value === 'undefined' ? undefined : String(obj.value),
        reason: typeof obj.reason === 'string' ? obj.reason : ''
    };
}

// ---------------------------------------------------------
// Safety & Fallback
// ---------------------------------------------------------

/**
 * Validiert den LLM-Vorschlag hart gegen Kandidatenliste und Policies.
 */
function validateProposal(proposed, candidates, { allowDestructive }) {
    const allowedTypes = new Set(['click', 'fill', 'select', 'press']);

    if (!proposed?.wkradId || !allowedTypes.has(proposed.actionType)) return null;

    const cand = candidates.find(c => c.wkradId === proposed.wkradId);
    if (!cand) return null;

    // Destruktiv blocken, wenn nicht erlaubt
    if (cand.isDestructive && !allowDestructive) return null;

    // Aktion zusammenbauen (LLM darf value vorschlagen; wir lassen value optional)
    return {
        wkradId: cand.wkradId,
        actionType: proposed.actionType,
        ...(typeof proposed.value !== 'undefined' ? { value: proposed.value } : {}),
        meta: {
            source: 'llm',
            reason: proposed.reason || ''
        }
    };
}

/**
 * Heuristischer Fallback, falls LLM ausfällt.
 */
function heuristicFallback(candidates, { allowDestructive }) {
    const ranked = candidates
        .map(c => ({
            c,
            score: scoreCandidate(c, { allowDestructive })
        }))
        .sort((a, b) => b.score - a.score);

    const best = ranked.find(r => !r.c.candidate && r) || ranked[0];
    const top = best?.c || ranked?.[0]?.c;
    if (!top) return null;

    return deriveActionForCandidate(top);
}

// ---------------------------------------------------------
// Heuristiken (identisch/ähnlich zu vorher, als Backstop)
// ---------------------------------------------------------

async function safeGetIntent(id) {
    try {
        return (await getIntentForId(id)) || null;
    } catch {
        return null;
    }
}

function guessNavById(id, intent) {
    if (intent?.isNav) return true;
    return /(menu|nav|home|zurueck|weiter|next|previous|tab|sidebar|menü|start|haupt|dashboard)/i.test(id);
}

function scoreCandidate(c, { allowDestructive }) {
    let s = 0;
    if (c.intent) s += 2;
    if (typeof c.freq === 'number' && Number.isFinite(c.freq)) s += Math.min(3, Math.max(0, c.freq));
    if (c.isLikelyNav) s += 1;
    if (c.source === 'dom') s -= 1;
    if (c.isDestructive && !allowDestructive) s -= 5;
    return s;
}

function deriveActionForCandidate(c) {
    const t = (c.intent?.type || '').toLowerCase();
    if (t === 'fill' || t === 'input' || t === 'type') {
        return { wkradId: c.wkradId, actionType: 'fill', value: c.intent?.valueHint ?? '', meta: { source: 'heuristic' } };
    }
    if (t === 'select') {
        return { wkradId: c.wkradId, actionType: 'select', value: c.intent?.valueHint ?? '', meta: { source: 'heuristic' } };
    }
    if (t === 'press') {
        return { wkradId: c.wkradId, actionType: 'press', value: c.intent?.valueHint ?? 'Enter', meta: { source: 'heuristic' } };
    }
    return { wkradId: c.wkradId, actionType: 'click', meta: { source: 'heuristic' } };
}

// ---------------------------------------------------------
// DOM-Helfer: leichtgewichtiger Snapshot für das LLM
// ---------------------------------------------------------
async function collectDomSnapshot(page, limit = 40) {
    try {
        const list = await page.$$eval('[wkrad-id], [data-wkrad-id]', (els, lim) => {
            function textish(el) {
                const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
                return t.slice(0, 80);
            }
            const out = [];
            for (const el of els) {
                const id = el.getAttribute('wkrad-id') || el.getAttribute('data-wkrad-id');
                if (!id) continue;
                const r = el.getBoundingClientRect();
                const visible = r.width > 0 && r.height > 0;
                const cs = window.getComputedStyle(el);
                if (!visible || cs.visibility === 'hidden' || cs.display === 'none') continue;

                out.push({
                    wkradId: id,
                    tag: el.tagName.toLowerCase(),
                    role: el.getAttribute('role') || null,
                    text: textish(el),
                    enabled: !el.hasAttribute('disabled'),
                    visible: true
                });
                if (out.length >= lim) break;
            }
            return out;
        }, limit);

        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

export default { createPlanner };
