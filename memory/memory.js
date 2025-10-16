// memory/memory.js
// Zentraler Pattern-Memory (wkrad-id only) mit Abwärtskompatibilität.
//
// Beibehaltendes API:
//   - hasSeenDOM(html)
//   - rememberPage(html, gptSuggestions)
//
// Neues API (für Explorer/Auth/Reporter/Planner):
//   - rememberSelector(context, role, wkradId)
//   - getSelectors(context)
//   - mergeSelectors(context, entries)
//   - selectorToCss(wkradId)
//   - upsertNode(nodeKey, label)
//   - addEdge(fromKey, toKey, action)
//   - nextTargets(nodeKey, limit)
//   - recordPageState({ url, title, visibleIds, extra })
//   - makeNodeKey(page)
//   - recordError({ type, message, stack, screenshotPath, pageUrl, context })
//   - rememberRoute(label, url)
//   - listRoutes()
//   - recordOutcome({ fromKey, toKey, action, outcome })

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Alles in EINER Datei im gleichen Ordner persistieren
const memoryFilePath = path.join(__dirname, 'memory.json');

// weiche Limits, per ENV überschreibbar
const MAX_PAGES = Number(process.env.MEM_MAX_PAGES || 1000);
const MAX_VISIBLE_IDS = Number(process.env.MEM_MAX_VISIBLE_IDS || 120);

const DEFAULT_STATE = {
    // pages-Elemente können „alt“ (nur domHash/timestamp) oder „neu“ sein:
    // alt: { domHash, timestamp, gptSuggestions }
    // neu: { domHash, firstSeen, lastSeen, hits, gptSuggestions, meta:{ url,title,visibleIds,... } }
    pages: [],
    selectors: {},                           // { contextKey: { role: wkradId } }
    navGraph: { nodes: {}, edges: [] },      // nodes: {key:{label,firstSeen,lastSeen,stats}}, edges: [{id,from,to,action,weight,firstSeen,lastSeen,outcomeStats?}]
    routes: { stable: [] },                  // [{ label, url, hash, firstSeen, lastSeen, hits }]
    errors: []                               // [{ t,type,message,stack,screenshotPath,url,context }]
};

async function loadMemory() {
    if (!(await fs.pathExists(memoryFilePath))) {
        await fs.outputJson(memoryFilePath, DEFAULT_STATE, { spaces: 2 });
    }
    const data = await fs.readJson(memoryFilePath);
    // defensiv initialisieren (falls alte Struktur)
    return {
        ...DEFAULT_STATE,
        ...data,
        navGraph: { ...DEFAULT_STATE.navGraph, ...(data.navGraph || {}) },
        routes: { ...DEFAULT_STATE.routes, ...(data.routes || {}) }
    };
}

async function saveMemory(data) {
    await fs.outputJson(memoryFilePath, data, { spaces: 2 });
}

function hash(content, algo = 'sha256', len = 64) {
    return crypto.createHash(algo).update(String(content ?? '')).digest('hex').slice(0, len);
}

function nowIso() { return new Date().toISOString(); }
function toSel(id) { return `[wkrad-id="${id}"], [data-wkrad-id="${id}"]`; }

// ------------------------- Bestehendes API -----------------------------------

export async function hasSeenDOM(html) {
    const memory = await loadMemory();
    const hashVal = hash(html, 'sha256', 64);
    return memory.pages.some(p => p.domHash === hashVal);
}

export async function rememberPage(html, gptSuggestions = []) {
    const memory = await loadMemory();
    const hashVal = hash(html, 'sha256', 64);

    // alt: vorhandenen Eintrag suchen
    const existing = memory.pages.find(p => p.domHash === hashVal);
    if (!existing) {
        memory.pages.push({
            domHash: hashVal,
            firstSeen: nowIso(),
            lastSeen: nowIso(),
            hits: 1,
            gptSuggestions
        });
    } else {
        existing.lastSeen = nowIso();
        existing.hits = (existing.hits ?? 0) + 1;
        // gptSuggestions optional zusammenführen (einfach anhängen, hart begrenzen)
        const prev = Array.isArray(existing.gptSuggestions) ? existing.gptSuggestions : [];
        existing.gptSuggestions = [...prev, ...gptSuggestions].slice(-50);
    }

    // prunen, falls zu groß
    prunePages(memory);
    await saveMemory(memory);
    return !existing;
}

