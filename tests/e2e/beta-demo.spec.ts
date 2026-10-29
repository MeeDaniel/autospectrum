import { expect, test } from '@playwright/test';

test('local demo labels its saved booking as a test, not a real appointment', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Услуга').selectOption('diagnostics');
  await page.getByLabel('Ваше имя').fill('Иван');
  await page.getByLabel('Телефон').fill('89991234567');
  await page.getByLabel('Автомобиль').fill('Лада');
  await page.getByRole('button', { name: 'Выбрать дату и время' }).click();
  await page.locator('.calendar-day:not([disabled])').first().click();
  await page.getByRole('button', { name: '10:00' }).click();
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await page.getByRole('button', { name: 'Далее' }).click();
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('АВТОСПЕКТР · ДЕМО')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Тестовая заявка сохранена' })).toBeVisible();
  await expect(page.getByText(/Настоящая запись в автосервис не создана/)).toBeVisible();
  await expect(page.getByText('Вы записаны. Заявка сохранена в автосервисе на выбранные дату и время.')).toHaveCount(0);
});
