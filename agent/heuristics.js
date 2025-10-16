// agent/heuristics.js
// KI-Grundheuristiken für den Explorationsmodus – domain-aware (Logistik/Dispo).
// - Strikt wkrad-id only
// - Navigation priorisieren
// - Domain-Gewichte (tour, auftrag, kunde, fahrzeug, …)
// - Optionaler Zielhinweis via ENV GOAL_HINT (Comma- oder Space-separiert)
// - Nicht-destruktiv; destruktive IDs werden gefiltert, sofern nicht explizit erlaubt.
//
// Node: ESM

const ALLOW_DESTRUCTIVE = String(process.env.ALLOW_DESTRUCTIVE || 'false').toLowerCase() === 'true';

// Konservativer Filter für potenziell destruktive/irreversible Elemente
const BAD_ID_RE =
    /(logout|abmelden|delete|remove|destroy|drop|truncate|erase|unlink|void|submit|save|speichern|löschen|entfernen|abschicken|übernehmen|bestätigen|confirm|ok|password|passwort)/i;

// Domain-Vokabular (Logistik/Dispo/TMS) – gibt Bonuspunkte in Scoring
const DOMAIN_TERMS = [
    'tour', 'touren', 'tourenplanung', 'dispo', 'disposition', 'planung', 'plan',
    'auftrag', 'aufträge', 'sendung', 'sendungen', 'fracht', 'ladeauftrag',
    'kunde', 'kunden', 'partner', 'fahrer', 'fahrzeug', 'flotte', 'ressourcen',
    'route', 'routing', 'strecke', 'karte', 'map', 'zeitfenster', 'slot',
    'lager', 'hub', 'depot', 'umschlag', 'lieferschein', 'reklamation',
    'kosten', 'preis', 'tarif', 'rechnung', 'abrechnung', 'status',
    'scan', 'tracking', 'trackingid', 'eta', 'anlieferung', 'abholung',
];

// Optional: GOAL_HINT aus ENV (z. B. "tourenplanung, kunde anlegen")
const GOAL_HINT = String(process.env.GOAL_HINT || '').trim();
const GOAL_TERMS = GOAL_HINT
    ? GOAL_HINT.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    : [];

// -------------------------------- Utilities ----------------------------------

export function toSelector(id) {
    return `[wkrad-id="${id}"], [data-wkrad-id="${id}"]`;
}

export function isDestructiveId(id = '') {
    if (ALLOW_DESTRUCTIVE) return false;
    return BAD_ID_RE.test(id || '');
}

export async function visibleWkradIds(page, limit = 200) {
    const ids = await page.evaluate((lim) => {
        const isVisible = (el) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled;
        };
        return Array.from(document.querySelectorAll('[wkrad-id], [data-wkrad-id]'))
            .filter(isVisible)
            .slice(0, lim)
            .map(el => el.getAttribute('wkrad-id') || el.getAttribute('data-wkrad-id'))
            .filter(Boolean);
    }, limit);
    return ids;
}

