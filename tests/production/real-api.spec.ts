import { randomUUID } from 'node:crypto';
import { expect, request as apiRequest, test, type APIRequestContext } from '@playwright/test';

const baseURL = process.env.SMOKE_BASE_URL;
const operatorLogin = process.env.SMOKE_OPERATOR_LOGIN;
const operatorPassword = process.env.SMOKE_OPERATOR_PASSWORD;
const staffLogin = process.env.SMOKE_STAFF_LOGIN;
const staffPassword = process.env.SMOKE_STAFF_PASSWORD;
if (!baseURL || !operatorLogin || !operatorPassword || !staffLogin || !staffPassword) {
  throw new Error('Production acceptance requires the isolated smoke runner and CLI-created accounts');
}

async function session(login: string, password: string) {
  const client = await apiRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
  const response = await client.post('/api/admin/login', { data: { login, password } });
  expect(response.status()).toBe(200);
  const body = await response.json() as { staff: { id: string; login: string; role: string }; csrfToken: string };
  expect(response.headers()['set-cookie']).toMatch(/HttpOnly; Secure; SameSite=Strict/);
  return { client, ...body };
}

async function operator() { return session(operatorLogin!, operatorPassword!); }

async function createCatalog(op: { client: APIRequestContext; csrfToken: string }) {
  const headers = { 'X-CSRF-Token': op.csrfToken };
  const categoryResponse = await op.client.post('/api/admin/categories/save', {
    headers, data: { input: { name: `Smoke category ${randomUUID()}`, lineCount: 2 } },
  });
  expect(categoryResponse.status()).toBe(200);
  const category = await categoryResponse.json() as { id: string };
  const serviceResponse = await op.client.post('/api/admin/services/save', {
    headers, data: { input: { categoryId: category.id, name: `Smoke service ${randomUUID()}`, priceFrom: 1000, durationMinutes: 30 } },
  });
  expect(serviceResponse.status()).toBe(200);
  return await serviceResponse.json() as { id: string; categoryId: string; durationMinutes: number };
}

function moscowWindow() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => Number(parts.find(item => item.type === type)!.value);
  const today = Date.UTC(value('year'), value('month') - 1, value('day'));
  const at = (days: number) => new Date(today + days * 86400000).toISOString().slice(0, 10);
  return { today: at(0), tomorrow: at(1), day60: at(60), day61: at(61) };
}

