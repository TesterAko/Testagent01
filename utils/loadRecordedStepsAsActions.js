import fs from 'fs-extra';
import path from 'path';

/**
 * Liest eine oder mehrere Playwright .spec.js Dateien und konvertiert sie in Aktionen,
 * die der Agent manuell ausführen kann.
 * @param {string} inputPath - Datei- oder Ordnerpfad
 * @returns {Promise<Array>} - Liste aller extrahierten Aktionen
 */
export async function loadRecordedStepsAsActions(inputPath) {
    const actions = [];

    const isFile = (await fs.stat(inputPath)).isFile();
    const files = isFile
        ? [inputPath]
        : (await fs.readdir(inputPath))
            .filter(f => f.endsWith('.spec.js'))
            .map(f => path.join(inputPath, f));

    for (const file of files) {
        const raw = await fs.readFile(file, 'utf8');
        const lines = raw.split('\n');

        for (let line of lines) {
            line = line.trim();

            if (line.startsWith('await page.goto(')) {
                const url = line.match(/goto\((.*?)\)/)?.[1]?.replaceAll("'", '').replaceAll('"', '');
                if (url) {
                    actions.push({ actionType: 'goto', value: url, description: `Seite aufrufen: ${url}` });
                }
            }

            if (line.includes('getByRole')) {
                const roleMatch = line.match(/getByRole\(\s*['"](.*?)['"],\s*\{\s*name:\s*['"](.*?)['"]\s*\}\)/);
                const action = {};

                if (roleMatch) {
                    action.selector = `role=${roleMatch[1]}[name="${roleMatch[2]}"]`;
                    action.description = `${roleMatch[1]}: ${roleMatch[2]}`;

                    if (line.includes('.fill(')) {
                        const val = line.match(/fill\((.*?)\)/)?.[1]?.replaceAll("'", '').replaceAll('"', '');
                        action.actionType = 'fill';
                        action.value = val;
                    } else if (line.includes('.click(')) {
                        action.actionType = 'click';
                    }

                    if (action.actionType) {
                        actions.push(action);
                    }
                }
            }

            if (line.includes('getByText')) {
                const textMatch = line.match(/getByText\(['"](.*?)['"]\)/);
                if (textMatch) {
                    actions.push({
                        selector: `text=${textMatch[1]}`,
                        actionType: 'click',
                        description: `Text klicken: ${textMatch[1]}`,
                    });
                }
            }
        }
    }

    return actions;
}
