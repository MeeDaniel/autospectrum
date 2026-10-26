# Production readiness fixes — Implementation Plan
Spec: approved conversation plan of 2026-10-26, audit docs/reviews/2026-10-25-production-review.md in original checkout.
Goal: implement E1 E2 E4 E5 S1 S2 S4 S5 S8 S10 S11 S12.
Architecture: preserve Fastify/PostgreSQL/Preact/Vitest/Playwright; small focused modules for new responsibilities.
Global constraints: EXCLUDE E3 S3 S6 S7 S9. Preserve address, phone and hardcoded hours from commit a76b2af. Do not fix excluded bugs through incidental refactors. Existing roles become staff; explicit CLI promotion. Public window tomorrow through today+60 inclusive Moscow. Operators manage both roles, cannot self-block/self-demote or remove final active operator. Production beta text must describe real bookings. Development demo is not real. No destructive database operations outside isolated test DB. Do not push or merge.
Execution: use TDD for behavioral changes and real-boundary tests. Read AGENTS.md. No worker subagents. Workers own only task files; commit only their files after evidence. Changes outside worktree require no work. Reports in .superpowers/sdd/2026-10-26-production-readiness/task-N-report.md. Full npm test before completion; baseline integration skips and excluded E2E failures documented honestly. Root coordinates independent task file ownership.
Review Focus: concurrent reset/login; two simultaneous removals of final operators; cursor/filter stale responses; dirty Back/Forward; proxy re-resolution and real API tests.

### Task 1: E1 E4 E5 infrastructure
Files: server/app.ts and app.test.ts, new focused logging module/tests if needed, deploy/nginx.conf. No auth.ts edits. Task7 later modifies public 429.
- First write and run regression tests for distinct forwarded clients (same immediate nginx peer) receiving independent limits; same IP still limited; server exception logs safely.
- Use trustProxy:1, keep nginx overwriting X-Forwarded-For and no public API port.
- Enable structured Fastify logs with request id, method, route template, status/duration, safe server error data. Never log passwords/cookies/CSRF/body/query search values/SQL parameters; avoid raw pg detail or error messages carrying supplied personal values. Errors must remain diagnosable with code/name and sanitized stack frames.
- Nginx resolver 127.0.0.11 valid=5s ipv6=off; variable upstream address http://api:3000; proxy_pass without URI replacement. Preserve request URI/query and DOMAIN-only envsubst.
- Behavioral config validation may require Docker unavailable; do not replace runtime evidence with grep assertions. Task9 supplies real smoke harness.
- Tests: unit route limits/error log no secret disclosure; npm test. Commit and detailed RED/GREEN report.

### Task 2: E2 login/reset synchronization
Files: server/auth.ts, auth.test.ts, new dedicated server/auth-concurrency.integration.test.ts if helpful. Avoid app.ts.
- Add regression first reproducing login paused before session insertion and reset; real PG two orderings with deterministic barriers, not fixed sleeps.
- Login reads account SELECT ... FOR UPDATE and holds through password verification, session insertion and COMMIT.
- resetStaff/blockStaff use same account row locking (UPDATE already acquires row lock) and atomic session revocation. Preserve per-login/IP attempt limiter and consistent lock ordering.
- Real integration runs only on explicit isolated local database URL. Never mutate real user DB. Use test-owned fixtures and cleanup.
- Verify old-password session cannot survive completed reset; blocked account cannot use in-flight session; new password works. Run npm test, commit, report exact skip/run evidence.
- Task3 later extends account maintenance; communicate locking contract.

### Task 3: S1 staff/operator roles and management
Dependencies: Task1 and Task2 reviewed. Own auth/management server modules, new migration 003_staff_roles.sql, staff-cli.ts, app route registration, common role types, API auth types/client management, AdminApp/nav/section dispatch and new StaffSection. Avoid BookingsSection, public App and demo booking rules.
- New migration role TEXT NOT NULL DEFAULT 'staff', CHECK staff/operator. Existing accounts staff, old migrations unchanged.
- StaffPrincipal and login/me include role. Each request loads current account role from DB. Staff keeps bookings/services/categories/settings. Audit and staff management require operator, on server and UI.
- API GET /api/admin/staff -> [{id,login,role,blocked}]; POST {login,password,role}; PATCH /:id {role?,blocked?}; POST /:id/password {password}. Login immutable, no delete. List sorted login. Sensitive routes CSRF; unauthorized401 forbidden403 duplicate login/prohibited change409; validation422.
- Existing password policy remains. UI list/create/role/block/unblock/reset. Role field required for creation; CLI create defaults staff. Password never returned/logged/audited.
- Forbid changing own role/blocking self. Serialize account management with one transaction advisory lock; recheck initiating operator inside transaction, row-lock accounts in consistent order; final active operator invariant atomic. All changes and actor-attributed audit atomic.
- Role/password/block changes revoke sessions; unblock does not revive sessions. On401 clear client auth/CSRF and show login (without reload loops).
- CLI add role <login> <staff|operator> and unblock <login>; explicit first-operator promotion supported when none exists. Keep existing CLI commands compatible.
- Demo mode has no real authentication and should not pretend to manage real staff; show management requires server, test role features through production API.
- Regression tests first: migration default, endpoint forbidden including direct access, CRUD account actions, safe responses, session revoke, duplicate login and last-operator races. PG tests isolated. npm test and builds; commit/report.

