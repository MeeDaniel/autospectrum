import { expect, test } from '@playwright/test';

const settings = { workStart: 540, workEnd: 1080, breaks: [], revision: 1 };
const booking = (id: string, name: string) => ({ id, serviceId: 'svc', date: '2026-10-01', startMinute: 600, durationMinutes: 30, name, phone: '+79990000000', car: 'Car', comment: '', status: 'new', revision: 1 });
const snapshot = {
  categories: [{ id: 'cat', name: 'Category', lineCount: 2, archived: false, revision: 1 }],
  services: [{ id: 'svc', categoryId: 'cat', name: 'Service', priceFrom: 100, durationMinutes: 30, archived: false, revision: 1 }],
  bookings: [], settings,
};
const pageOf = (rows: ReturnType<typeof booking>[], nextCursor: string | null = null) => ({ bookings: rows, total: rows.length, nextCursor, conflicts: {} });

test('booking dates start empty so the initial request covers all time', async ({ page }) => {
  const requests: URL[] = [];
  await page.route('**/api/admin/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/admin/me') return route.fulfill({ json: { staff: { id: 'operator', login: 'desk', role: 'operator' }, csrfToken: 'token' } });
    if (url.pathname === '/api/admin/snapshot') return route.fulfill({ json: snapshot });
    if (url.pathname === '/api/admin/bookings') { requests.push(url); return route.fulfill({ json: pageOf([booking('past', 'Past booking')]) }); }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/admin/#/bookings');
  await expect(page.getByText('Past booking')).toBeVisible();
  await expect(page.getByLabel('С даты')).toHaveValue('');
  await expect(page.getByLabel('По дату')).toHaveValue('');
  expect(requests[0].searchParams.has('from')).toBe(false);
  expect(requests[0].searchParams.has('to')).toBe(false);
});

test('repeating All time keeps the loaded first page visible', async ({ page }) => {
  await page.route('**/api/admin/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/admin/me') return route.fulfill({ json: { staff: { id: 'operator', login: 'desk', role: 'operator' }, csrfToken: 'token' } });
    if (url.pathname === '/api/admin/snapshot') return route.fulfill({ json: snapshot });
    if (url.pathname === '/api/admin/bookings') return route.fulfill({ json: pageOf([booking('past', 'Past booking')]) });
    return route.fulfill({ status: 404 });
  });
  await page.goto('/admin/#/bookings');
  await expect(page.getByText('Past booking')).toBeVisible();
  await page.getByRole('button', { name: 'За всё время' }).click();
  await expect(page.getByText('Past booking')).toBeVisible();
  await expect(page.getByText('Загружаем записи…')).toHaveCount(0);
});

test('repeating Today keeps the loaded first page visible', async ({ page }) => {
  await page.route('**/api/admin/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/admin/me') return route.fulfill({ json: { staff: { id: 'operator', login: 'desk', role: 'operator' }, csrfToken: 'token' } });
    if (url.pathname === '/api/admin/snapshot') return route.fulfill({ json: snapshot });
    if (url.pathname === '/api/admin/bookings') return route.fulfill({ json: pageOf([booking('today', 'Today booking')]) });
    return route.fulfill({ status: 404 });
  });
  await page.goto('/admin/#/bookings');
  await expect(page.getByText('Today booking')).toBeVisible();
  await page.getByRole('button', { name: 'Сегодня' }).click();
  await expect(page.getByLabel('С даты')).not.toHaveValue('');
  await expect(page.getByText('Today booking')).toBeVisible();
  await page.getByRole('button', { name: 'Сегодня' }).click();
  await expect(page.getByText('Today booking')).toBeVisible();
  await expect(page.getByText('Загружаем записи…')).toHaveCount(0);
});

test('shows a booking page in the order returned by the server cursor', async ({ page }) => {
  await page.route('**/api/admin/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/admin/me') return route.fulfill({ json: { staff: { id: 'operator', login: 'desk', role: 'operator' }, csrfToken: 'token' } });
    if (url.pathname === '/api/admin/snapshot') return route.fulfill({ json: snapshot });
    if (url.pathname === '/api/admin/bookings') return route.fulfill({ json: pageOf([
      { ...booking('late', 'Late booking'), startMinute: 900 },
      { ...booking('early', 'Early booking'), startMinute: 600 },
    ]) });
    return route.fulfill({ status: 404 });
  });
  await page.goto('/admin/#/bookings');
  await expect(page.getByText('Late booking')).toBeVisible();
  const names = await page.locator('.admin-table tbody tr td:nth-child(2) strong').allTextContents();
  expect(names).toEqual(['Late booking', 'Early booking']);
});

test('search is debounced, resets pagination and ignores the old page response', async ({ page }) => {
  let releaseOldPage: (() => void) | undefined;
  const oldPageGate = new Promise<void>(resolve => { releaseOldPage = resolve; });
  const requests: URL[] = [];
  await page.route('**/api/admin/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/admin/me') return route.fulfill({ json: { staff: { id: 'operator', login: 'desk', role: 'operator' }, csrfToken: 'token' } });
    if (url.pathname === '/api/admin/snapshot') return route.fulfill({ json: snapshot });
    if (url.pathname === '/api/admin/bookings') {
      requests.push(url);
      if (url.searchParams.get('query') === 'needle') return route.fulfill({ json: pageOf([booking('match', 'Needle booking')]) });
      if (url.searchParams.get('cursor') === 'old-next') { await oldPageGate; return route.fulfill({ json: pageOf([booking('old-page', 'Old page booking')]) }); }
      return route.fulfill({ json: pageOf([booking('first', 'First booking')], 'old-next') });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/admin/#/bookings');
  await expect(page.getByText('First booking')).toBeVisible();
  await page.getByRole('button', { name: 'Далее →' }).click();
  await expect.poll(() => requests.some(url => url.searchParams.get('cursor') === 'old-next')).toBe(true);
  await page.getByLabel('Поиск').fill('needle');
  await expect(page.getByText('First booking')).toHaveCount(0);
  await expect.poll(() => requests.some(url => url.searchParams.get('query') === 'needle')).toBe(true);
  const filteredRequest = requests.find(url => url.searchParams.get('query') === 'needle')!;
  expect(filteredRequest.searchParams.has('cursor')).toBe(false);
  await expect(page.getByText('Needle booking')).toBeVisible();
  releaseOldPage!();
  await expect(page.getByText('Needle booking')).toBeVisible();
  await expect(page.getByText('Old page booking')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '← Назад' })).toBeDisabled();
});