// ------------------------- Selektor-Gedächtnis -------------------------------

export async function rememberSelector(context, role, wkradId) {
    if (!context || !role || !wkradId) return;
    const memory = await loadMemory();
    memory.selectors[context] ??= {};
    memory.selectors[context][role] = wkradId;
    await saveMemory(memory);
}

export async function getSelectors(context) {
    const memory = await loadMemory();
    return { ...(memory.selectors[context] || {}) };
}

export async function mergeSelectors(context, entries) {
    if (!context || !entries) return;
    const memory = await loadMemory();
    memory.selectors[context] = { ...(memory.selectors[context] || {}), ...entries };
    await saveMemory(memory);
}

export function selectorToCss(wkradId) { return toSel(wkradId); }

// ------------------------- Navigation Graph ----------------------------------

export async function upsertNode(nodeKey, label) {
    if (!nodeKey) return;
    const memory = await loadMemory();
    const nodes = memory.navGraph.nodes;
    const node = nodes[nodeKey] ?? {
        label: label || nodeKey,
        firstSeen: nowIso(),
        lastSeen: nowIso(),
        stats: { visits: 0 }
    };
    node.lastSeen = nowIso();
    node.stats.visits = (node.stats.visits ?? 0) + 1;
    nodes[nodeKey] = node;
    await saveMemory(memory);
}

function edgeId(fromKey, toKey, action) {
    return `${fromKey}::${action?.id || action?.selector || action?.desc || 'act'}::${toKey}`;
}

function ensureOutcomeStats(edge) {
    edge.outcomeStats = edge.outcomeStats || { progress: 0, nostate: 0, error: 0 };
    return edge.outcomeStats;
}

export async function addEdge(fromKey, toKey, action) {
    if (!fromKey || !toKey) return;
    const memory = await loadMemory();
    const id = edgeId(fromKey, toKey, action);
    let edge = memory.navGraph.edges.find(e => e.id === id);
    if (!edge) {
        edge = {
            id, from: fromKey, to: toKey,
            action: action || null,
            weight: 0,
            firstSeen: nowIso(),
            lastSeen: nowIso(),
            outcomeStats: { progress: 0, nostate: 0, error: 0 }
        };
        memory.navGraph.edges.push(edge);
    }
    edge.weight += 1;
    edge.lastSeen = nowIso();
    ensureOutcomeStats(edge); // falls aus Altbestand ohne outcomeStats
    await saveMemory(memory);
}

export async function nextTargets(nodeKey, limit = 6) {
    const memory = await loadMemory();
    // Self-Loops vermeiden: echte Navigation bevorzugen
    const out = memory.navGraph.edges
        .filter(e => e.from === nodeKey && e.from !== e.to);

    // Priorisierung: wenig besucht + gute Outcome-Quote
    const score = (e) => {
        const os = e.outcomeStats || { progress: 0, nostate: 0, error: 0 };
        const tries = (os.progress || 0) + (os.nostate || 0) + (os.error || 0);
        const progR = tries > 0 ? (os.progress / tries) : 0;
        // „untererforscht“ bevorzugen (kleines weight), aber Fortschritt belohnen
        return (1 / Math.max(1, e.weight)) + (progR * 1.5);
    };

    const sorted = out.sort((a, b) => score(b) - score(a));
    return sorted.slice(0, limit).map(e => e.action);
}

/**
 * Outcome an Kante persistieren.
 * outcome: 'progress' | 'nostate' | 'error'
 */
export async function recordOutcome({ fromKey, toKey, action, outcome }) {
    if (!fromKey || !toKey || !action || !outcome) return;
    const memory = await loadMemory();
    const id = edgeId(fromKey, toKey, action);
    let edge = memory.navGraph.edges.find(e => e.id === id);
    if (!edge) {
        // Falls addEdge nicht vorher aufgerufen wurde, legen wir die Kante an.
        edge = {
            id, from: fromKey, to: toKey,
            action: action || null,
            weight: 0,
            firstSeen: nowIso(),
            lastSeen: nowIso(),
            outcomeStats: { progress: 0, nostate: 0, error: 0 }
        };
        memory.navGraph.edges.push(edge);
    }
    const os = ensureOutcomeStats(edge);
    if (outcome === 'progress') os.progress += 1;
    else if (outcome === 'nostate') os.nostate += 1;
    else if (outcome === 'error') os.error += 1;

    edge.lastSeen = nowIso();
    await saveMemory(memory);
    return edge;
}

