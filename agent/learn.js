// agent/learn.js
// Konsolidiert Wissen aus memory/*, um den Planner/Explorer zu „füttern“.
// - Liest:  memory/knowledge.json, memory/known-selectors.json, memory/recordings/*.json, *.ts, memory/memory.json
// - Schreibt: memory/knowledge.json (vereinheitlichte Struktur)
// - Konsole: Zusammenfassung (Elemente/Flows/Häufigkeiten)
//
// Node: ESM

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEM_DIR = path.resolve(__dirname, '../memory');
const FILE_KNOWLEDGE_JSON = path.join(MEM_DIR, 'knowledge.json');
const FILE_KNOWN_SELECTORS_JSON = path.join(MEM_DIR, 'known-selectors.json');
const FILE_MEMORY_JSON = path.join(MEM_DIR, 'memory.json');
const DIR_RECORDINGS = path.join(MEM_DIR, 'recordings');

function nowIso() { return new Date().toISOString(); }
function selectorForId(id) { return `[wkrad-id="${id}"], [data-wkrad-id="${id}"]`; }
function isNonEmptyString(s) { return typeof s === 'string' && s.trim().length > 0; }

const BAD_ID =
    /(logout|abmelden|delete|remove|destroy|drop|truncate|erase|unlink|void|submit|save|speichern|löschen|entfernen|abschicken|übernehmen|bestätigen|confirm|ok|password|passwort)/i;

async function readJsonSafe(p, fallback = null) {
    try { return await fs.readJson(p); } catch { return fallback; }
}
async function readTextSafe(p) {
    try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}
async function ensureDirSafe(d) {
    try { await fs.ensureDir(d); } catch { }
}

// ----------------- Bestehendes Wissen laden ----------------------------------

async function loadExistingKnowledge() {
    const knowledge = (await readJsonSafe(FILE_KNOWLEDGE_JSON, null)) || { elements: {}, flows: [], meta: {} };
    knowledge.elements = knowledge.elements || {};
    knowledge.flows = Array.isArray(knowledge.flows) ? knowledge.flows : [];
    knowledge.meta = knowledge.meta || {};
    return knowledge;
}

async function loadKnownSelectors() {
    // optional: { "<context>": { "<role>": "<wkrad-id>" } }
    const known = (await readJsonSafe(FILE_KNOWN_SELECTORS_JSON, null)) || {};
    const elements = {};
    for (const [ctx, roles] of Object.entries(known)) {
        for (const [role, id] of Object.entries(roles || {})) {
            if (!isNonEmptyString(id) || BAD_ID.test(id)) continue;
            elements[id] = elements[id] || { wkradId: id, sources: [] };
            elements[id].sources.push({ type: 'known-selector', ctx, role });
        }
    }
    return elements;
}

async function loadMemoryPagesAndGraph() {
    const mem = (await readJsonSafe(FILE_MEMORY_JSON, null)) || {};
    const pages = Array.isArray(mem.pages) ? mem.pages : [];
    const navGraph = mem.navGraph || { nodes: {}, edges: [] };
    return { pages, navGraph };
}

// ----------------- Recorder-Formate einlesen --------------------------------

// JSON-Recordings: {steps:[]} oder [] direkt
async function loadJsonRecordings(dir) {
    const out = [];
    const files = (await fs.pathExists(dir)) ? (await fs.readdir(dir)) : [];
    for (const f of files.filter(f => f.toLowerCase().endsWith('.json'))) {
        const rec = await readJsonSafe(path.join(dir, f), null);
        if (!rec) continue;
        const steps = Array.isArray(rec?.steps) ? rec.steps : (Array.isArray(rec) ? rec : []);
        out.push({ file: f, steps });
    }
    return out;
}

