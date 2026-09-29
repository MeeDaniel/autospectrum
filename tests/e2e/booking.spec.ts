import { expect, test } from '@playwright/test';

// Keep the booking flow deterministic regardless of the local run time.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-12T05:00:00Z')); // 08:00 Moscow
});

test('date selection explains that a service is required first', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Сначала выберите услугу')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Выбрать дату и время' })).toBeDisabled();
  await page.getByLabel('Услуга').selectOption('diagnostics');
  await expect(page.getByText('Сначала выберите услугу')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Выбрать дату и время' })).toBeEnabled();
});

test('public hours follow the operator settings', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Часы: 09:00–18:00 (демо)')).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('autospectrum-demo', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      const objectStore = tx.objectStore('state');
      const get = objectStore.get('snapshot');
      get.onsuccess = () => {
        const snapshot = get.result;
        snapshot.settings = { ...snapshot.settings, workStart: 600, workEnd: 1020, breaks: [] };
        objectStore.put(snapshot, 'snapshot');
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(page.getByText('Часы: 10:00–17:00 (демо)')).toBeVisible();
});

test('public page refreshes after a second tab changes settings without BroadcastChannel', async ({ page, context }) => {
  await context.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined }); });
  await page.goto('/');
  await expect(page.getByText('Часы: 09:00–18:00 (демо)')).toBeVisible();
  const secondTab = await context.newPage();
  await secondTab.goto('/');
  await secondTab.evaluate(async () => {
    const { adminProvider } = await import('/src/data/demo.ts');
    const { settings } = await adminProvider.getSnapshot();
    await adminProvider.saveSettings({ ...settings, workStart: 600, workEnd: 1020, breaks: [] });
  });
  await expect(page.getByText('Часы: 10:00–17:00 (демо)')).toBeVisible();
});

test('a visitor reviews and submits a confirmed booking', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Услуга').selectOption('diagnostics');
  await expect(page.getByText('Итоговая цена зависит от автомобиля')).toBeVisible();
  await page.getByLabel('Ваше имя').fill('Иван');
  await page.getByLabel('Телефон').fill('89991234567');
  await page.getByLabel('Автомобиль').fill('Лада Гранта');
  await page.getByRole('button', { name: 'Выбрать дату и время' }).click();
  await expect(page).toHaveURL(/#\/date-time$/);
  await page.locator('.calendar-day:not([disabled])').first().click();
  await page.getByRole('button', { name: '10:00' }).click();
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page).toHaveURL(/#\/review$/);
  await expect(page.getByText('Лада Гранта')).toBeVisible();
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page).toHaveURL(/#\/result$/);
  await expect(page.getByText('Вы записаны')).toBeVisible();
  await page.getByRole('button', { name: 'ОК' }).click();
  await expect(page.getByLabel('Ваше имя')).toHaveValue('Иван');
  await expect(page.getByLabel('Автомобиль')).toHaveValue('Лада Гранта');
  await expect(page.getByLabel('Услуга')).toHaveValue('');
});

