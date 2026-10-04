// MS SQL Server connection config — env only, never hard-coded.
// No defaults for user/password (refuse to connect without them).
export function isMssqlConfigured() {
  return !!(process.env.MSSQL_USER && process.env.MSSQL_PASSWORD);
}

export function mssqlConfig() {
  if (!isMssqlConfigured()) {
    throw new Error('MSSQL_USER / MSSQL_PASSWORD khaali hai — .env me set karo.');
  }
  // Static TCP port wins over instance name (no SQL Browser needed).
  const portRaw = process.env.MSSQL_PORT ?? '';
  const port = portRaw === '' ? undefined : Number(portRaw);
  return {
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    server: process.env.MSSQL_SERVER ?? 'localhost',
    ...(port ? { port } : {}),
    database: process.env.MSSQL_DATABASE ?? 'ApnaShift',
    options: {
      instanceName: port ? undefined : process.env.MSSQL_INSTANCE || undefined,
      encrypt: (process.env.MSSQL_ENCRYPT ?? 'false') === 'true',
      trustServerCertificate: true,
      connectTimeout: 8000,
      requestTimeout: 30000,
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  };
}

// Safe summary for health output (no secrets — names only).
export function mssqlTarget() {
  const server = process.env.MSSQL_SERVER ?? 'localhost';
  const instance = process.env.MSSQL_INSTANCE ?? '';
  return {
    server: instance ? `${server}\\${instance}` : server,
    database: process.env.MSSQL_DATABASE ?? 'ApnaShift',
  };
}
