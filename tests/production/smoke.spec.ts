import { expect, test } from '@playwright/test';

test('production nginx serves the built browser app and database-backed readiness over TLS', async ({ page, request }) => {
  const ready = await request.get('/api/readyz');
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toEqual({ status: 'ok' });

  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['strict-transport-security']).toContain('max-age=');
  await expect(page.locator('#app')).not.toBeEmpty();
});