// TypeScript-Recordings (Playwright-artig) → steps[]
// Wir extrahieren wkrad-id basierte Interaktionen per robustem Regex:
function parseTsToSteps(tsCode, fileName) {
    if (!tsCode) return [];

    const steps = [];

    // 1) locator('[wkrad-id="ID"]') oder [data-wkrad-id="ID"]
    //    Aktion: .click() | .fill('…') | .press('…') | .selectOption('…' | { label: '…' })
    const locatorRe = /page\.locator\(\s*`?\s*\[(?:data-)?wkrad-id\s*=\s*["'`](.+?)["'`]\s*\]\s*`?\s*\)\s*\.(click|fill|press|selectOption)\s*\(([^)]*)\)/gims;

    // 2) direkte CSS in einfachen Quotes: locator('[wkrad-id="ID"]') …
    const locatorRe2 = /page\.locator\(\s*["']\s*\[(?:data-)?wkrad-id\s*=\s*["'](.+?)["']\s*\]\s*["']\s*\)\s*\.(click|fill|press|selectOption)\s*\(([^)]*)\)/gims;

    function pushStep(id, kind, argRaw) {
        if (!id || BAD_ID.test(id)) return;
        const selector = selectorForId(id);
        const type = ['click', 'fill', 'press', 'selectOption'].includes(kind) ? (kind === 'selectOption' ? 'select' : kind) : 'click';

        const step = { id, selector, type };
        if (/^fill$/i.test(type)) {
            const m = String(argRaw || '').match(/["'`](.+?)["'`]/);
            if (m) step.value = m[1];
        } else if (/^press$/i.test(type)) {
            const m = String(argRaw || '').match(/["'`](.+?)["'`]/);
            step.key = m ? m[1] : 'Enter';
        } else if (/^select$/i.test(type)) {
            // selectOption('value') | selectOption({ label: 'X' }) | selectOption({ value: 'v' })
            const val = String(argRaw || '');
            const mLabel = val.match(/label\s*:\s*["'`](.+?)["'`]/);
            const mValue = val.match(/value\s*:\s*["'`](.+?)["'`]/) || val.match(/^\s*["'`](.+?)["'`]\s*$/);
            step.value = (mLabel && mLabel[1]) || (mValue && mValue[1]) || '';
        }
        steps.push(step);
    }

    let m;
    while ((m = locatorRe.exec(tsCode)) !== null) {
        const [, id, kind, args] = m;
        pushStep(id, kind, args);
    }
    while ((m = locatorRe2.exec(tsCode)) !== null) {
        const [, id, kind, args] = m;
        pushStep(id, kind, args);
    }

    if (steps.length > 0) {
        // kleine Konsistenz: zusammenhängende Doppelpunkte etc. normalisieren
        for (const s of steps) {
            if (typeof s.value === 'string') s.value = s.value.replace(/\r?\n/g, ' ').trim();
        }
    }

    if (steps.length === 0) {
        // Hinweis für Nutzer: Datei ignoriert, nichts Extragierbares
        // (kein throw: still lernen, nur ohne diesen Input)
        // console.log(`[Learn] Hinweis: keine wkrad-id Aktionen in ${fileName} erkannt.`);
    }

    return steps;
}

async function loadTsRecordings(dir) {
    const out = [];
    const files = (await fs.pathExists(dir)) ? (await fs.readdir(dir)) : [];
    for (const f of files.filter(f => f.toLowerCase().endsWith('.ts'))) {
        const code = await readTextSafe(path.join(dir, f));
        if (!code) continue;
        const steps = parseTsToSteps(code, f);
        if (steps.length) out.push({ file: f, steps });
    }
    return out;
}

async function loadRecordings() {
    const json = await loadJsonRecordings(DIR_RECORDINGS);
    const ts = await loadTsRecordings(DIR_RECORDINGS);
    // beide Formate zusammenführen
    return [...json, ...ts];
}

// ----------------- Extraktion → Elemente/Flows -------------------------------

function extractElementsFromPages(pages) {
    // zählt Sichtbarkeiten aus recordPageState(meta.visibleIds)
    const freq = new Map();
    for (const p of pages) {
        const ids = p?.meta?.visibleIds;
        if (!Array.isArray(ids)) continue;
        for (const id of ids) {
            if (!isNonEmptyString(id) || BAD_ID.test(id)) continue;
            freq.set(id, (freq.get(id) || 0) + 1);
        }
    }
    // in Elements-Struktur umgießen
    const elements = {};
    for (const [id, c] of freq.entries()) {
        elements[id] = { wkradId: id, selector: selectorForId(id), freq: c, sources: [{ type: 'page-visibility', count: c }] };
    }
    return elements;
}

function extractSeedsFromRecordings(recordings) {
    // erzeugt Flow-Seeds und Einzelschritt-Seeds (nur sichere Aktionen)
    const flows = [];
    const elementSeeds = {}; // id -> meta

    for (const { file, steps } of recordings) {
        const seq = [];
        for (const s of steps) {
            const id = s?.wkradId || s?.id;
            const type = s?.type || 'click';
            if (!isNonEmptyString(id) || BAD_ID.test(id)) continue;

            if (!['click', 'fill', 'select', 'press'].includes(type)) continue;

            seq.push({ id, type, selector: selectorForId(id), ...(s.value ? { value: s.value } : {}), ...(s.key ? { key: s.key } : {}) });

            // Element-Seed registrieren
            elementSeeds[id] = elementSeeds[id] || { wkradId: id, selector: selectorForId(id), freq: 0, sources: [] };
            elementSeeds[id].freq += 1;
            elementSeeds[id].sources.push({ type: 'recording', file, stepType: type });
        }
        if (seq.length >= 2) {
            flows.push({
                name: `rec://${file}`,
                steps: seq,
                weight: Math.min(5, seq.length), // grober Proxy
                firstSeen: nowIso()
            });
        }
    }

    return { flows, elements: elementSeeds };
}

function extractUnderExploredFromNavGraph(navGraph) {
    // bevorzugt Kanten/Nodes mit wenig Gewicht/Besuchen
    const underEdges = [];
    const nodes = navGraph.nodes || {};
    const edges = Array.isArray(navGraph.edges) ? navGraph.edges : [];

    for (const e of edges) {
        const { from, to, action, weight } = e || {};
        if (!action?.id || BAD_ID.test(action.id)) continue;
        if (from === to) continue;
        const visitsTo = nodes?.[to]?.stats?.visits ?? 0;
        const score = (visitsTo <= 1 ? 3 : visitsTo <= 3 ? 2 : 1) * (weight <= 1 ? 2 : weight <= 3 ? 1.3 : 1);
        underEdges.push({ id: action.id, selector: action.selector || selectorForId(action.id), score, source: 'navGraph' });
    }

    underEdges.sort((a, b) => b.score - a.score);
    const top = underEdges.slice(0, 50);
    const elements = {};
    for (const e of top) {
        elements[e.id] = { wkradId: e.id, selector: e.selector, sources: [{ type: 'nav-graph', score: e.score }] };
    }
    return elements;
}

// ----------------- Mergen & Schreiben ---------------------------------------

function mergeElements(base, add) {
    const out = { ...(base || {}) };
    for (const [id, meta] of Object.entries(add || {})) {
        if (!out[id]) {
            out[id] = { wkradId: id, selector: meta.selector || selectorForId(id), freq: meta.freq || 0, sources: [...(meta.sources || [])] };
        } else {
            out[id].selector = out[id].selector || meta.selector || selectorForId(id);
            out[id].freq = (out[id].freq || 0) + (meta.freq || 0);
            out[id].sources = [...(out[id].sources || []), ...(meta.sources || [])];
        }
    }
    return out;
}

function mergeFlows(base, add) {
    const out = Array.isArray(base) ? [...base] : [];
    for (const f of add || []) {
        if (!out.some(x => x.name === f.name)) out.push(f);
    }
    return out;
}

async function saveKnowledge(knowledge) {
    await fs.outputJson(FILE_KNOWLEDGE_JSON, knowledge, { spaces: 2 });
}

// ----------------- Öffentliche API ------------------------------------------

export async function learnFromMemory() {
    await ensureDirSafe(MEM_DIR);

    const existing = await loadExistingKnowledge();
    const knownSelectors = await loadKnownSelectors();
    const recordings = await loadRecordings();
    const { pages, navGraph } = await loadMemoryPagesAndGraph();

    const fromPages = extractElementsFromPages(pages);
    const { flows: flowsFromRecs, elements: elemsFromRecs } = extractSeedsFromRecordings(recordings);
    const fromNav = extractUnderExploredFromNavGraph(navGraph);

    const mergedElements = mergeElements(
        mergeElements(mergeElements(existing.elements, knownSelectors), fromPages),
        mergeElements(elemsFromRecs, fromNav)
    );

    const mergedFlows = mergeFlows(existing.flows, flowsFromRecs);

    const out = {
        elements: mergedElements,
        flows: mergedFlows,
        meta: {
            updatedAt: nowIso(),
            counts: {
                existingElements: Object.keys(existing.elements || {}).length,
                existingFlows: (existing.flows || []).length,
                pages: pages.length,
                recordings: recordings.length,
                learnedElements: Object.keys(mergedElements).length,
                learnedFlows: mergedFlows.length
            }
        }
    };

    await saveKnowledge(out);

    // Konsole
    const topElems = Object.values(mergedElements)
        .map(e => ({ id: e.wkradId, freq: e.freq || 0 }))
        .sort((a, b) => (b.freq || 0) - (a.freq || 0))
        .slice(0, 10);

    console.log('[Learn] Wissen aktualisiert:');
    console.log(`        Elemente (gesamt): ${Object.keys(mergedElements).length}`);
    console.log(`        Flows (gesamt):    ${mergedFlows.length}`);
    console.log(`        Recordings:        ${recordings.length} (json+ts)`);
    if (topElems.length) {
        console.log('        Häufigste Elemente:');
        for (const t of topElems) console.log(`          - ${t.id} (freq=${t.freq})`);
    }

    return out;
}

export async function run() {
    try {
        const res = await learnFromMemory();
        console.log('[Learn] Fertig.', res?.meta);
    } catch (e) {
        console.log('[Learn] Fehler:', String(e?.message || e));
    }
}

// Kompatibel zu index.js:
export async function runLearnMode() {
    return await learnFromMemory();
}
