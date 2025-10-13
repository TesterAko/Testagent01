import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.getByText('TMS (Disposition)').click();
  await page.getByText('TourenPlanung').click();
});