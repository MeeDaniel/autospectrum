import { expect, test } from '@playwright/test';

test('operator sees a public request, confirms an overlap, then resolves it', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Услуга').selectOption('diagnostics');
  await page.getByLabel('Ваше имя').fill('Иван Тестовый');
  await page.getByLabel('Телефон').fill('89991234567');
  await page.getByLabel('Автомобиль').fill('Лада Веста');
  await page.getByRole('button', { name: 'Выбрать дату и время' }).click();
  await page.locator('.calendar-day:not([disabled])').last().click();
  await page.getByRole('button', { name: '10:00' }).click();
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  const selectedDate = await page.evaluate(() => JSON.parse(sessionStorage.getItem('autospectrum.booking.draft')!).date as string);
  await page.getByRole('button', { name: 'Далее' }).click();
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('Вы записаны')).toBeVisible();

  await page.goto('/admin/#/bookings');
  await page.getByRole('button', { name: 'За всё время' }).click();
  await expect(page.getByText('Иван Тестовый')).toBeVisible();
  await page.getByRole('link', { name: 'Категории' }).click();
  await page.getByRole('button', { name: 'Изменить' }).first().click();
  await page.getByLabel('Количество линий').fill('1');
  await page.getByRole('button', { name: 'Сохранить категорию' }).click();
  await expect(page.getByText('Категория сохранена.')).toBeVisible();

  await page.getByRole('link', { name: 'Записи' }).click();
  await page.getByRole('button', { name: '+ Новая запись' }).click();
  const editor = page.getByRole('dialog', { name: 'Новая запись' });
  await editor.getByLabel('Услуга').selectOption('diagnostics');
  await editor.getByLabel('Дата').fill(selectedDate);
  await editor.getByLabel('Время').fill('10:00');
  await editor.getByLabel('Имя клиента').fill('Мария Тестовая');
  await editor.getByLabel('Телефон').fill('89997654321');
  await editor.getByLabel('Автомобиль').fill('Киа Рио');
  await expect(editor.getByText('Превышено число линий')).toBeVisible();
  await editor.getByLabel('Сохранить несмотря на конфликты').check();
  await editor.getByRole('button', { name: 'Сохранить запись' }).click();
  await expect(page.getByText('Запись сохранена.')).toBeVisible();
  await page.getByRole('button', { name: 'За всё время' }).click();
  const maria = page.getByRole('row').filter({ hasText: 'Мария Тестовая' });
  await expect(maria.getByText(/конфликт/)).toBeVisible();
  await maria.getByRole('button', { name: 'Открыть' }).click();
  const fix = page.getByRole('dialog', { name: 'Редактирование записи' });
  await fix.getByLabel('Время').fill('10:30');
  await fix.getByRole('button', { name: 'Сохранить запись' }).click();
  await expect(page.getByText('Запись сохранена.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Мария Тестовая' }).getByText('Без конфликтов')).toBeVisible();
});

test('operator edits the catalog and schedule and sees affected requests', async ({ page }) => {
  await page.goto('/admin/#/categories');
  await page.getByRole('button', { name: '+ Добавить категорию' }).click();
  let editor = page.getByRole('dialog', { name: 'Новая категория' });
  await editor.getByLabel('Название').fill('Кузовные работы');
  await editor.getByLabel('Количество линий').fill('1');
  await editor.getByRole('button', { name: 'Сохранить категорию' }).click();
  await expect(page.getByText('Кузовные работы')).toBeVisible();

  await page.getByRole('link', { name: 'Услуги' }).click();
  await page.getByRole('button', { name: '+ Добавить услугу' }).click();
  editor = page.getByRole('dialog', { name: 'Новая услуга' });
  await editor.getByLabel('Название').fill('Полировка');
  await editor.getByLabel('Категория').selectOption({ label: 'Кузовные работы' });
  await editor.getByLabel('Стартовая цена, ₽').fill('3500');
  await editor.getByLabel('Примерное время, мин').fill('90');
  await editor.getByRole('button', { name: 'Сохранить услугу' }).click();
  await expect(page.getByText('Полировка')).toBeVisible();

  await page.getByRole('link', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: '+ Добавить перерыв' }).click();
  await page.locator('.admin-break-row').last().getByLabel('От', { exact: true }).fill('15:00');
  await page.locator('.admin-break-row').last().getByLabel('До', { exact: true }).fill('15:30');
  await page.getByRole('button', { name: 'Сохранить график' }).click();
  await expect(page.getByText('Расписание сохранено.')).toBeVisible();
  await page.reload();
  await expect(page.locator('.admin-break-row').last().getByLabel('От', { exact: true })).toHaveValue('15:00');
});

