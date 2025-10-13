// memory/memory.js
// Zentraler Pattern-Memory (wkrad-id only) mit Abwärtskompatibilität.
//
// Beibehaltendes API:
//   - hasSeenDOM(html)
//   - rememberPage(html, gptSuggestions)
//
// Neues API (für Explorer/Auth/Reporter):
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

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Alles in EINER Datei im gleichen Ordner persistieren
const memoryFilePath = path.join(__dirname, 'memory.json');

const DEFAULT_STATE = {
    pages: [],                               // [{ domHash, timestamp, gptSuggestions, meta? }]
    selectors: {},                           // { contextKey: { role: wkradId } }
    navGraph: { nodes: {}, edges: [] },      // nodes: {key:{label,firstSeen,lastSeen,stats}}, edges: [{id,from,to,action,weight,firstSeen,lastSeen}]
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

    if (!memory.pages.some(p => p.domHash === hashVal)) {
        memory.pages.push({
            domHash: hashVal,
            timestamp: nowIso(),
            gptSuggestions,
        });
        await saveMemory(memory);
        return true;
    }
    return false;
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

export async function addEdge(fromKey, toKey, action) {
    if (!fromKey || !toKey) return;
    const memory = await loadMemory();
    const id = `${fromKey}::${action?.id || action?.selector || action?.desc || 'act'}::${toKey}`;
    let edge = memory.navGraph.edges.find(e => e.id === id);
    if (!edge) {
        edge = { id, from: fromKey, to: toKey, action: action || null, weight: 0, firstSeen: nowIso(), lastSeen: nowIso() };
        memory.navGraph.edges.push(edge);
    }
    edge.weight += 1;
    edge.lastSeen = nowIso();
    await saveMemory(memory);
}

export async function nextTargets(nodeKey, limit = 6) {
    const memory = await loadMemory();
    const out = memory.navGraph.edges.filter(e => e.from === nodeKey);
    const sorted = out.sort((a, b) => (a.weight - b.weight)); // wenig besuchte zuerst
    return sorted.slice(0, limit).map(e => e.action);
}

// ------------------------- Page-State / Fingerprint --------------------------

export async function recordPageState({ url, title, visibleIds, extra = {} }) {
    const memory = await loadMemory();
    const signature = hash([url, title, ...(visibleIds || [])].join('|'), 'sha1', 12);
    memory.pages.push({
        domHash: signature, // kompatibel zur alten Struktur, hier als kompakter Sig
        timestamp: nowIso(),
        gptSuggestions: [],
        meta: { url, title, visibleIds, ...extra }
    });
    await saveMemory(memory);
    return signature;
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
