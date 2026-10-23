#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "Usage: $0 [--verify-only | --apply] <s3://bucket/prefix/autospectrum-YYYY-MM-DD.dump | local.dump>" >&2
  exit 2
}
[[ $# -eq 2 ]] || usage
mode="$1"
source_file="$2"
[[ "$mode" == --verify-only || "$mode" == --apply ]] || usage

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
archive="$(mktemp --suffix=.dump)"
verify_db="autospectrum_verify_$(date -u +%s)_$$"
verify_created=false
api_stopped=false

cleanup() {
  if [[ "$verify_created" == true ]]; then
    docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$1"' sh "$verify_db" >&2 || true
  fi
  if [[ "$api_stopped" == true ]]; then
    docker compose start api >&2 || true
  fi
  rm -f -- "$archive"
}
trap cleanup EXIT

if [[ "$source_file" == s3://* ]]; then
  backup_env="${BACKUP_ENV_FILE:-/etc/autospectrum/backup.env}"
  [[ -r "$backup_env" ]] || { echo "Backup configuration is unreadable: $backup_env" >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090
  source "$backup_env"
  set +a
  : "${S3_ENDPOINT_URL:?Set S3_ENDPOINT_URL in backup.env}"
  aws --endpoint-url "$S3_ENDPOINT_URL" s3 cp "$source_file" "$archive" --only-show-errors
else
  cp -- "$source_file" "$archive"
fi
[[ -s "$archive" ]] || { echo "Dump is empty" >&2; exit 1; }

echo "Verifying by restoring into a temporary database"
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$verify_db"
verify_created=true
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --exit-on-error --no-owner --no-acl' sh "$verify_db" < "$archive"
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$1" -tAc "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = '\''public'\''"' sh "$verify_db" | grep -Eq '[1-9][0-9]*'
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" "$1"' sh "$verify_db"
verify_created=false

if [[ "$mode" == --verify-only ]]; then
  echo "Restore verification passed"
  exit 0
fi

echo "Stopping API and replacing the production database"
docker compose stop api
api_stopped=true
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error --no-owner --no-acl' < "$archive"
docker compose start api
api_stopped=false
echo "Database restored; check /api/readyz before reopening traffic"
