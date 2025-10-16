// tools/merge-memory.js
// Konsolidiert & kompaktiert Memory und aktualisiert knowledge.json.
// - Backups von memory.json & knowledge.json
// - learnFromMemory() ausführen
// - Optionales Pruning & Decay
//
// Node: ESM

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

// Wir nutzen deine vorhandene Logik:
import { learnFromMemory } from '../agent/learn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const MEM_DIR = path.join(ROOT, 'memory');

const FILE_MEMORY = path.join(MEM_DIR, 'memory.json');
const FILE_KNOWLEDGE = path.join(MEM_DIR, 'knowledge.json');

const BACKUP_DIR = path.join(MEM_DIR, 'backups');

// ----------------------------- Optionen --------------------------------------
// per ENV steuerbar:
const KEEP_LAST_PAGES = Number(process.env.KEEP_LAST_PAGES || 2000);   // 0 = alle behalten
const PRUNE_EDGES = String(process.env.PRUNE_EDGES || 'true').toLowerCase() === 'true';
const EDGE_MIN_WEIGHT = Number(process.env.EDGE_MIN_WEIGHT || 0.2);    // Kanten darunter gelten als „schwach“
const EDGE_MAX_ERROR_RATIO = Number(process.env.EDGE_MAX_ERROR_RATIO || 0.8); // 80%+ Fehler => Kandidat
const EDGE_MAX_NOSTATE_RATIO = Number(process.env.EDGE_MAX_NOSTATE_RATIO || 0.95);
const DECAY = Number(process.env.WEIGHT_DECAY || 0.02);                // 0 = kein Decay; 0.02 = -2%
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true'; // nur anzeigen, nicht schreiben

// ----------------------------- Utils -----------------------------------------

function nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

async function readJsonSafe(p, fallback = null) {
    try { return await fs.readJson(p); } catch { return fallback; }
}

async function backupFile(src, destDir) {
    await fs.ensureDir(destDir);
    const base = path.basename(src);
    const dst = path.join(destDir, `${nowStamp()}_${base}`);
    if (await fs.pathExists(src)) {
        await fs.copy(src, dst);
        return dst;
    }
    return null;
}

function ratio(n, d) {
    n = Number(n || 0); d = Number(d || 0);
    return d > 0 ? (n / d) : 0;
}

// ----------------------------- Kompaktierung ---------------------------------

function compactPages(pages = [], keepLast = 0) {
    if (!Array.isArray(pages) || pages.length === 0) return { pages, removed: 0 };

    // Duplikate nach domHash entfernen – letztes Exemplar behalten
    const seen = new Set();
    const out = [];
    for (let i = pages.length - 1; i >= 0; i--) {
        const p = pages[i];
        const key = p?.domHash || JSON.stringify(p?.meta || {});
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
    }
    out.reverse();

    let trimmed = out;
    if (keepLast > 0 && out.length > keepLast) {
        trimmed = out.slice(out.length - keepLast);
    }
    const removed = pages.length - trimmed.length;
    return { pages: trimmed, removed };
}

function decayWeight(w, decay) {
    const x = Number(w || 0);
    return Math.max(0, x * (1 - Math.max(0, Math.min(decay, 0.99))));
}

function pruneEdges(edges = [], { minWeight, maxErr, maxNoState, decay }) {
    if (!Array.isArray(edges) || edges.length === 0) return { edges, removed: 0, decayed: 0 };
    const kept = [];
    let removed = 0;
    let decayed = 0;

    for (const e of edges) {
        const os = e?.outcomeStats || { progress: 0, nostate: 0, error: 0 };
        const tries = (os.progress || 0) + (os.nostate || 0) + (os.error || 0);
        const errR = ratio(os.error, tries);
        const noR = ratio(os.nostate, tries);

        // sanfter Decay (optional)
        if (decay > 0) {
            const before = e.weight || 0;
            e.weight = decayWeight(e.weight, decay);
            if (e.weight !== before) decayed++;
        }

        // Pruning-Kriterien: sehr schwach & sehr „schlecht“
        const tooWeak = (e.weight || 0) < minWeight;
        const tooError = errR >= maxErr;
        const tooNoState = noR >= maxNoState;

        if (PRUNE_EDGES && tooWeak && (tooError || tooNoState)) {
            removed++;
            continue;
        }
        kept.push(e);
    }

    return { edges: kept, removed, decayed };
}

// ----------------------------- Hauptlauf -------------------------------------

async function main() {
    console.log('[merge-memory] Starte …');

    // Backups
    const b1 = await backupFile(FILE_MEMORY, BACKUP_DIR);
    const b2 = await backupFile(FILE_KNOWLEDGE, BACKUP_DIR);
    if (b1) console.log(`[merge-memory] Backup memory.json -> ${b1}`);
    if (b2) console.log(`[merge-memory] Backup knowledge.json -> ${b2}`);

    // Memory lesen
    const memory = (await readJsonSafe(FILE_MEMORY, null)) || {
        pages: [], selectors: {}, navGraph: { nodes: {}, edges: [] }, routes: { stable: [] }, errors: []
    };

    // 1) Pages kompaktierten
    const { pages: compactedPages, removed: removedPages } = compactPages(memory.pages, KEEP_LAST_PAGES);
    memory.pages = compactedPages;

    // 2) Kanten prunen + weight decays
    const nav = memory.navGraph || { nodes: {}, edges: [] };
    const { edges: pruned, removed: removedEdges, decayed } = pruneEdges(nav.edges, {
        minWeight: EDGE_MIN_WEIGHT,
        maxErr: EDGE_MAX_ERROR_RATIO,
        maxNoState: EDGE_MAX_NOSTATE_RATIO,
        decay: DECAY
    });
    memory.navGraph = { ...nav, edges: pruned };

    // 3) Speichern (wenn kein DRY_RUN)
    if (!DRY_RUN) {
        await fs.outputJson(FILE_MEMORY, memory, { spaces: 2 });
    }

    console.log(`[merge-memory] Pages: -${removedPages} gelöscht, verbleibend=${memory.pages.length}`);
    console.log(`[merge-memory] Edges: -${removedEdges} gepruned, ${decayed} decayed, verbleibend=${memory.navGraph.edges.length}`);

    // 4) Lernen/Knowledge aktualisieren
    const knowledge = await learnFromMemory();
    if (!DRY_RUN) {
        await fs.outputJson(FILE_KNOWLEDGE, knowledge, { spaces: 2 });
    }
    console.log('[merge-memory] Knowledge aktualisiert:', {
        elements: Object.keys(knowledge.elements || {}).length,
        flows: (knowledge.flows || []).length,
        counts: knowledge.meta?.counts
    });

    console.log('[merge-memory] Fertig.');
}

main().catch(err => {
    console.error('[merge-memory] Fehler:', err?.stack || err);
    process.exit(1);
});
