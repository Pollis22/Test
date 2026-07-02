// Boot migrator: applies journal-registered .sql files exactly once, in order.
// Journal: server/migrations/meta/_journal.json ; files live at repo root.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  // dist/db/ or src/db/ → server/ → repo root
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'booking-schema-v1.sql'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('migrate: repo root (booking-schema-v1.sql) not found from ' + here);
}

interface JournalEntry {
  idx: number;
  tag: string;
  file: string;
}

export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  const root = repoRoot();
  const journalPath = path.join(root, 'server', 'migrations', 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
      const seen = await client.query('SELECT 1 FROM _migrations WHERE tag = $1', [entry.tag]);
      if (seen.rowCount) continue;
      const sqlText = readFileSync(path.join(root, entry.file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO _migrations (tag) VALUES ($1)', [entry.tag]);
        await client.query('COMMIT');
        applied.push(entry.tag);
        console.log(`[migrate] applied ${entry.tag}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`[migrate] ${entry.tag} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
  return applied;
}