### Task 4: S4 S10 whole-dataset filters and all-time default
Dependencies: Task3 to avoid app/API edits colliding. Files server/data.ts/app.ts, src/domain/admin.ts (shared filter type), src/data/api.ts/demo.ts, src/admin/sections/BookingsSection.tsx and relevant tests.
- listBookings and GET /api/admin/bookings extend filters query/categoryId/serviceId plus existing dates/status.
- PostgreSQL applies all filters BEFORE COUNT and cursor LIMIT using identical WHERE; category via service relation. Literal case-insensitive substring for trimmed query on name/phone/car; percent and underscore literal, fully parameterized. Preserve cursor ordering/date,start_minute,id desc.
- API and demo provider mirror interface, demo filters before pagination. On any server filter change reset cursor/history. Query debounce250ms; reject stale results from earlier filters/pages. Clear stale page UI as needed to avoid displaying mismatched results.
- Dates initially empty (all time); Today button retained. Preserve existing conflictsOnly behavior (S3 explicitly excluded); do not change conflict computation.
- Tests >100 rows with matches outside first50; category/service/date/status intersections, literals %,_, total, cursors without duplicate/omitted matches, initial all-time. Behavior tests first; npm test, commit/report.

### Task 5: S5 unsaved navigation guard
Dependencies: Task3. Files new admin navigation context/controller as needed, AdminApp.tsx, sections/common.tsx; existing editor callers keep behavior. New targeted e2e test file.
- Parent router owns transition acceptance BEFORE setSection/unmount. Editors register up-to-date dirty predicate through context.
- Sidebar links, Back/Forward, manual hash changes ask once; cancel keeps editor instance and draft, restores accepted URL with history.replaceState without another prompt.
- Keep beforeunload for refresh/close; existing modal close confirmations not duplicated. Saved editor clears dirty state.
- Test real Chrome settings and booking/service/category drafts; cancellation retains entered values, confirmation navigates, Back/Forward/manual hash, clean/saved no prompt.
- Tests first; use isolated test file/port coordinate with root (do not kill others' servers). npm test; commit/report.

### Task 6: S8 shared Moscow 60-day horizon
Dependencies: Task4 (same data/demo files). Files new src/domain/booking-window.ts + tests, server/data.ts/data.test.ts, src/data/demo.ts/demo.test.ts relevant tests.
- Shared pure function accepts now Date, returns startDate tomorrow and endDate today+60 inclusive in Europe/Moscow.
- Server and demo availability AND submit use same boundaries. Preserve schedule behavior, half-hour public step and existing overbooking policy. No S7 settings/header changes.
- Tests today rejected/tomorrow accepted/day60 accepted/day61 rejected; month/year transition, leap February, Moscow midnight and availability/submit consistency.
- Behavioral tests first npm test; commit/report.

### Task 7: S2 S12 beta copy and definite rate rejection
Dependencies Task1/3/4/6 (API/demo/app ownership). Own src/ui/App.tsx, src/data/api.ts, shared RateLimitError module/type if needed, server/app.ts public rate limiter and tests, focused new e2e test.
- Production label EXACT 'АВТОСПЕКТР · БЕТА-ВЕРСИЯ'. Confirmed copy EXACT 'Вы записаны. Заявка сохранена в автосервисе на выбранные дату и время.'
- Preserve overbooked meaning accepted/may move. Unknown copy gives real phone +7(921)070-11-99 and asks to clarify before resending; no not-yet-configured contacts.
- Local demo provider visibly test-only; never claim real booking for IndexedDB.
- Server429 emits Retry-After seconds until next slot (ceil min remaining bucket expiry, at least1).
- Typed RateLimitError retryAfterSeconds; API maps429; UI remains review editable with draft and same idempotency key, shows waiting period, no unknown result persisted, no automatic retries. Invalid/missing Retry-After fallback60 seconds. Retry enabled after countdown; editing/back remain possible. Network/ambiguous5xx retain unknown behavior.
- Regression tests provider mapping, UI429 then success same key no duplicate, texts production vsdemo, network unknown.
- npm test/build; commit/report.

### Task 8: S11 legacy admin redirect (small independent task)
Files src/main.tsx, src/ui/navigation.ts and navigation.test.ts (or focused helper/test). Do not edit App.tsx.
- Before public render, /#/admin and /#/admin/ -> location.replace('/admin/'); unknown hashes retain form behavior. Existing nginx /admin redirect untouched.
- Narrow behavior test route destination, normal unknown behavior; browser check direct/reload/back no loop if available.
- No extra path mappings or query behavior changes.
- npm test; commit/report.

### Task 9: integration harness, documentation, final acceptance
Dependencies all tasks reviewed. Files scripts, package.json only needed scripts (no unnecessary deps), dedicated production Playwright config/tests, dedicated compose test harness if needed, README and report.
- Real production build behind nginx/API/temporary PostgreSQL, dedicated compose project/volume/ports; never default to real DB. Migrate fixtures and create staff/operator through CLI. Automated explicit resource cleanup limited to test project.
- Test secure login both roles; forbidden audit/staff for staff; staff management; booking+idempotency; rate429; >50 filtered data; beta texts; dirty nav; legacy redirect; sixty-day range.
- Smoke dynamic DNS with ACTUALLY changed API IP, no web restart; forged client XFF overwritten. No pretending mock tests are PostgreSQL evidence.
- Provide runnable commands and honest blockers if docker cannot start. Do not start visible apps/services without need; hidden process launch on Windows. Integration scripts fail clearly when prerequisites absent, not green-skip.
- Update README role/bootstrap/CLI/logging/window/testing/deploy steps. Record excluded E3 S3 S6 S7 S9 and original baseline failures. Do not silence old E2E assertions just to green suite.
- Final npm test, both builds, all targeted browser tests; broad existing E2E once classify failures; dependency audit if registry available. New tests must pass; outstanding excluded failures explicitly report. Final whole-branch fresh review, resolve important findings, no merge/push without user request.

