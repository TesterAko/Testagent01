// index.js (ESM)
// index.js – ergänze am Anfang nach dotenv.config() und ENV-Read:
import dotenv from 'dotenv';
import readlineSync from 'readline-sync';
import OpenAI from 'openai';
import { chromium } from 'playwright';

import { runExploration } from './agent/explorer.js';
import { runUserStory } from './agent/story.js';
import { runLearnMode } from './agent/learn.js';

// Optional (falls du meinen Planner/Prompt nutzt)
import { SYSTEM_PROMPT, buildUserPrompt } from './agent/planner.js';

dotenv.config();

const {
    OPENAI_API_KEY,
    OPENAI_MODEL = 'gpt-5',
    BASE_URL = '',
    HEADLESS = 'true'
} = process.env;

// --- LLM Wrapper: zentrale Stelle für alle Modellaufrufe ---
function makeLLM(openai) {
    async function chat({ system, user, temperature = 0.2, model = OPENAI_MODEL }) {
        const res = await openai.chat.completions.create({
            model,
            temperature,
            messages: [
                ...(system ? [{ role: 'system', content: system }] : []),
                { role: 'user', content: user }
            ]
        });
        return res?.choices?.[0]?.message?.content || '';
    }

    return {
        // Explorations-Plan (nutzt strikt das Planner-Prompt)
        async getExplorationPlan(contextSummary = '') {
            const user = buildUserPrompt(contextSummary);
            return chat({ system: SYSTEM_PROMPT, user });
        },

        // User-Story-Plan (einfaches Default-Prompt – passe bei Bedarf an)
        async getUserStoryPlan(storyText = '') {
            const system = 'You are a senior QA planner. Output only actionable UI steps, one per line, each starting with "- " and including wkrad-id="...".';
            const user = `Create a minimal, deterministic step plan for this user story:\n\n${storyText}\n\nFollow the same output rules as exploration.`;
            return chat({ system, user });
        },

        // Lernmodus-Plan (z. B. Erklärungen + Micro-Tasks)
        async getLearningPlan(topic = '') {
            const system = 'You are a concise QA tutor. Output 5-7 short steps (each line starts with "- "), each including a concrete action or check with wkrad-id if UI related.';
            const user = `Create a short learning plan for: ${topic}\nFocus on practical, verifiable steps.`;
            return chat({ system, user });
        }
    };
}

async function main() {
    console.log('🚀 Starte KI-Testagent...');

    let llmInstance = null;
    const ensureLLM = () => {
        if (llmInstance) return llmInstance;
        if (!OPENAI_API_KEY) {
            console.error('❌ OPENAI_API_KEY fehlt in .env');
            return null;
        }
        const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        llmInstance = makeLLM(openai);
        return llmInstance;
    };

    // Browser nur einmal starten, Seite teilen
    const browser = await chromium.launch({ headless: HEADLESS !== 'false' });
    const context = await browser.newContext();
    const page = await context.newPage();

    if (BASE_URL) {
        console.log(`🌐 Öffne BASE_URL: ${BASE_URL}`);
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    }

    console.log('🧠 Welchen Modus willst du starten?');
    console.log('1. Exploratives Testen');
    console.log('2. User Story Testen');
    console.log('99. Learn-Modus');
    const modeRaw = readlineSync.question('> ').trim();
    const modeInput = modeRaw === '' ? NaN : Number(modeRaw);

    try {
        if (modeInput === 1) {
            console.log('🧭 Starte explorativen Modus mit automatischem Login...');
            await runExploration({ page });
        } else if (modeInput === 2) {
            const llm = ensureLLM();
            if (!llm) return;
            const contextSummary = readlineSync.question('📝 Kurzer Kontext (optional, Enter für leer): ').trim();
            // Hole ggf. Story-Text
            const story = readlineSync.question('📖 User Story / Akzeptanzkriterien (kurz): ').trim();
            // Falls dein story.js selbst das LLM nutzt, einfach story dort verarbeiten.
            await runUserStory({ page, llm, contextSummary, story });
        } else if (modeInput === 99) {
            const llm = ensureLLM();
            if (!llm) return;
            const contextSummary = readlineSync.question('📝 Kurzer Kontext (optional, Enter für leer): ').trim();
            const topic = readlineSync.question('🎓 Lern-Thema (z. B. "Login & Filter"): ').trim();
            await runLearnMode({ page, llm, contextSummary, topic });
        } else {
            console.log('❌ Ungültige Eingabe. Bitte 1, 2 oder 99 wählen.');
        }
    } catch (err) {
        console.error('❌ Fehler im Testagent:', err);
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error('❌ Fehler im Testagent (top-level):', err);
});
