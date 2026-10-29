import { expect, test } from '@playwright/test';

const draft = {
  serviceId: 'diagnostics', date: '2026-11-01', time: '10:00', name: 'Иван',
  phone: '+79991234567', car: 'Лада', comment: '',
};
const booking = { status: 'confirmed', serviceName: 'Диагностика', date: draft.date, time: draft.time };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(value => {
    if (!sessionStorage.getItem('autospectrum.booking.draft')) {
      sessionStorage.setItem('autospectrum.booking.draft', JSON.stringify(value));
    }
  }, draft);
  await page.route('**/api/services', route => route.fulfill({ json: [{ id: 'diagnostics', name: 'Диагностика', priceFrom: 1000, durationMinutes: 30 }] }));
  await page.route('**/api/schedule', route => route.fulfill({ json: { workStart: 540, workEnd: 1020 } }));
});

test('429 keeps review editable and a manual retry uses the same key once', async ({ page }) => {
  const keys: string[] = [];
  await page.route('**/api/bookings', route => {
    keys.push(route.request().headers()['idempotency-key']);
    return keys.length === 1
      ? route.fulfill({ status: 429, headers: { 'Retry-After': '1' }, json: { code: 'rate_limited' } })
      : route.fulfill({ status: 201, json: booking });
  });
  await page.goto('/#/review');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page).toHaveURL(/#\/review$/);
  await expect(page.getByRole('alert')).toContainText('Слишком много заявок');
  await expect(page.getByRole('button', { name: /Повторить через/ })).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem('autospectrum.booking.result'))).toBeNull();
  await page.getByRole('button', { name: 'Назад' }).click();
  await expect(page.getByLabel('Автомобиль')).toHaveValue('Лада');
  await page.getByLabel('Автомобиль').fill('Лада Гранта');
  await expect(page.getByLabel('Автомобиль')).toHaveValue('Лада Гранта');
  await page.getByLabel('Автомобиль').fill('Лада');
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.getByRole('button', { name: 'Отправить' })).toBeEnabled();
  expect(keys).toHaveLength(1);
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page).toHaveURL(/#\/result$/);
  await expect(page.getByText('АВТОСПЕКТР · БЕТА-ВЕРСИЯ')).toBeVisible();
  await expect(page.getByText('Вы записаны. Заявка сохранена в автосервисе на выбранные дату и время.')).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test('network failure preserves the unknown result and directs the visitor to the real phone', async ({ page }) => {
  await page.route('**/api/bookings', route => route.abort('failed'));
  await page.goto('/#/review');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page).toHaveURL(/#\/result$/);
  await expect(page.getByText('Статус заявки неизвестен')).toBeVisible();
  await expect(page.getByText(/\+7\(921\)070-11-99.*перед повторной отправкой/)).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('autospectrum.booking.result') || 'null')?.status)).toBe('unknown');
});

test('ambiguous server failure remains an unknown result', async ({ page }) => {
  await page.route('**/api/bookings', route => route.fulfill({ status: 503, json: { code: 'server_error' } }));
  await page.goto('/#/review');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page).toHaveURL(/#\/result$/);
  await expect(page.getByText('Статус заявки неизвестен')).toBeVisible();
});

test('accepted overbooked booking says the time may move', async ({ page }) => {
  await page.route('**/api/bookings', route => route.fulfill({ status: 201, json: { ...booking, status: 'overbooked' } }));
  await page.goto('/#/review');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByRole('heading', { name: 'Заявка принята' })).toBeVisible();
  await expect(page.getByText(/возможен перенос/)).toBeVisible();
  await expect(page.getByText('АВТОСПЕКТР · БЕТА-ВЕРСИЯ')).toBeVisible();
});