test('TLS session cookies enforce staff/operator roles and operator account management', async ({ page }) => {
  const staff = await session(staffLogin!, staffPassword!);
  expect(staff.staff.role).toBe('staff');
  expect((await staff.client.get('/api/admin/bookings')).status()).toBe(200);
  expect((await staff.client.get('/api/admin/audit')).status()).toBe(403);
  expect((await staff.client.get('/api/admin/staff')).status()).toBe(403);
  expect((await staff.client.post('/api/admin/staff', { headers: { 'X-CSRF-Token': staff.csrfToken }, data: { login: 'forbidden', password: 'some-password-123', role: 'operator' } })).status()).toBe(403);

  const op = await operator();
  expect(op.staff.role).toBe('operator');
  expect((await op.client.get('/api/admin/audit')).status()).toBe(200);
  const accountLogin = `smoke-${randomUUID().slice(0, 12)}`;
  const originalPassword = `Initial-${randomUUID()}`;
  const replacementPassword = `Changed-${randomUUID()}`;
  const headers = { 'X-CSRF-Token': op.csrfToken };
  const createdResponse = await op.client.post('/api/admin/staff', { headers, data: { login: accountLogin, password: originalPassword, role: 'staff' } });
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json() as { id: string; login: string; role: string; blocked: boolean };
  expect(created).toEqual({ id: expect.any(String), login: accountLogin, role: 'staff', blocked: false });
  expect(JSON.stringify(created)).not.toContain(originalPassword);
  expect((await op.client.get('/api/admin/staff')).status()).toBe(200);
  expect((await op.client.patch(`/api/admin/staff/${created.id}`, { headers, data: { role: 'operator' } })).status()).toBe(200);
  const promoted = await session(accountLogin, originalPassword);
  expect(promoted.staff.role).toBe('operator');
  expect((await op.client.post(`/api/admin/staff/${created.id}/password`, { headers, data: { password: replacementPassword } })).status()).toBe(204);
  expect((await promoted.client.get('/api/admin/me')).status()).toBe(401);
  const reset = await session(accountLogin, replacementPassword);
  expect((await op.client.patch(`/api/admin/staff/${created.id}`, { headers, data: { blocked: true } })).status()).toBe(200);
  expect((await reset.client.get('/api/admin/me')).status()).toBe(401);
  expect((await op.client.patch(`/api/admin/staff/${created.id}`, { headers, data: { blocked: false, role: 'staff' } })).status()).toBe(200);
  const restored = await session(accountLogin, replacementPassword);
  expect(restored.staff.role).toBe('staff');
  expect((await op.client.patch(`/api/admin/staff/${op.staff.id}`, { headers, data: { blocked: true } })).status()).toBe(409);
  await Promise.all([staff.client.dispose(), promoted.client.dispose(), reset.client.dispose(), restored.client.dispose(), op.client.dispose()]);

  await page.goto('/admin/#/bookings');
  await page.getByLabel('Логин').fill(staffLogin!);
  await page.getByLabel('Пароль').fill(staffPassword!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('link', { name: 'Записи' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Сотрудники' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Выйти' }).click();
  await page.getByLabel('Логин').fill(operatorLogin!);
  await page.getByLabel('Пароль').fill(operatorPassword!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('link', { name: 'Сотрудники' })).toBeVisible();
});

test('PostgreSQL filters find a matching booking beyond the first 50 rows', async () => {
  const op = await operator();
  const service = await createCatalog(op);
  const unique = `Needle-${randomUUID().slice(0, 10)}`;
  const makeBooking = (name: string, date: string) => ({ serviceId: service.id, date, startMinute: 600, durationMinutes: service.durationMinutes, name, phone: '+79990001122', car: 'Smoke car', comment: '', status: 'cancelled' });
  const headers = { 'X-CSRF-Token': op.csrfToken };
  const needle = await op.client.post('/api/admin/bookings/save', { headers, data: { input: makeBooking(unique, '2025-01-01'), allowConflicts: true } });
  expect(needle.status()).toBe(200);
  for (let index = 0; index < 55; index++) {
    const response = await op.client.post('/api/admin/bookings/save', { headers, data: { input: makeBooking(`Filler-${index}-${randomUUID().slice(0, 6)}`, '2025-01-02'), allowConflicts: true } });
    expect(response.status(), `seed booking ${index}: ${await response.text()}`).toBe(200);
  }
  const first = await (await op.client.get('/api/admin/bookings?limit=50')).json() as { bookings: Array<{ name: string }>; total: number; nextCursor: string | null };
  expect(first.total).toBeGreaterThan(50);
  expect(first.bookings).toHaveLength(50);
  expect(first.bookings.some(item => item.name === unique)).toBe(false);
  expect(first.nextCursor).toBeTruthy();
  const filtered = await (await op.client.get(`/api/admin/bookings?query=${encodeURIComponent(unique.toLowerCase())}&serviceId=${encodeURIComponent(service.id)}&categoryId=${encodeURIComponent(service.categoryId)}&status=cancelled&limit=50`)).json() as { bookings: Array<{ name: string }>; total: number; nextCursor: string | null };
  expect(filtered.total).toBe(1);
  expect(filtered.bookings.map(item => item.name)).toEqual([unique]);
  expect(filtered.nextCursor).toBeNull();
  await op.client.dispose();
});

test('public booking uses the Moscow 60-day window, persists once, and shows real beta confirmation', async ({ page, request }) => {
  const dates = moscowWindow();
  const op = await operator();
  const service = await createCatalog(op);
  await op.client.dispose();
  const services = await (await request.get('/api/services')).json() as Array<{ id: string }>;
  expect(services.some(item => item.id === service.id)).toBe(true);
  const serviceId = service.id;
  const availability = await (await request.get(`/api/availability?serviceId=${encodeURIComponent(serviceId)}&month=${dates.tomorrow.slice(0, 7)}`)).json() as { startDate: string; endDate: string; days: Array<{ date: string; times: string[] }> };
  expect(availability.startDate).toBe(dates.tomorrow);
  expect(availability.endDate).toBe(dates.day60);
  const day = availability.days.find(item => item.times.length > 0);
  expect(day, 'an open day in the first booking month').toBeTruthy();
  const draft = { serviceId, date: day!.date, time: day!.times[0], name: `Smoke client ${randomUUID().slice(0, 8)}`, phone: '+79990001234', car: 'Smoke car', comment: '' };
  const invalidToday = await request.post('/api/bookings', { headers: { 'Idempotency-Key': randomUUID() }, data: { ...draft, date: dates.today } });
  expect(invalidToday.status()).toBe(422);
  const invalidDay61 = await request.post('/api/bookings', { headers: { 'Idempotency-Key': randomUUID() }, data: { ...draft, date: dates.day61 } });
  expect(invalidDay61.status()).toBe(422);

  await page.addInitScript(value => sessionStorage.setItem('autospectrum.booking.draft', JSON.stringify(value)), draft);
  await page.goto('/#/review');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('АВТОСПЕКТР · БЕТА-ВЕРСИЯ')).toBeVisible();
  await expect(page.getByText('Вы записаны. Заявка сохранена в автосервисе на выбранные дату и время.')).toBeVisible();
  const submission = await page.evaluate(() => JSON.parse(sessionStorage.getItem('autospectrum-idempotency') || 'null') as { key: string });
  expect(submission.key).toBeTruthy();
  const repeated = await request.post('/api/bookings', { headers: { 'Idempotency-Key': submission.key }, data: draft });
  expect(repeated.status()).toBe(201);
  expect(await repeated.json()).toEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('autospectrum.booking.result') || 'null')));
  const conflict = await request.post('/api/bookings', { headers: { 'Idempotency-Key': submission.key }, data: { ...draft, car: 'Different car' } });
  expect(conflict.status()).toBe(409);
  const checkingOperator = await operator();
  const matching = await (await checkingOperator.client.get(`/api/admin/bookings?query=${encodeURIComponent(draft.name)}`)).json() as { total: number; bookings: Array<{ name: string }> };
  expect(matching.total).toBe(1);
  expect(matching.bookings.map(item => item.name)).toEqual([draft.name]);
  await checkingOperator.client.dispose();
});

