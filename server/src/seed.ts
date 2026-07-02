// Seed: shop "Demo Cuts" + owner + 2 staff + 4 services + Mon–Sat availability.
// Idempotent — safe to re-run. Applies migrations first.
import bcrypt from 'bcrypt';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';

const OWNER_EMAIL = 'pollis@jiemastery.ai';
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? 'demo-owner-pass';

async function main() {
  await runMigrations(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    const shopRes = await c.query(
      `INSERT INTO shops (slug, name, timezone, currency, subscription_tier)
       VALUES ('demo-cuts', 'Demo Cuts', 'America/Chicago', 'usd', 'enterprise')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    );
    const shopId = shopRes.rows[0].id as string;

    const hash = bcrypt.hashSync(OWNER_PASSWORD, 10); // $2b$10 (house rule)
    await c.query(
      `INSERT INTO users (shop_id, email, password_hash, role, is_admin)
       VALUES ($1, $2, $3, 'owner', true)
       ON CONFLICT (shop_id, email) DO UPDATE SET role = 'owner', is_admin = true`,
      [shopId, OWNER_EMAIL, hash],
    );

    const staffDefs = [
      { name: 'Marcus Reed', email: 'marcus@democuts.example', color: '#06B6D4' },
      { name: 'Jada Coleman', email: 'jada@democuts.example', color: '#0B2545' },
    ];
    const staffIds: string[] = [];
    for (const s of staffDefs) {
      const existing = await c.query(
        `SELECT id FROM staff WHERE shop_id = $1 AND display_name = $2`,
        [shopId, s.name],
      );
      if (existing.rowCount) {
        staffIds.push(existing.rows[0].id);
        continue;
      }
      const r = await c.query(
        `INSERT INTO staff (shop_id, display_name, email, color) VALUES ($1,$2,$3,$4) RETURNING id`,
        [shopId, s.name, s.email, s.color],
      );
      staffIds.push(r.rows[0].id);
    }

    const serviceDefs = [
      { name: 'Haircut', duration: 30, price: 3500 },
      { name: 'Fade', duration: 45, price: 4500 },
      { name: 'Beard Trim', duration: 20, price: 2000 },
      { name: 'Color', duration: 90, price: 12000 },
    ];
    const serviceIds: string[] = [];
    for (const s of serviceDefs) {
      const existing = await c.query(`SELECT id FROM services WHERE shop_id = $1 AND name = $2`, [
        shopId,
        s.name,
      ]);
      if (existing.rowCount) {
        serviceIds.push(existing.rows[0].id);
        continue;
      }
      const r = await c.query(
        `INSERT INTO services (shop_id, name, duration_min, price_cents) VALUES ($1,$2,$3,$4) RETURNING id`,
        [shopId, s.name, s.duration, s.price],
      );
      serviceIds.push(r.rows[0].id);
    }

    for (const staffId of staffIds) {
      for (const serviceId of serviceIds) {
        await c.query(
          `INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [staffId, serviceId],
        );
      }
      // Mon(1)–Sat(6), 9:00–18:00
      for (let weekday = 1; weekday <= 6; weekday++) {
        const existing = await c.query(
          `SELECT 1 FROM availability_rules WHERE staff_id = $1 AND weekday = $2`,
          [staffId, weekday],
        );
        if (existing.rowCount) continue;
        await c.query(
          `INSERT INTO availability_rules (staff_id, weekday, start_time, end_time)
           VALUES ($1, $2, '09:00', '18:00')`,
          [staffId, weekday],
        );
      }
    }

    await c.query(
      `INSERT INTO event_log (shop_id, actor, action, entity, meta)
       VALUES ($1::uuid, 'system', 'seed', 'shop:' || $1::text, '{"script":"seed.ts"}')`,
      [shopId],
    );
    await c.query('COMMIT');
    console.log(`[seed] Demo Cuts ready (shop ${shopId}); owner ${OWNER_EMAIL}`);
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
