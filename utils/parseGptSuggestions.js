// utils/parseGptSuggestions.js
// Jetzt mit deutscher Aktions-Erkennung: "Fokussiere", "Sende/Submit", "Wähle", "Schreibe/Eingeben"

const DEFAULT_FILL_VALUE = 'test';
const DEFAULT_PASSWORD = process.env.LOGIN_PASSWORD || ''; // statt 'wanko/taipan!'
const DEFAULT_SELECT_VALUE = '1';

function normalize(str) { return (str || '').toLowerCase(); }

function extractQuotedValue(line) {
    const m = line.match(/"([^"]+)"|'([^']+)'/);
    return m ? (m[1] || m[2]) : null;
}

function extractWkradId(line) {
    const m = line.match(/wkrad-id\s*=?\s*["']?([a-zA-Z0-9._-]+)["']?/i);
    return m ? m[1] : null;
}

function detectActionType(line) {
    const L = normalize(line);

    // Reihenfolge wichtig: erst spezifischere Patterns
    if (/\b(press|key|tast(?:e|en)|enter|tab|escape|esc|arrow(?:up|down|left|right))\b/.test(L)) return 'press';
    if (/\b(select|wähle|dropdown|option)\b/.test(L)) return 'select';
    if (/\b(fill|type|eingeben|schreibe)\b/.test(L)) return 'fill';
    if (/\b(click|klicke|klick|öffne|open|toggle|expand|fokussiere|fokussieren|focus)\b/.test(L)) return 'click';
    if (/\b(sende|submit|abschicken|abschicken|formular|login\s*(absenden|senden))\b/.test(L)) return 'press'; // meist Enter auf einem Feld

    return null;
}

function buildSelectorFromWkradId(wkradId) {
    return [
        `[data-wkrad-id="${wkradId}"]`,
        `[wkrad-id="${wkradId}"]`,
        `#${wkradId}`
    ].join(', ');
}

function guessFillValue(line, wkradId) {
    const L = normalize(line + ' ' + (wkradId || ''));
    if (/pass(word)?/.test(L)) return DEFAULT_PASSWORD;
    if (/mail|e-?mail|username|user|login|benutzername|konto/.test(L)) return 'test@example.com';
    const quoted = extractQuotedValue(line);
    return quoted || DEFAULT_FILL_VALUE;
}

function guessSelectValue(line) {
    const quoted = extractQuotedValue(line);
    return quoted || DEFAULT_SELECT_VALUE;
}

function extractKey(line) {
    const m = line.match(/\b(enter|tab|escape|esc|arrow(?:up|down|left|right))\b/i);
    if (!m) return null;
    const key = m[1].toLowerCase();
    if (key === 'esc') return 'Escape';
    return ({
        enter: 'Enter',
        tab: 'Tab',
        escape: 'Escape',
        arrowup: 'ArrowUp',
        arrowdown: 'ArrowDown',
        arrowleft: 'ArrowLeft',
        arrowright: 'ArrowRight'
    })[key] || key;
}

export function parseGptActionSuggestions(gptText) {
    if (!gptText || typeof gptText !== 'string') return [];

    const lines = gptText
        .split('\n')
        .map(l => l.trim())
        // nur tatsächliche Step-Zeilen durchlassen
        .filter(l =>
            /^(-|\d+[.)])\s+/.test(l) &&               // Bullet oder nummeriert
            /wkrad-id\s*=/i.test(l)                    // mit wkrad-id
        );

    const actions = [];

    for (const rawLine of lines) {
        const line = rawLine.replace(/^(-|\d+[.)])\s+/, '');
        const type = detectActionType(line);
        const wkradId = extractWkradId(line);

        if (!wkradId) continue; // ohne id nicht ausführbar

        // type fallback: wenn nichts erkannt → heuristisch
        const finalType = type || (/\b(schreibe|eingabe|fill|type)\b/i.test(line) ? 'fill' : 'click');

        const action = {
            type: finalType,
            wkradId,
            selector: buildSelectorFromWkradId(wkradId)
        };

        if (finalType === 'fill') action.value = guessFillValue(line, wkradId);
        else if (finalType === 'select') action.value = guessSelectValue(line);
        else if (finalType === 'press') action.key = extractKey(line) || 'Enter';

        actions.push(action);
    }

    return actions;
}
