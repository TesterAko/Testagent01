
import fs from 'fs-extra';
import path from 'path';
import { config } from '../config/config.js';

export async function captureDOM(page, label = 'dom') {
    const html = await page.content();
    const filePath = path.join(config.screenshotDir, `${label}.html`);
    await fs.outputFile(filePath, html);
    return html;
}

export async function captureScreenshot(page, label = 'screenshot') {
    const filePath = path.join(config.screenshotDir, `${label}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
}
