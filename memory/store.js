// memory/store.js
// Speichert/liest aufgezeichnete Schritte und "Wissensbasis" des Agents.
// ESM-Version mit benannten Exporten.

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_DIR = path.resolve(__dirname, '.'); // memory/
const RECORDINGS_DIR = path.join(BASE_DIR, 'recordings');
const KNOWLEDGE_FILE = path.join(BASE_DIR, 'knowledge.json');

async function ensureDirs() {
    await fs.mkdir(RECORDINGS_DIR, { recursive: true });
    try {
        await fs.access(KNOWLEDGE_FILE);
    } catch {
        const initial = { elements: {}, flows: [] };
        await fs.writeFile(KNOWLEDGE_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    }
}

export async function saveRecording(name, steps, meta = {}) {
    await ensureDirs();
    const safe = String(name || 'session').replace(/[^\w.-]+/g, '_');
    const file = path.join(RECORDINGS_DIR, `${Date.now()}_${safe}.json`);
    await fs.writeFile(file, JSON.stringify({ meta, steps }, null, 2), 'utf-8');
    return file;
}

export async function loadAllRecordings() {
    await ensureDirs();
    const files = await fs.readdir(RECORDINGS_DIR).catch(() => []);
    const records = [];
    for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const p = path.join(RECORDINGS_DIR, f);
        try {
            const txt = await fs.readFile(p, 'utf-8');
            const j = JSON.parse(txt);
            records.push({ file: p, ...j });
        } catch {
            // ignore broken file
        }
    }
    return records;
}

export async function getKnowledge() {
    await ensureDirs();
    const txt = await fs.readFile(KNOWLEDGE_FILE, 'utf-8');
    return JSON.parse(txt);
}

export async function upsertElementKnowledge({ wkradId, xpath, text, role }) {
    await ensureDirs();
    const k = await getKnowledge();

    // Key-Strategie: bevorzugt wkradId, dann xpath, dann text
    const key = wkradId || xpath || (text ? text.slice(0, 80) : null);
    if (!key) return;

    const prev = k.elements[key] || {};
    k.elements[key] = {
        ...prev,
        wkradId: wkradId ?? prev.wkradId ?? null,
        xpath: xpath ?? prev.xpath ?? null,
        text: text ?? prev.text ?? null,
        role: role ?? prev.role ?? null,
        seenAt: Date.now()
    };

    await fs.writeFile(KNOWLEDGE_FILE, JSON.stringify(k, null, 2), 'utf-8');
}

export async function addFlow(name, steps) {
    await ensureDirs();
    const k = await getKnowledge();
    k.flows.push({ name, steps, addedAt: Date.now() });
    await fs.writeFile(KNOWLEDGE_FILE, JSON.stringify(k, null, 2), 'utf-8');
}

export async function allFlows() {
    const k = await getKnowledge();
    return Array.isArray(k.flows) ? k.flows : [];
}
