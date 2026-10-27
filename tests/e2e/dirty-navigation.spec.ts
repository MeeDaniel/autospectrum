import { expect, test, type Page } from '@playwright/test';

const cases = [
  { section: 'settings', open: null, dialog: null, label: 'Начало', value: '10:15' },
  { section: 'bookings', open: '+ Новая запись', dialog: 'Новая запись', label: 'Имя клиента', value: 'Черновик заявки' },
  { section: 'services', open: '+ Добавить услугу', dialog: 'Новая услуга', label: 'Название', value: 'Черновик услуги' },
  { section: 'categories', open: '+ Добавить категорию', dialog: 'Новая категория', label: 'Название', value: 'Черновик категории' },
] as const;

async function dirtyEditor(page: Page, item: typeof cases[number], navigate = true) {
  if (navigate) await page.goto(`/admin/#/${item.section}`);
  if (item.open) await page.getByRole('button', { name: item.open }).click();
  const scope = item.dialog ? page.getByRole('dialog', { name: item.dialog }) : page.locator('.admin-panel').filter({ has: page.getByRole('heading', { name: 'Понедельник' }) });
  await scope.getByLabel(item.label).fill(item.value);
  await expect(scope.getByLabel(item.label)).toHaveValue(item.value);
  return scope;
}

for (const item of cases) {
  test(`${item.section} keeps a dirty editor mounted when sidebar navigation is cancelled`, async ({ page }) => {
    const editor = await dirtyEditor(page, item);
    const original = await editor.elementHandle();
    let prompts = 0;
    page.on('dialog', dialog => { prompts += 1; void dialog.dismiss(); });
    await page.getByRole('link', { name: item.section === 'services' ? 'Записи' : 'Услуги' }).evaluate(element => (element as HTMLAnchorElement).click());
    await expect.poll(() => prompts).toBe(1);
    await expect(editor.getByLabel(item.label)).toHaveValue(item.value);
    expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/#/${item.section}$`));
    expect(prompts).toBe(1);
  });
}

test('accepted sidebar navigation leaves a dirty editor', async ({ page }) => {
  await dirtyEditor(page, cases[2]);
  let prompts = 0;
  page.on('dialog', dialog => { prompts += 1; void dialog.accept(); });
  await page.getByRole('link', { name: 'Категории' }).evaluate(element => (element as HTMLAnchorElement).click());
  await expect.poll(() => prompts).toBe(1);
  await expect(page).toHaveURL(/#\/categories$/);
  await expect(page.getByRole('dialog', { name: 'Новая услуга' })).toHaveCount(0);
  expect(prompts).toBe(1);
});

test('Back and manual hash changes prompt once and preserve draft on cancel', async ({ page }) => {
  await page.goto('/admin/#/bookings');
  await page.getByRole('link', { name: 'Услуги' }).click();
  const editor = await dirtyEditor(page, cases[2], false);
  let prompts = 0;
  page.on('dialog', dialog => { prompts += 1; void dialog.dismiss(); });
  await page.goBack();
  await expect.poll(() => prompts).toBe(1);
  await expect(editor.getByLabel('Название')).toHaveValue('Черновик услуги');
  await expect(page).toHaveURL(/#\/services$/);
  expect(prompts).toBe(1);
  await page.evaluate(() => { window.location.hash = '#/categories'; });
  await expect.poll(() => prompts).toBe(2);
  await expect(editor.getByLabel('Название')).toHaveValue('Черновик услуги');
  await expect(page).toHaveURL(/#\/services$/);
  expect(prompts).toBe(2);
});

test('Forward prompts once; cancel retains the editor', async ({ page }) => {
  await page.goto('/admin/#/bookings');
  await page.getByRole('link', { name: 'Услуги' }).click();
  await page.getByRole('link', { name: 'Категории' }).click();
  await page.goBack();
  await expect(page).toHaveURL(/#\/services$/);
  const editor = await dirtyEditor(page, cases[2], false);
  let prompts = 0;
  page.on('dialog', dialog => { prompts += 1; void dialog.dismiss(); });
  await page.goForward();
  await expect.poll(() => prompts).toBe(1);
  await expect(editor.getByLabel('Название')).toHaveValue('Черновик услуги');
  await expect(page).toHaveURL(/#\/services$/);
});

test('confirmed Back navigation leaves the dirty editor', async ({ page }) => {
  await page.goto('/admin/#/bookings');
  await page.getByRole('link', { name: 'Услуги' }).click();
  await dirtyEditor(page, cases[2], false);
  let prompts = 0;
  page.on('dialog', dialog => { prompts += 1; void dialog.accept(); });
  await page.goBack();
  await expect(page).toHaveURL(/#\/bookings$/);
  await expect(page.getByRole('dialog', { name: 'Новая услуга' })).toHaveCount(0);
  expect(prompts).toBe(1);
});

test('clean and saved settings navigate without a prompt', async ({ page }) => {
  await page.goto('/admin/#/settings');
  let prompts = 0;
  page.on('dialog', dialog => { prompts += 1; void dialog.dismiss(); });
  await page.getByRole('link', { name: 'Услуги' }).click();
  await expect(page).toHaveURL(/#\/services$/);
  await page.getByRole('link', { name: 'Настройки' }).click();
  const monday = page.locator('.admin-panel').filter({ has: page.getByRole('heading', { name: 'Понедельник' }) });
  await monday.getByLabel('Начало').fill('10:00');
  await page.getByRole('button', { name: 'Сохранить график' }).click();
  await expect(page.getByText('Расписание сохранено.')).toBeVisible();
  await page.getByRole('link', { name: 'Услуги' }).click();
  await expect(page).toHaveURL(/#\/services$/);
  expect(prompts).toBe(0);
});

test('clicking the current section does not add a duplicate history entry', async ({ page }) => {
  await page.goto('/admin/#/services');
  const length = await page.evaluate(() => history.length);
  await page.getByRole('link', { name: 'Услуги' }).click();
  expect(await page.evaluate(() => history.length)).toBe(length);
});
