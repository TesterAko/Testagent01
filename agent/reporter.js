// agent/reporter.js
// Session-Logging für Läufe (ohne Bug-Report-Erstellung).

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_DIR = path.resolve(__dirname, '../test-output');
const SESS_DIR = path.join(OUT_DIR, 'sessions');

function nowIso() { return new Date().toISOString(); }
function safe(s) { return String(s || '').replace(/[^\w.\-]+/g, '_'); }

export async function startSession(label = 'explore') {
    await fs.ensureDir(SESS_DIR);
    const filePath = path.join(SESS_DIR, `${Date.now()}_${safe(label)}.json`);
    const doc = { startedAt: nowIso(), label, steps: [], errors: [], endedAt: null, meta: {} };
    await fs.writeJson(filePath, doc, { spaces: 2 });
    return { filePath };
}

export async function appendStep(filePath, step) {
    const doc = (await fs.readJson(filePath).catch(() => null)) || { steps: [], errors: [] };
    doc.steps = doc.steps || [];
    doc.steps.push({ t: nowIso(), ...step });
    await fs.writeJson(filePath, doc, { spaces: 2 });
}

export async function appendError(filePath, errEntry) {
    const doc = (await fs.readJson(filePath).catch(() => null)) || { steps: [], errors: [] };
    doc.errors = doc.errors || [];
    doc.errors.push({ t: nowIso(), ...errEntry });
    await fs.writeJson(filePath, doc, { spaces: 2 });
}

export async function endSession(filePath, summary = {}) {
    const doc = (await fs.readJson(filePath).catch(() => null)) || {};
    doc.endedAt = nowIso();
    doc.summary = summary;
    await fs.writeJson(filePath, doc, { spaces: 2 });
}
