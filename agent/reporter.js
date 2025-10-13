import fs from 'fs-extra';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/config.js';

export async function generateBugReport(description, screenshotLabel = 'start') {
    const id = uuidv4();

    const report = {
        id,
        timestamp: new Date().toISOString(),
        description,
        screenshot: `${screenshotLabel}.png`,
        pageUrl: config.baseUrl,
        resolved: false, // später nützlich bei UI
    };

    const filePath = path.join(config.reportDir, `${id}.json`);
    await fs.outputJson(filePath, report, { spaces: 2 });

    return report;
}
