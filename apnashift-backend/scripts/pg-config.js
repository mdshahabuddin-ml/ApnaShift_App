// Shared PG connection config for scripts — teeno Railway/local forms support:
//   (a) full postgres://user:pass@host:port/db → connectionString
//   (b) DATABASE_URL = host:port + PGUSER/PGPASSWORD/PGDATABASE (libpq vars)
//   (c) sirf PG* libpq vars (jaise `railway run --service Postgres` deta hai)
// pg.Client missing fields ko PG* env se khud bharta hai — isliye (b)/(c) me
// user/pass/db config me nahi dohraye. Returns config object, or null.
export function pgConfigFromEnv() {
  const dbUrl = (process.env.DATABASE_URL ?? '').trim();
  const pgEnv = () => {
    const user = process.env.PGUSER ?? process.env.POSTGRES_USER;
    const pass = process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD;
    const database = process.env.PGDATABASE ?? process.env.POSTGRES_DB;
    if (!user || !pass || !database) return null;
    return {};
  };
  if (/^[\w.-]+:\d+$/.test(dbUrl)) {
    const cfg = pgEnv();
    if (!cfg) return null;
    const [h, p] = dbUrl.split(':');
    return { ...cfg, host: h, port: Number(p) };
  }
  if (dbUrl) return { connectionString: dbUrl };
  return pgEnv();
}
