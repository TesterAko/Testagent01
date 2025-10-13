// agent/learn.js
// Modus 99: Recorder – zeichnet Nutzeraktionen auf und speichert sie als Trainingsdaten
import { saveRecording, upsertElementKnowledge, addFlow } from '../memory/store.js';

function isDestructiveText(t) {
    return /\b(delete|löschen|remove|cancel|abbrechen|logout|sign out)\b/i.test(t || '');
}

function inferActionFromEvent(e) {
    if (e.type === 'click') return 'click';
    if (e.type === 'change' && e.tagName === 'select') return 'select';
    if (e.type === 'input' && (e.tagName === 'input' || e.tagName === 'textarea')) return 'fill';
    if (e.type === 'keydown') return 'press';
    return null;
}

export async function runLearnMode({ page, contextSummary = '', topic = '' }) {
    console.log('🎓 Starte Lern-Recorder…');
    const startedAt = Date.now();

    // Frontend-Hook injizieren, um Events zu sammeln
    await page.exposeFunction('__agent_record_push__', (evt) => {
        // no-op; wire by return; we pull later through page.evaluate?
    });

    await page.addInitScript(() => {
        (function () {
            const queue = [];
            window.__agent_record_queue__ = queue;

            function getXPathFor(node) {
                if (!node) return null;
                if (node.id) return `//*[@id="${node.id}"]`;
                const parts = [];
                for (; node && node.nodeType === 1; node = node.parentNode) {
                    let ix = 1, sib = node.previousSibling;
                    while (sib) { if (sib.nodeType === 1 && sib.nodeName === node.nodeName) ix++; sib = sib.previousSibling; }
                    parts.unshift(node.nodeName.toLowerCase() + `[${ix}]`);
                }
                return '/' + parts.join('/');
            }

            const handler = (type) => (ev) => {
                const t = ev.target;
                if (!t) return;

                const attrs = {};
                for (const a of (t.attributes || [])) attrs[a.name] = a.value;

                const entry = {
                    t: Date.now(),
                    type,
                    tag: (t.tagName || '').toLowerCase(),
                    text: (t.innerText || t.textContent || '').trim().slice(0, 120),
                    wkradId: attrs['data-wkrad-id'] || attrs['wkrad-id'] || null,
                    xpath: getXPathFor(t),
                    value: (type === 'fill' || type === 'select') ? (t.value || '') : undefined,
                    key: type === 'press' ? (ev.key || '') : undefined
                };
                queue.push(entry);
            };

            document.addEventListener('click', handler('click'), true);
            document.addEventListener('input', (e) => handler('fill')(e), true);
            document.addEventListener('change', (e) => {
                const target = e.target;
                if (target && target.tagName && target.tagName.toLowerCase() === 'select') handler('select')(e);
            }, true);
            document.addEventListener('keydown', (e) => handler('press')(e), true);
        })();
    });

    console.log('🟢 Recorder läuft. Führe jetzt deine Schritte in der App aus. (Beenden mit ENTER im Terminal)');
    // Warten bis ENTER
    await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', () => resolve());
    });

    const raw = await page.evaluate(() => {
        return Array.from(window.__agent_record_queue__ || []);
    });

    // In Actions-Format konvertieren + Wissen anreichern
    const steps = [];
    for (const e of raw) {
        const type = inferActionFromEvent({ type: e.type, tagName: e.tag });
        if (!type) continue;

        // destruktives ausfiltern
        if (isDestructiveText(e.text)) continue;

        const step = {
            type,
            wkradId: e.wkradId || null,
            xpath: e.xpath || null,
            value: e.value,
            key: e.key
        };
        steps.push(step);

        // Wissen aktualisieren
        await upsertElementKnowledge({
            wkradId: e.wkradId,
            xpath: e.xpath,
            text: e.text,
            role: e.tag
        });
    }

    if (!steps.length) {
        console.log('ℹ️ Keine verwertbaren Schritte aufgezeichnet.');
        return;
    }

    const name = topic || contextSummary || 'session';
    const file = await saveRecording(name, steps, { startedAt });
    await addFlow(`learn:${name}`, steps);

    console.log(`✅ Aufzeichnung gespeichert: ${file}`);
    console.log(`📚 ${steps.length} Schritte in Knowledge-Base übernommen.`);
}