test('back, forward and refresh preserve an unfinished booking', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Услуга').selectOption('oil');
  await page.getByLabel('Ваше имя').fill('Пётр');
  await page.getByRole('button', { name: 'Выбрать дату и время' }).click();
  await page.goBack();
  await expect(page.getByLabel('Ваше имя')).toHaveValue('Пётр');
  await page.goForward();
  await expect(page).toHaveURL(/#\/date-time$/);
  await page.reload();
  await expect(page).toHaveURL(/#\/date-time$/);
  await expect(page.getByText('Замена масла')).toBeVisible();
});

test('a saved overloaded request shows a warning and keeps contact details', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Услуга').selectOption('diagnostics');
  await page.getByLabel('Ваше имя').fill('Анна');
  await page.getByLabel('Телефон').fill('89991112233');
  await page.getByLabel('Автомобиль').fill('Киа Рио');
  await page.getByRole('button', { name: 'Выбрать дату и время' }).click();
  await page.locator('.calendar-day:not([disabled])').first().click();
  await page.getByRole('button', { name: '11:30' }).click();
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await page.getByRole('button', { name: 'Далее' }).click();
  await page.evaluate(async () => {
    const draft = JSON.parse(sessionStorage.getItem('autospectrum.booking.draft')!);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('autospectrum-demo', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('state', 'readwrite');
      const objectStore = transaction.objectStore('state');
      const request = objectStore.get('snapshot');
      request.onsuccess = () => {
        const snapshot = request.result;
        for (let index = 0; index < 2; index++) snapshot.bookings.push({
          id: `competing-${index}`, serviceId: draft.serviceId, date: draft.date, startMinute: 690,
          durationMinutes: 30, name: 'Другой клиент', phone: '+79990000000', car: 'Автомобиль',
          comment: '', status: 'new', revision: 1,
        });
        objectStore.put(snapshot, 'snapshot');
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  });
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page).toHaveURL(/#\/result$/);
  await expect(page.getByText(/Заявка принята\. На это время много записей/)).toBeVisible();
  await expect(page.getByText('Вы записаны')).toHaveCount(0);
  await page.getByRole('button', { name: 'ОК' }).click();
  await expect(page.getByLabel('Ваше имя')).toHaveValue('Анна');
  await expect(page.getByLabel('Автомобиль')).toHaveValue('Киа Рио');
});

test('large text does not cause page overflow on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.getByLabel('Услуга')).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = '400%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('leaving the calendar without applying keeps the previous time', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Услуга').selectOption('diagnostics');
  await page.getByRole('button', { name: 'Выбрать дату и время' }).click();
  await page.locator('.calendar-day:not([disabled])').first().click();
  await page.getByRole('button', { name: '10:00' }).click();
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать дату и время' }).click();
  await page.getByRole('button', { name: '11:30' }).click();
  await page.getByRole('button', { name: /Назад к форме/ }).click();
  await expect(page.getByText('10:00')).toBeVisible();
});

test('the brand stays readable on a mobile header', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const brandLines = await page.locator('.brand-copy strong').evaluate((element) => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight);
  });
  expect(brandLines).toBeLessThan(1.3);
});

test('browser back after submission cannot send the same booking again', async ({ page }) => {
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
  await expect(page).toHaveURL(/#\/result$/);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Отправить' })).toHaveCount(0);
  await expect(page.getByText('Вы записаны')).toBeVisible();
});

test('a screen change moves keyboard focus to its heading', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Услуга').selectOption('diagnostics');
  await page.getByRole('button', { name: 'Выбрать дату и время' }).click();
  await expect(page.getByRole('heading', { name: 'Выберите дату и время' })).toBeFocused();
});

test('invalid submission focuses the first field to correct', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.getByLabel('Услуга')).toBeFocused();
});

test('calendar and review also reflow at 400 percent text', async ({ page }) => {
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/');
    await page.getByLabel('Услуга').selectOption('diagnostics');
    await page.getByLabel('Ваше имя').fill('Иван');
    await page.getByLabel('Телефон').fill('89991234567');
    await page.getByLabel('Автомобиль').fill('Лада');
    await page.evaluate(() => { document.documentElement.style.fontSize = '400%'; });
    await page.getByRole('button', { name: 'Выбрать дату и время' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `calendar at ${width}px`).toBe(true);
    await page.locator('.calendar-day:not([disabled])').first().click();
    await page.getByRole('button', { name: '10:00' }).click();
    await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
    await page.getByRole('button', { name: 'Далее' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `review at ${width}px`).toBe(true);
    await page.evaluate(() => sessionStorage.clear());
  }
});

test('a definite unavailable-time rejection stays editable', async ({ page }) => {
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
  await page.evaluate(() => {
    const draft = JSON.parse(sessionStorage.getItem('autospectrum.booking.draft')!);
    sessionStorage.setItem('autospectrum.booking.draft', JSON.stringify({ ...draft, time: '02:00' }));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page).toHaveURL(/#\/review$/);
  await expect(page.getByText('Время недоступно')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Выбрать другое время' })).toBeVisible();
});

test('invalid saved session data falls back to a usable empty form', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    sessionStorage.setItem('autospectrum.booking.draft', JSON.stringify({ date: 'not-a-date', name: null, car: [] }));
    sessionStorage.setItem('autospectrum.booking.result', JSON.stringify({ status: 'confirmed', serviceName: 'Диагностика', date: 'not-a-date', time: '10:00' }));
  });
  await page.goto('/#/result');
  await page.reload();
  await expect(page.getByLabel('Услуга')).toBeVisible();
  await expect(page.getByLabel('Ваше имя')).toHaveValue('');
});
