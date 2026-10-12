#!/usr/bin/env bash
set -Eeuo pipefail

# Run from the project directory. Keep S3 credentials in a root-owned file outside Git.
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
backup_env="${BACKUP_ENV_FILE:-/etc/autospectrum/backup.env}"
if [[ ! -r "$backup_env" ]]; then
  echo "Backup configuration is unreadable: $backup_env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$backup_env"
set +a

: "${S3_BUCKET:?Set S3_BUCKET in backup.env}"
: "${S3_ENDPOINT_URL:?Set S3_ENDPOINT_URL in backup.env}"
: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID in backup.env}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY in backup.env}"
: "${AWS_DEFAULT_REGION:?Set AWS_DEFAULT_REGION in backup.env}"

prefix="${S3_PREFIX:-autospectrum}"
prefix="${prefix#/}"
prefix="${prefix%/}"
if [[ ! "$prefix" =~ ^[a-zA-Z0-9/_-]+$ ]]; then
  echo "S3_PREFIX may contain only letters, digits, /, _ and -" >&2
  exit 1
fi

aws_s3() { aws --endpoint-url "$S3_ENDPOINT_URL" "$@"; }
date_utc="$(date -u +%F)"
key="$prefix/autospectrum-$date_utc.dump"
archive="$(mktemp --suffix=.dump)"
verify_db="autospectrum_verify_$(date -u +%s)_$$"
verify_created=false

cleanup() {
  if [[ "$verify_created" == true ]]; then
    docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$1"' sh "$verify_db" >&2 || true
  fi
  rm -f -- "$archive"
}
trap cleanup EXIT

echo "Creating compressed PostgreSQL dump"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner --no-acl' > "$archive"
[[ -s "$archive" ]] || { echo "Dump is empty" >&2; exit 1; }

echo "Restoring dump into a temporary verification database"
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$verify_db"
verify_created=true
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --exit-on-error --no-owner --no-acl' sh "$verify_db" < "$archive"
table_count="$(docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$1" -tAc "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = '\''public'\''"' sh "$verify_db" | tr -d '[:space:]')"
if [[ ! "$table_count" =~ ^[0-9]+$ || "$table_count" -eq 0 ]]; then
  echo "Verification database contains no public tables" >&2
  exit 1
fi
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" "$1"' sh "$verify_db"
verify_created=false

echo "Uploading s3://$S3_BUCKET/$key"
aws_s3 s3 cp "$archive" "s3://$S3_BUCKET/$key" --only-show-errors
aws_s3 s3api head-object --bucket "$S3_BUCKET" --key "$key" >/dev/null

# One deterministic object per UTC day. Keep the newest seven daily copies.
listing="$(aws_s3 s3 ls "s3://$S3_BUCKET/$prefix/")"
mapfile -t old_keys < <(printf '%s\n' "$listing" | awk '{ print $4 }' | grep -E '^autospectrum-[0-9]{4}-[0-9]{2}-[0-9]{2}\.dump$' | sort -r | tail -n +8)
for old_name in "${old_keys[@]}"; do
  aws_s3 s3 rm "s3://$S3_BUCKET/$prefix/$old_name" --only-show-errors
done
echo "Backup uploaded and restore-verified; retained newest seven daily copies"
