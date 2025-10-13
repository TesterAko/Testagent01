// am Kopf der Datei (zusätzlich)
import fsExtra from 'fs-extra';
import { config } from '../config/config.js';

const CRED_PATH = path.resolve(__dirname, '../memory/credentials.json');

function normalizeCredentialMap(raw) {
    const flat = {};
    for (const [k, v] of Object.entries(raw || {})) {
        const lk = String(k).toLowerCase();
        if (lk.includes('pass')) flat.password = v;
        else if (lk.includes('user') || lk.includes('login')) flat.username = v;
        else if (lk.includes('mail')) flat.email = v;
    }
    // ENV hat Vorrang falls gesetzt
    return {
        username: config.creds.username || flat.username || '',
        password: config.creds.password || flat.password || '',
        email: config.creds.email || flat.email || '',
    };
}

let CREDENTIALS = {};
try {
    const file = await fsExtra.readJson(CRED_PATH).catch(() => ({}));
    CREDENTIALS = normalizeCredentialMap(file);
} catch { CREDENTIALS = normalizeCredentialMap({}); }

// ... unten in pickFromCredentials(meta)
function pickFromCredentials(meta) {
    const hay = `${(meta.id || '')} ${(meta.name || '')} ${(meta.placeholder || '')}`.toLowerCase();
    if (/\b(pass|kennwort)\b/.test(hay) && CREDENTIALS.password) return CREDENTIALS.password;
    if (/\b(user|login)\b/.test(hay) && CREDENTIALS.username) return CREDENTIALS.username;
    if (/\bmail|e-?mail\b/.test(hay) && CREDENTIALS.email) return CREDENTIALS.email;
    // Fallback: wenn nur 2 Felder sichtbar sind (user/pass), priorisiere username → password
    return CREDENTIALS.username || CREDENTIALS.email || CREDENTIALS.password || '';
}
