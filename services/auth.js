// services/auth.js
// Single-Responsibility: Login + "Selector-Lernen" (wkrad-id only).
// - Liest Credentials aus ENV (+optional memory/credentials.json)
// - Nutzt gespeicherte, funktionierende wkrad-id-Selektoren zuerst
// - Fällt auf Kandidatenliste zurück, validiert live und speichert
// - Erkanntes Muster (funktionierende Felder/Buttons) persistiert nach memory/known-selectors.json
//
// ENV expected:
//   LOGIN_USERNAME, LOGIN_PASSWORD, (optional) LOGIN_EMAIL, LOGIN_LANGUAGE
//
// Persistenzdateien:
//   memory/credentials.json          (optional, zusätzliche Werte / feldspezifische Zuordnung)
//   memory/known-selectors.json      (wird von dieser Klasse gepflegt)

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Pfade ------------------------------------------------------------------

const MEMORY_DIR = path.resolve(__dirname, '../memory');
const CREDENTIALS_PATH = path.join(MEMORY_DIR, 'credentials.json');
const KNOWN_SELECTORS = path.join(MEMORY_DIR, 'known-selectors.json');

// ---- Util -------------------------------------------------------------------

async function readJsonSafe(file, fallback = {}) {
    try {
        return await fs.readJson(file);
    } catch {
        return fallback;
    }
}

async function writeJsonPretty(file, obj) {
    await fs.ensureDir(path.dirname(file));
    await fs.writeJson(file, obj, { spaces: 2 });
}

function selectorForId(id) {
    return `[wkrad-id="${id}"], [data-wkrad-id="${id}"]`;
}

async function isVisible(page, selector, timeout = 6000) {
    const loc = page.locator(selector).first();
    const count = await loc.count();
    if (!count) return false;
    try {
        await loc.waitFor({ state: 'visible', timeout });
        return await loc.isVisible();
    } catch {
        return false;
    }
}

async function clickIfVisible(page, selector) {
    if (await isVisible(page, selector)) {
        await page.locator(selector).first().click();
        return true;
    }
    return false;
}

async function fillIfVisible(page, selector, value) {
    if (await isVisible(page, selector)) {
        await page.locator(selector).first().fill(String(value ?? ''));
        return true;
    }
    return false;
}

// ---- AuthService ------------------------------------------------------------

export class AuthService {
    constructor(options = {}) {
        this.memoryFile = KNOWN_SELECTORS;
        // ENV hat Vorrang
        this.creds = {
            username: process.env.LOGIN_USERNAME || '',
            password: process.env.LOGIN_PASSWORD || '',
            email: process.env.LOGIN_EMAIL || '',
            language: process.env.LOGIN_LANGUAGE || '',
            ...(options.creds || {})
        };
        this._loaded = false;
        this._known = { login: {} }; // wird aus Datei geladen
    }

    async load() {
        if (this._loaded) return;
        const known = await readJsonSafe(this.memoryFile, { login: {} });

        // optional: zusätzliche creds aus Datei mergen (falls vorhanden)
        const fileCreds = await readJsonSafe(CREDENTIALS_PATH, {});
        const mapLower = Object.fromEntries(Object.entries(fileCreds).map(([k, v]) => [String(k).toLowerCase(), v]));
        this.creds.username ||= mapLower.username || mapLower.user || mapLower.login || '';
        this.creds.password ||= mapLower.password || mapLower.pass || '';
        this.creds.email ||= mapLower.email || '';
        this.creds.language ||= mapLower.language || mapLower.sprache || '';

        this._known = known;
        this._loaded = true;
    }

    // Heuristik: Login erkennbar, wenn Login-Container sichtbar ODER Main-Menü unsichtbar
    async isLoggedIn(page) {
        const mainVisible = await isVisible(page, selectorForId('MainApo.Menu'));
        const loginVisible = await isVisible(page, selectorForId('LoginApo'));
        return mainVisible || !loginVisible;
    }

    // Kandidatenliste – nur wkrad-id-Namen
    _candidateIds() {
        return {
            username: [
                'LoginApo.Benutzername.Input',
                'LoginApo.Username',
                'LoginApo.User'
            ],
            password: [
                'LoginApo.Passwort.Input',
                'LoginApo.Password',
                'LoginApo.Pass'
            ],
            language: [
                'LoginApo.dboLanguageCode',
                'LoginApo.Language'
            ],
            submit: [
                'LoginApo.Submit',
                'LoginApo.Login',
                'LoginApo.Anmelden'
            ],
            container: [
                'LoginApo'
            ]
        };
    }

