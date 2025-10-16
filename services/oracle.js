// services/oracle.js
// Minimal-Oracle: Fragen stellen & Antworten persistieren (kein Prompt-Blocker, nur Logging + JSON).
// - askQuestion({topic, details, pageUrl}): legt Frage ab, loggt in Konsole und gibt questionId zurück
// - answerQuestion(questionId, answer): speichert Antwort unter derselben Id
//
// Datei: memory/questions.json

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEM_DIR = path.resolve(__dirname, '../memory');
const FILE_QA = path.join(MEM_DIR, 'questions.json');

function nowIso() { return new Date().toISOString(); }

async function loadQA() {
    try { return await fs.readJson(FILE_QA); } catch { return { questions: [] }; }
}
async function saveQA(data) {
    await fs.ensureDir(MEM_DIR);
    await fs.writeJson(FILE_QA, data, { spaces: 2 });
}

export async function askQuestion({ topic, details = '', pageUrl = '' }) {
    const qa = await loadQA();
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    qa.questions.push({
        id, askedAt: nowIso(), topic: String(topic || ''), details: String(details || ''), pageUrl,
        answer: null, answeredAt: null, status: 'open'
    });
    await saveQA(qa);
    console.log(`[KI-Frage] (${id}) ${topic}\n           ${details}\n           URL: ${pageUrl}`);
    return id;
}

export async function answerQuestion(id, answer) {
    const qa = await loadQA();
    const q = qa.questions.find(q => q.id === id);
    if (!q) return false;
    q.answer = String(answer || '');
    q.answeredAt = nowIso();
    q.status = 'answered';
    await saveQA(qa);
    console.log(`[KI-Antwort gespeichert] (${id}) -> ${q.answer}`);
    return true;
}
