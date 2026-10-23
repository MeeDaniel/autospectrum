# АвтоСпектр

Запись в автосервис: публичная форма на `/`, панель оператора на `/admin/`, API на `/api/`. Фронтенд собирается из двух отдельных входов Vite. Рабочие данные хранятся в PostgreSQL; сервер проверяет расписание и права доступа.

## Локальная разработка

```bash
npm ci
npm run dev
npm test
npm run build
npm run server:build
```

Команда `npm run test:e2e` запускает браузерные тесты; для неё нужен Google Chrome. Серверные команды и переменные окружения находятся в `package.json` и `.env.example`.

## Развёртывание на одном VPS

Нужны Linux VPS с Docker Engine и Compose plugin, домен с A/AAAA записью на VPS, открытые TCP 80/443, Certbot и внешний S3-совместимый бакет. PostgreSQL и API находятся только во внутренней сети Docker; наружу опубликованы лишь порты Nginx. Docker volume `postgres_data` хранит базу между обновлениями контейнеров. Не используйте `docker compose down -v` на рабочем сервере.

Сборку образов лучше выполнять в CI или на рабочей машине: на небольшом VPS достаточно скачать образы. Для Linux/amd64:

```bash
docker buildx build --platform linux/amd64 --target api -t ghcr.io/your-org/autospectrum-api:<git-sha> --push .
docker buildx build --platform linux/amd64 --target web -t ghcr.io/your-org/autospectrum-web:<git-sha> --push .
```

Замените `linux/amd64` на `linux/arm64` для ARM VPS. В `WEB_IMAGE` и `API_IMAGE` используйте опубликованные неизменяемые теги или digest. Если сборка на VPS допустима, используйте `docker compose up -d --build` вместо загрузки образов.

На сервере разместите проект, например в `/opt/autospectrum`, и создайте конфигурацию:

```bash
cd /opt/autospectrum
cp .env.example .env
chmod 600 .env
```

Укажите настоящий `DOMAIN`, уникальный `POSTGRES_PASSWORD`, одинаковый пароль в `POSTGRES_PASSWORD` и `DATABASE_URL`, и опубликованные образы. Если пароль содержит спецсимволы URI, закодируйте их в `DATABASE_URL`. Файл `.env` не добавляйте в Git. Доступ к `.env`, `/etc/letsencrypt` и резервным копиям ограничьте администратором VPS.

### Первый TLS-сертификат

Сначала выпустите сертификат через HTTP webroot. Временный Nginx обслуживает только проверочный каталог Certbot на порту 80. Он должен быть свободен; после выпуска временный контейнер удаляется. Подставьте свой домен и email:

```bash
cd /opt/autospectrum
mkdir -p certbot
docker run --rm -d --name autospectrum-acme -p 80:80 -v "$PWD/certbot:/usr/share/nginx/html:ro" nginx:stable-alpine
sudo certbot certonly --webroot -w "$PWD/certbot" -d example.com --email operator@example.com --agree-tos --no-eff-email
docker stop autospectrum-acme
```

Проверьте, что сертификат появился в `/etc/letsencrypt/live/<DOMAIN>/`. Nginx в Compose монтирует `/etc/letsencrypt` только для чтения и берёт сертификат оттуда. Запустите стек:

```bash
docker compose config --quiet
docker compose pull
docker compose up -d --no-build
docker compose ps
curl -fsS https://example.com/healthz
curl -fsS https://example.com/api/readyz
```

Compose ждёт `pg_isready`, выполняет миграции как одноразовый сервис, ждёт готовности API и лишь затем запускает Nginx. При обновлении тегов образов повторите `docker compose pull && docker compose up -d --no-build` и проверьте `/api/readyz`. Для ограниченной памяти убедитесь, что на диске есть свободное место для временной проверочной базы при резервном копировании.

Создайте первую учётную запись оператора. `read -s` скрывает ввод пароля; CLI получает его через stdin:

```bash
read -r -s -p 'Пароль оператора: ' staff_password; printf '\n'
printf '%s\n' "$staff_password" | docker compose exec -T api node --import tsx server/staff-cli.ts create operator
unset staff_password
```

