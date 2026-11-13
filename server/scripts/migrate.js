import pg from 'pg';
import { migrate } from '../src/migrate.js';

const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL });
try {
  await migrate(pool);
  console.log('Database schema ready.');
} finally {
  await pool.end();
}
