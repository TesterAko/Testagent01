import fs from 'fs-extra';
import path from 'path';

const ACTIONS_FILE = './memory/actions.json';

// Initialisiere Datei, falls nicht vorhanden
async function initFile() {
    if (!(await fs.pathExists(ACTIONS_FILE))) {
        await fs.writeJSON(ACTIONS_FILE, []);
    }
}

// Aktion speichern
export async function rememberAction({ url, selector, action, description }) {
    await initFile();
    const actions = await fs.readJSON(ACTIONS_FILE);

    actions.push({
        timestamp: new Date().toISOString(),
        url,
        selector,
        action,
        description,
    });

    await fs.writeJSON(ACTIONS_FILE, actions, { spaces: 2 });
}

// Aktionen abrufen
export async function getRememberedActions(url = null) {
    await initFile();
    const actions = await fs.readJSON(ACTIONS_FILE);
    return url ? actions.filter(a => a.url === url) : actions;
}