test('production nginx redirects legacy admin URL and preserves a dirty admin draft on cancelled navigation', async ({ page }) => {
  await page.goto('/#/admin');
  await expect(page).toHaveURL(/\/admin\/$/);
  await page.getByLabel('Логин').fill(operatorLogin!);
  await page.getByLabel('Пароль').fill(operatorPassword!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.goto('/admin/#/services');
  await page.getByRole('button', { name: '+ Добавить услугу' }).click();
  const editor = page.getByRole('dialog', { name: 'Новая услуга' });
  await editor.getByLabel('Название').fill('Unsaved production draft');
  let prompts = 0;
  page.on('dialog', dialog => { prompts++; void dialog.dismiss(); });
  await page.getByRole('link', { name: 'Категории' }).evaluate(element => (element as HTMLAnchorElement).click());
  await expect.poll(() => prompts).toBe(1);
  await expect(editor.getByLabel('Название')).toHaveValue('Unsaved production draft');
  await expect(page).toHaveURL(/#\/services$/);
});

test('real API returns 429 with Retry-After for a single client despite forged XFF values', async ({ request }) => {
  let limited: { status: number; retryAfter?: string } | null = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    const response = await request.post('/api/bookings', {
      headers: { 'Idempotency-Key': randomUUID(), 'X-Forwarded-For': `198.51.100.${attempt + 1}` },
      data: { serviceId: 'missing', date: '2026-01-01', time: '10:00', name: 'Invalid', phone: '+79990000000', car: 'Car', comment: '' },
    });
    if (response.status() === 429) { limited = { status: response.status(), retryAfter: response.headers()['retry-after'] }; break; }
    expect(response.status()).toBe(422);
  }
  expect(limited?.status).toBe(429);
  expect(Number(limited?.retryAfter)).toBeGreaterThanOrEqual(1);
});