    // Versucht Felder/Buttons auf der Seite zu validieren, speichert funktionierende IDs
    async _discoverSelectors(page) {
        const found = {};
        const cand = this._candidateIds();

        // Container sichtbar?
        for (const id of cand.container) {
            if (await isVisible(page, selectorForId(id))) {
                found.container = id;
                break;
            }
        }

        for (const role of ['username', 'password', 'language', 'submit']) {
            for (const id of cand[role]) {
                const sel = selectorForId(id);
                if (await isVisible(page, sel)) {
                    found[role] = id;
                    break;
                }
            }
        }
        return found;
    }

    // lädt bekannte Selektoren, ergänzt per Discovery, schreibt zurück falls neu
    async resolveLoginSelectors(page) {
        await this.load();
        const known = { ...(this._known?.login || {}) };

        // Falls bekannt & sichtbar, direkt nutzen
        const resolved = {};
        for (const k of ['container', 'username', 'password', 'language', 'submit']) {
            const id = known[k];
            if (id && await isVisible(page, selectorForId(id))) {
                resolved[k] = id;
            }
        }

        // Fehlende per Discovery ergänzen
        const discovered = await this._discoverSelectors(page);
        for (const [k, v] of Object.entries(discovered)) {
            if (!resolved[k]) resolved[k] = v;
        }

        // wenn sich etwas geändert/ergänzt hat -> speichern (lernen)
        const hasDiff =
            JSON.stringify(known) !== JSON.stringify(resolved) &&
            Object.keys(resolved).length > 0;

        if (hasDiff) {
            this._known.login = resolved;
            await writeJsonPretty(this.memoryFile, this._known);
        }

        return resolved;
    }

    async login(page) {
        await this.load();

        // Wenn schon eingeloggt, abkürzen
        if (await this.isLoggedIn(page)) return true;

        // Selektoren bestimmen (lernen/abrufen)
        const selIds = await this.resolveLoginSelectors(page);
        const {
            username: userId,
            password: passId,
            language: langId,
            submit: submitId
        } = selIds;

        // Fallback, wenn nichts gefunden wurde
        if (!userId && !passId && !submitId) {
            // letzte Chance: Enter auf irgendeinem sichtbaren Passwortfeld-Kandidaten
            const passIds = this._candidateIds().password;
            for (const pid of passIds) {
                if (await isVisible(page, selectorForId(pid))) {
                    await page.locator(selectorForId(pid)).first().press('Enter').catch(() => { });
                    break;
                }
            }
            await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => { });
            return this.isLoggedIn(page);
        }

        // Eingaben
        const userValue = this.creds.username || this.creds.email || '';
        const passValue = this.creds.password || '';

        if (!userValue || !passValue) {
            throw new Error('Login fehlgeschlagen: LOGIN_USERNAME/LOGIN_PASSWORD fehlen. Bitte .env prüfen.');
        }

        if (userId) await fillIfVisible(page, selectorForId(userId), userValue);
        if (passId) await fillIfVisible(page, selectorForId(passId), passValue);

        if (langId && this.creds.language) {
            const sel = selectorForId(langId);
            const loc = page.locator(sel).first();
            if (await loc.count()) {
                try { await loc.selectOption(String(this.creds.language)); }
                catch { await loc.fill(String(this.creds.language)); }
            }
        }

        // Submit
        let clicked = false;
        if (submitId) {
            clicked = await clickIfVisible(page, selectorForId(submitId));
        }
        if (!clicked && passId) {
            // Enter auf Passwortfeld
            await page.locator(selectorForId(passId)).first().press('Enter').catch(() => { });
        }

        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

        const ok = await this.isLoggedIn(page);

        // nach erfolgreichem Login: funktionierende IDs persistieren (lernen)
        if (ok) {
            const stable = await this._discoverSelectors(page);
            const merged = { ...this._known.login, ...selIds, ...stable };
            this._known.login = merged;
            await writeJsonPretty(this.memoryFile, this._known);
        }

        return ok;
    }

    async ensureLoggedIn(page) {
        if (await this.isLoggedIn(page)) return true;
        const ok = await this.login(page);
        if (!ok) throw new Error('Login fehlgeschlagen (ensureLoggedIn).');
        return true;
    }
}
