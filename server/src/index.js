import pg from 'pg';
import { createServer } from './server.js';
import { migrate } from './migrate.js';
import { signingKey } from './signing-key.js';

const { DATABASE_URL, BOOTSTRAP_TOKEN, POWERSYNC_URL } = process.env;
if (!DATABASE_URL || !BOOTSTRAP_TOKEN || !POWERSYNC_URL) {
  throw new Error('Set DATABASE_URL, BOOTSTRAP_TOKEN, and POWERSYNC_URL');
}

const privateJwk = await signingKey();
const pool = new pg.Pool({ connectionString: DATABASE_URL });
if (process.env.RUN_MIGRATIONS === 'true') {
  await migrate(pool);
}
const server = await createServer({
  pool,
  bootstrapToken: BOOTSTRAP_TOKEN,
  privateJwk,
  powersyncUrl: POWERSYNC_URL,
  issuer: process.env.API_ORIGIN || 'http://localhost:8080',
  webDist: process.env.WEB_DIST,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)
});
server.listen(Number(process.env.PORT || 8080), process.env.HOST || '0.0.0.0', () => {
  console.log(`PowerBin backend listening on port ${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => pool.end()));
}