// ------------------------- Page-State / Fingerprint --------------------------

/**
 * Dedupliziert Page-States:
 * - Signatur = sha1(url|title|visibleIds[...])
 * - existiert bereits: hits++, lastSeen aktualisieren, visibleIds mergen (Set, Limit)
 * - neu: Eintrag anlegen (firstSeen/lastSeen/hits=1)
 * - optional: FIFO-Pruning, wenn MAX_PAGES überschritten
 */
export async function recordPageState({ url, title, visibleIds, extra = {} }) {
    const memory = await loadMemory();
    const signature = hash([url, title, ...(visibleIds || [])].join('|'), 'sha1', 12);

    let entry = memory.pages.find(p => p.domHash === signature);

    if (!entry) {
        entry = {
            domHash: signature,
            firstSeen: nowIso(),
            lastSeen: nowIso(),
            hits: 1,
            gptSuggestions: [],
            meta: {
                url,
                title,
                visibleIds: Array.from(new Set(visibleIds || [])).slice(0, MAX_VISIBLE_IDS),
                ...extra
            }
        };
        memory.pages.push(entry);
    } else {
        // vorhandenen Eintrag aktualisieren
        entry.lastSeen = nowIso();
        entry.hits = (entry.hits ?? 0) + 1;

        // URL/Titel aktualisieren (falls geändert)
        entry.meta = entry.meta || {};
        entry.meta.url = url;
        entry.meta.title = title;

        // visibleIds mergen (ohne Duplikate, Limit)
        const prevIds = Array.isArray(entry.meta.visibleIds) ? entry.meta.visibleIds : [];
        const merged = Array.from(new Set([...(prevIds || []), ...(visibleIds || [])]));
        entry.meta.visibleIds = merged.slice(0, MAX_VISIBLE_IDS);

        // extra-Felder behutsam mergen (neue Keys überschreiben ggf.)
        entry.meta = { ...entry.meta, ...extra };
    }

    prunePages(memory);
    await saveMemory(memory);
    return signature;
}

function prunePages(memory) {
    if (!Array.isArray(memory.pages)) memory.pages = [];
    if (memory.pages.length <= MAX_PAGES) return;

    // nach lastSeen aufsteigend sortieren und den Überschuss entfernen
    memory.pages.sort((a, b) => String(a.lastSeen || a.timestamp || '') < String(b.lastSeen || b.timestamp || '') ? -1 : 1);
    const toDrop = memory.pages.length - MAX_PAGES;
    if (toDrop > 0) memory.pages.splice(0, toDrop);
}

// Stabiler Node-Key direkt aus Playwright-Page
export async function makeNodeKey(page) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[wkrad-id], [data-wkrad-id]'))
            .slice(0, 30)
            .map(el => el.getAttribute('wkrad-id') || el.getAttribute('data-wkrad-id'))
            .filter(Boolean)
    );
    return hash(`${url}|${title}|${ids.slice(0, 8).join(',')}`, 'sha1', 12);
}

// ------------------------- Fehler-Wissen -------------------------------------

export async function recordError({ type, message, stack, screenshotPath, pageUrl, context }) {
    const memory = await loadMemory();
    const entry = {
        t: nowIso(),
        type, message, stack,
        screenshotPath: screenshotPath || null,
        url: pageUrl || null,
        context: context || null
    };
    memory.errors.push(entry);
    await saveMemory(memory);
    return entry;
}

// ------------------------- Routen / Deep Links -------------------------------

export async function rememberRoute(label, url) {
    if (!label || !url) return null;
    const memory = await loadMemory();
    const hashVal = hash(url, 'sha1', 12);
    const existing = memory.routes.stable.find(r => r.hash === hashVal);
    if (existing) {
        existing.lastSeen = nowIso();
        existing.hits = (existing.hits ?? 0) + 1;
    } else {
        memory.routes.stable.push({ label, url, hash: hashVal, firstSeen: nowIso(), lastSeen: nowIso(), hits: 1 });
    }
    await saveMemory(memory);
    return hashVal;
}

export async function listRoutes() {
    const memory = await loadMemory();
    return [...memory.routes.stable];
}
