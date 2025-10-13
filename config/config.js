// config/config.js
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test-output');
const SCREEN_DIR = path.join(OUT_DIR, 'screens');
const REPORT_DIR = path.join(OUT_DIR, 'bug-reports');
const DOM_DIR = path.join(OUT_DIR, 'dom');

await fs.ensureDir(SCREEN_DIR);
await fs.ensureDir(REPORT_DIR);
await fs.ensureDir(DOM_DIR);

export const config = {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.BASE_URL || '',
    headless: String(process.env.HEADLESS || 'true').toLowerCase() === 'true',
    mode: (process.env.MODE || '').toLowerCase(), // 'explore' | 'story' | 'learn'
    screenshotDir: SCREEN_DIR,
    reportDir: REPORT_DIR,
    domDir: DOM_DIR,
    // optionale Credentials aus ENV (werden mit memory/credentials.json gemerged)
    creds: {
        username: process.env.LOGIN_USERNAME || '',
        password: process.env.LOGIN_PASSWORD || '',
        email: process.env.LOGIN_EMAIL || '',
    }
};