test('admin sections remain usable with large text on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/admin/#/bookings');
  await page.evaluate(() => { document.documentElement.style.fontSize = '400%'; });
  for (const section of ['bookings', 'services', 'categories', 'settings']) {
    await page.goto(`/admin/#/${section}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('*')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(element => `${element.tagName}.${element.className}: ${Math.round(element.getBoundingClientRect().right)}`), boxes: ['html', 'body', '.admin-shell', '.admin-layout', '.admin-sidebar', '.admin-nav', '.admin-main'].map(selector => { const item = document.querySelector(selector)!; return `${selector}:${Math.round(item.getBoundingClientRect().width)}/${item.scrollWidth}/${getComputedStyle(item).overflowX}`; }) }));
    expect(overflow.scroll <= overflow.width, `${section}: ${JSON.stringify(overflow)}`).toBe(true);
  }
});

test('operator creates, updates the status, and deletes a request', async ({ page }) => {
  await page.goto('/admin/#/bookings');
  await page.getByRole('button', { name: '+ Новая запись' }).click();
  let editor = page.getByRole('dialog', { name: 'Новая запись' });
  await expect(editor.getByLabel('Услуга')).toBeFocused();
  await editor.getByLabel('Услуга').selectOption('oil');
  await editor.getByLabel('Дата').fill('2027-01-15');
  await editor.getByLabel('Время').fill('11:00');
  await editor.getByLabel('Имя клиента').fill('Ольга Операторская');
  await editor.getByLabel('Телефон').fill('89990001122');
  await editor.getByLabel('Автомобиль').fill('Хендай Солярис');
  await editor.getByRole('button', { name: 'Сохранить запись' }).click();
  await page.getByRole('button', { name: 'За всё время' }).click();
  let row = page.getByRole('row').filter({ hasText: 'Ольга Операторская' });
  await expect(row.getByText('Новая')).toBeVisible();
  await row.getByRole('button', { name: 'Открыть' }).click();
  editor = page.getByRole('dialog', { name: 'Редактирование записи' });
  await editor.getByLabel('Статус').selectOption('confirmed');
  await editor.getByRole('button', { name: 'Сохранить запись' }).click();
  row = page.getByRole('row').filter({ hasText: 'Ольга Операторская' });
  await expect(row.getByText('Подтверждена')).toBeVisible();
  await row.getByRole('button', { name: 'Открыть' }).click();
  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('dialog', { name: 'Редактирование записи' }).getByRole('button', { name: 'Удалить окончательно' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Ольга Операторская' })).toHaveCount(0);
});

test('a settings editor cannot overwrite a newer change from another tab', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto('/admin/#/settings');
  await second.goto('/admin/#/settings');
  await first.getByLabel('Начало работы').fill('10:00');
  await second.getByLabel('Начало работы').fill('11:00');
  await second.getByRole('button', { name: 'Сохранить график' }).click();
  await expect(second.getByText('Расписание сохранено.')).toBeVisible();
  await first.getByRole('button', { name: 'Сохранить график' }).click();
  await expect(first.getByText(/Данные изменились/)).toBeVisible();
  await second.reload();
  await expect(second.getByLabel('Начало работы')).toHaveValue('11:00');
});

test('booking dialog traps keyboard focus and closes on Escape', async ({ page }) => {
  await page.goto('/admin/#/bookings');
  await page.getByRole('button', { name: '+ Новая запись' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая запись' });
  await expect(dialog.getByLabel('Услуга')).toBeFocused();
  await dialog.getByRole('button', { name: 'Сохранить запись' }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Закрыть' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('double-clicking catalog save creates only one category', async ({ page }) => {
  await page.goto('/admin/#/categories');
  await page.getByRole('button', { name: '+ Добавить категорию' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая категория' });
  await dialog.getByLabel('Название').fill('Кузовные работы');
  await dialog.getByRole('button', { name: 'Сохранить категорию' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Кузовные работы' })).toHaveCount(1);
});

test('operator can edit a service without moving it from an archived category', async ({ page }) => {
  await page.goto('/admin/#/categories');
  await page.getByRole('button', { name: 'В архив' }).first().click();
  await page.getByRole('link', { name: 'Услуги' }).click();
  await page.getByRole('button', { name: 'Изменить' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Редактирование услуги' });
  await expect(dialog.getByLabel('Категория')).toHaveValue('general');
  await dialog.getByLabel('Название').fill('Диагностика авто');
  await dialog.getByRole('button', { name: 'Сохранить услугу' }).click();
  await expect(page.getByRole('heading', { name: 'Диагностика авто' })).toBeVisible();
});