Для смены пароля используйте `reset <login>` вместо `create <login>` с тем же вводом через stdin. Для блокировки пароль не требуется: `docker compose exec api node --import tsx server/staff-cli.ts block <login>`.

Certbot, установленный из пакета, обычно запускает `renew` по системному таймеру. Добавьте deploy hook, чтобы Nginx перечитывал обновлённый сертификат:

```bash
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' 'cd /opt/autospectrum && /usr/bin/docker compose exec -T web nginx -s reload' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/autospectrum-reload.sh >/dev/null
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/autospectrum-reload.sh
sudo certbot renew --dry-run --run-deploy-hooks
```

На системе без таймера Certbot добавьте ежедневный `certbot renew -q` в root crontab. HTTP Nginx постоянно отдаёт `/.well-known/acme-challenge/` из `certbot/`, поэтому продление не требует отключать сайт.

### Ежедневные внешние копии

На VPS установите AWS CLI v2 и создайте защищённый файл `/etc/autospectrum/backup.env` (mode `600`, владелец root):

```bash
S3_BUCKET=your-external-bucket
S3_PREFIX=autospectrum
S3_ENDPOINT_URL=https://s3.example.invalid
AWS_DEFAULT_REGION=your-region
AWS_ACCESS_KEY_ID=replace-me
AWS_SECRET_ACCESS_KEY=replace-me
```

Используйте отдельный бакет или префикс и учётную запись с правами чтения, записи, удаления и listing только этого префикса. Включите шифрование бакета. Файл содержит shell-переменные: значения с пробелами или символами shell заключайте в одинарные кавычки. Эти данные не должны попадать в Git, журнал команд или `.env.example`.

`deploy/backup.sh` делает сжатый `pg_dump` custom format, восстанавливает его во временную базу и проверяет наличие таблиц. Только после успешной проверки он загружает файл в S3 и оставляет семь последних дневных копий. Ручная проверка:

```bash
cd /opt/autospectrum
sudo bash deploy/backup.sh
```

Добавьте в root crontab (`sudo crontab -e`) ежедневный запуск по UTC/времени сервера и следите за кодом выхода и журналом:

```cron
15 2 * * * /bin/bash /opt/autospectrum/deploy/backup.sh >> /var/log/autospectrum-backup.log 2>&1
```

Создайте мониторинг ошибки cron или отсутствия нового объекта в бакете. Скрипт удаляет старые объекты только после успешной загрузки. Для сохранения истории дольше семи дней настройте отдельную политику хранения на стороне бакета.

### Проверка и восстановление

Проверьте конкретную копию без изменения рабочей базы:

```bash
cd /opt/autospectrum
sudo bash deploy/restore.sh --verify-only s3://your-external-bucket/autospectrum/autospectrum-YYYY-MM-DD.dump
```

`--apply` сначала проверяет восстановление во временную базу, затем останавливает API, удаляет и создаёт рабочую базу, загружает дамп и запускает API. Это операция для окна обслуживания: текущие данные будут заменены выбранной копией. Перед ней сохраните свежую копию текущего состояния и убедитесь, что выбран правильный объект:

```bash
sudo bash deploy/restore.sh --apply s3://your-external-bucket/autospectrum/autospectrum-YYYY-MM-DD.dump
curl -fsS https://example.com/api/readyz
```

Можно указать локальный `.dump` вместо S3 URI. При ошибке восстановления скрипт запускает API обратно, но оператору нужно проверить состояние базы и журналы `docker compose logs db api`. Для полноценной проверки восстановления проводите учения на отдельном VPS с копией этих образов и конфигурации.

## Интерфейс и данные

Клиентская форма и панель оператора используют hash-маршруты. Черновик формы хранится в `sessionStorage` текущей вкладки. Сервер выдаёт окончательный статус записи после повторной проверки свободного времени. Админ-действия требуют авторизации на API; доступность статического `/admin/` сама по себе не даёт прав на чтение или изменение данных.
