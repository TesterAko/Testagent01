// utils/extractors.js
import { JSDOM } from 'jsdom';

export function extractWkradSelectors(html) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const elements = [...document.querySelectorAll('[wkrad-id]')];

    return elements.map(el => ({
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute('id'),
        wkradId: el.getAttribute('wkrad-id'),
        text: el.textContent.trim().slice(0, 100)
    }));
}
