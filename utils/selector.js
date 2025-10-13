// utils/selector.js
// Bevorzugt wkrad-id; fällt auf XPath zurück (User mag XPath). Liefert Playwright-Locator-String.
export function buildSelector({ wkradId, xpath, fallbackCss }) {
    if (wkradId) {
        return `[data-wkrad-id="${wkradId}"], [wkrad-id="${wkradId}"], #${wkradId}`;
    }
    if (xpath) return `xpath=${xpath}`;
    if (fallbackCss) return fallbackCss;
    return null;
}

// einfache XPath-Generator-Utility (für Recorder-Fallback)
export function getXPathFor(node) {
    if (node.id) return `//*[@id="${node.id}"]`;
    const parts = [];
    for (; node && node.nodeType === 1; node = node.parentNode) {
        let ix = 1;
        let sib = node.previousSibling;
        while (sib) {
            if (sib.nodeType === 1 && sib.nodeName === node.nodeName) ix++;
            sib = sib.previousSibling;
        }
        parts.unshift(node.nodeName.toLowerCase() + `[${ix}]`);
    }
    return `/${parts.join('/')}`;
}
