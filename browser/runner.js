import { chromium } from 'playwright';
import { config } from '../config/config.js';
import { captureDOM, captureScreenshot } from './dom-capture.js';

export async function launchAndNavigate() {
  const browser = await chromium.launch({ headless: false }); // Sichtbar für Debugging
  const page = await browser.newPage();

  console.log(`🌐 Navigiere zu: ${config.baseUrl}`);
  await page.goto(config.baseUrl, { waitUntil: 'networkidle' });

  await captureScreenshot(page, 'start');
  const html = await captureDOM(page, 'start');

  return { browser, page, html };
}
