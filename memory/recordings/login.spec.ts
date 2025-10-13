import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://localhost:3004/#lang=de');
  await page.getByText('Benutzername').click();
  await page.getByRole('textbox', { name: 'Benutzername' }).click();
  await page.getByRole('textbox', { name: 'Benutzername' }).fill('wanko');
  await page.getByRole('textbox', { name: 'Passwort' }).click();
  await page.getByRole('textbox', { name: 'Passwort' }).fill('taipan');
  await page.getByText('Sprache').nth(2).click();
  await page.getByRole('textbox', { name: 'Sprache wählen' }).click();
  await page.locator('[id="72"]').getByRole('button', { name: '' }).click();
  await page.getByText('German').click();
  page.once('dialog', dialog => {
    console.log(`Dialog message: ${dialog.message()}`);
    dialog.dismiss().catch(() => {});
  });
  await page.getByRole('button', { name: 'Anmelden' }).click();
});