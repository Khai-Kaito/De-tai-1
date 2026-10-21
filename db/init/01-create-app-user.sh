#!/bin/sh
set -eu

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$LIBRARY_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE library_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'library_app')
\gexec
ALTER ROLE library_app WITH PASSWORD :'app_password';
GRANT CONNECT ON DATABASE library TO library_app;
GRANT USAGE, CREATE ON SCHEMA public TO library_app;
SQL
