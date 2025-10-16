// agent/annotator.js
// Fragt einmalig im Terminal nach dem Zweck eines Elements (wkrad-id)
// und persistiert die Antwort in memory/knowledge.json unter "intents".
// ESM + Node 20

import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEM_DIR = path.resolve(__dirname, '../memory');
const FILE_KNOWLEDGE_JSON = path.join(MEM_DIR, 'knowledge.json');

function nowIso() { return new Date().toISOString(); }

async function loadKnowledge() {
    try {
        const data = await fs.readJson(FILE_KNOWLEDGE_JSON);
        return {
            elements: data?.elements || {},
            flows: Array.isArray(data?.flows) ? data.flows : [],
            intents: data?.intents || {},
            meta: data?.meta || {}
        };
    } catch {
        return { elements: {}, flows: [], intents: {}, meta: {} };
    }
}

async function saveKnowledge(k) {
    await fs.ensureDir(MEM_DIR);
    k.meta = { ...(k.meta || {}), updatedAt: nowIso() };
    await fs.writeJson(FILE_KNOWLEDGE_JSON, k, { spaces: 2 });
}

function askOnce(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => { rl.close(); resolve(answer); });
    });
}

/**
 * Stellt nur dann eine Frage, wenn für diese wkrad-id noch kein Intent existiert.
 * @param {{ id: string, desc?: string }} action
 * @param {{ context?: string }} opts
 * @returns {Promise<{ text: string, createdAt: string } | null>}
 */
export async function ensureIntentForAction(action, opts = {}) {
    const id = action?.id;
    if (!id) return null;

    const knowledge = await loadKnowledge();
    const known = knowledge.intents?.[id];
    if (known?.text) return known; // bereits beantwortet → keine doppelte Ausgabe

    const label = action.desc || id;
    const ctx = opts.context ? ` (Kontext: ${opts.context})` : '';
    const q =
        `\n[KI-Frage] Wofür verwendest du „${label}“${ctx}?\n` +
        `Kurz aus Disponenten/Tester-Sicht (z. B. „zur Auftragsliste springen“).\n` +
        `Leer lassen zum Überspringen:\n> `;

    const answer = (await askOnce(q)).trim();

    knowledge.intents = knowledge.intents || {};
    knowledge.intents[id] = knowledge.intents[id] || {};

    if (!answer) {
        // markiere als gesehen, damit wir in der gleichen Session nicht nerven
        knowledge.intents[id].skippedAt = nowIso();
        await saveKnowledge(knowledge);
        return null;
    }

    knowledge.intents[id].text = answer;
    knowledge.intents[id].createdAt = knowledge.intents[id].createdAt || nowIso();
    knowledge.intents[id].updatedAt = nowIso();
    knowledge.intents[id].source = 'user';
    await saveKnowledge(knowledge);

    return { text: answer, createdAt: knowledge.intents[id].createdAt };
}

/**
 * Liest einen vorhandenen Intent (ohne Console-Frage).
 * @param {string} id
 * @returns {Promise<{ text?: string } | null>}
 */
export async function getIntentForId(id) {
    const knowledge = await loadKnowledge();
    return knowledge.intents?.[id] || null;
}
