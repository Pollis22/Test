import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { env } from '../env.js';

if (!env.databaseUrl) {
  console.warn('[db] DATABASE_URL missing — server will fail on first query. Set it in .env');
}

export const pool = new pg.Pool({
  connectionString: env.databaseUrl ?? 'postgres://localhost:5432/prelo_booking',
  max: 10,
});

export const db = drizzle(pool, { schema });
export { schema };