function dedupeBySelector(actions) {
    const seen = new Set();
    return actions.filter(a => {
        const key = `${a.type}:${a.selector}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ------------------------------- Scoring -------------------------------------

function includesAny(hay = '', terms = []) {
    const s = String(hay || '').toLowerCase();
    return terms.some(t => s.includes(String(t).toLowerCase()));
}

function wordScore(hay = '', terms = [], weight = 1) {
    const s = String(hay || '').toLowerCase();
    let sum = 0;
    for (const t of terms) {
        const needle = String(t).toLowerCase();
        if (!needle) continue;
        // einfache Häufigkeitswertung
        let idx = s.indexOf(needle);
        while (idx !== -1) {
            sum += weight;
            idx = s.indexOf(needle, idx + needle.length);
        }
    }
    return sum;
}

// -------------------------------- Discovery ----------------------------------

// DOM-Discovery: generiert sichere, nicht-destruktive Default-Aktionen (wkrad-id only)
// Domain-Begriffe & Navigations-Signale werden stark gewichtet.
export async function discoverActions(page, limit = 12) {
    const raw = await page.evaluate((lim) => {
        const isVisible = (el) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled;
        };
        const pick = (id) => `[wkrad-id="${id}"], [data-wkrad-id="${id}"]`;
        const els = Array.from(document.querySelectorAll('[wkrad-id], [data-wkrad-id]')).filter(isVisible);

        const out = [];
        for (const el of els) {
            const id = el.getAttribute('wkrad-id') || el.getAttribute('data-wkrad-id');
            if (!id) continue;
            const tag = (el.tagName || '').toLowerCase();
            const role = (el.getAttribute('role') || '').toLowerCase();
            const type = (el.getAttribute('type') || '').toLowerCase();
            const txt = (el.innerText || el.textContent || '').trim().slice(0, 160);
            const cls = (el.getAttribute('class') || '').toLowerCase();
            const aria = {
                expanded: (el.getAttribute('aria-expanded') || '').toLowerCase(),
                haspopup: (el.getAttribute('aria-haspopup') || '').toLowerCase(),
            };
            out.push({ id, tag, role, type, txt, cls, aria, selector: pick(id) });
            if (out.length >= lim * 4) break; // mehr Rohmaterial, später filtern
        }
        return out;
    }, limit);

    // Filter: keine destruktiven IDs (falls nicht explizit erlaubt) & Inputs nur mit klar sicheren Typen
    const candidates = raw.filter(c =>
        c.id &&
        (!isDestructiveId(c.id)) &&
        !(c.tag === 'input' && !/^(text|email|search)$/i.test(c.type || ''))
    );

    // Navigationserkennung
    const navHint = (s) => /menu|nav|sidebar|tab|tabs|open|expand|liste|übersicht|drawer|panel|menü|breadcrumb|zurück|weiter/.test((s || '').toLowerCase());
    const roleNav = (r) => /(tab|menuitem|navigation|link|button)/.test((r || '').toLowerCase());
    const primaryHint = (s) => /(primary|nav|menu|sidebar|tab|active|current|selected)/.test((s || '').toLowerCase());

    const scoreOf = (c) => {
        let s = 0;

        // 1) Navigation stark priorisieren
        if (navHint(c.id) || navHint(c.txt)) s += 3.5;
        if (roleNav(c.role)) s += 2.2;
        if (primaryHint(c.cls)) s += 1.0;
        if (c.tag === 'a') s += 1.0;
        if (c.aria.expanded === 'false' || c.aria.haspopup === 'true') s += 0.8;

        // 2) Form/Filter (für Tester-Workflows wichtig)
        if (c.tag === 'select') s += 1.2;
        if (c.tag === 'input' && /^(text|email|search)$/i.test(c.type || '')) s += 1.0;

        // 3) Domain-Priorisierung (IDs + sichtbarer Text + CSS-Klassen)
        s += wordScore(c.id, DOMAIN_TERMS, 1.6);
        s += wordScore(c.txt, DOMAIN_TERMS, 1.2);
        s += wordScore(c.cls, DOMAIN_TERMS, 0.6);

        // 4) Goal-Hints (falls gesetzt) leicht stärker als Domain
        if (GOAL_TERMS.length) {
            s += wordScore(c.id, GOAL_TERMS, 2.0);
            s += wordScore(c.txt, GOAL_TERMS, 1.6);
            s += wordScore(c.cls, GOAL_TERMS, 0.8);
        }

        // 5) kleiner Jitter für Diversität
        s += Math.random() * 0.25;

        return s;
    };

    const toAction = (c) => {
        // Navigation/Links/Buttons
        if (c.tag === 'button' || c.role === 'button' || c.tag === 'a' || roleNav(c.role) || navHint(c.id) || navHint(c.txt)) {
            return { type: 'click', selector: toSelector(c.id), id: c.id };
        }
        // Selects
        if (c.tag === 'select') {
            return { type: 'select', selector: toSelector(c.id), value: '', id: c.id };
        }
        // Sichere Inputs
        if (c.tag === 'input' && /^(text|email|search)$/i.test(c.type || '')) {
            return { type: 'fill', selector: toSelector(c.id), value: 'test', id: c.id };
        }
        return null;
    };

    const mapped = candidates
        .map(c => ({ cand: c, action: toAction(c), score: scoreOf(c) }))
        .filter(x => x.action);

    // Sortierung nach Score (domain-aware)
    mapped.sort((a, b) => b.score - a.score);

    // Typ-Diversität, damit die KI wie ein Tester „breit“ agiert
    const capPerType = { click: 8, select: 3, fill: 3 };
    const taken = { click: 0, select: 0, fill: 0 };
    const picked = [];
    for (const m of mapped) {
        const t = m.action.type;
        if ((taken[t] ?? 0) >= (capPerType[t] ?? 0)) continue;
        picked.push(m.action);
        taken[t] = (taken[t] ?? 0) + 1;
        if (picked.length >= limit) break;
    }

    // Dedupe by selector
    return dedupeBySelector(picked);
}
