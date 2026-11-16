// One-off: copy vouchers from backup/render-export.json into Netlify DB.
// Usage: put NETLIFY_DB_URL in .env, then run: npm run import-backup
// Safe to re-run: vouchers whose code already exists are skipped.
import 'dotenv/config';
import fs from 'node:fs';
import { getDatabase } from '@netlify/database';
import { handleApi } from '../server/api.js';

const file = process.argv[2] || 'backup/render-export.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const { sql } = getDatabase();

// Make sure the tables exist (the API creates them on first use)
await handleApi(new Request('http://localhost/api/vouchers'));

let added = 0, skipped = 0, txAdded = 0;
for (const v of data.vouchers) {
  const rows = await sql`
    INSERT INTO vouchers (code, description, initial_cents, balance_cents, expires_at, created_at)
    VALUES (${v.code}, ${v.description}, ${v.initial_cents}::int, ${v.balance_cents}::int, ${v.expires_at}, ${v.created_at})
    ON CONFLICT (code) DO NOTHING
    RETURNING id`;
  if (!rows.length) { skipped++; continue; }
  added++;
  for (const t of data.voucher_transactions.filter(t => t.voucher_id === v.id)) {
    await sql`
      INSERT INTO voucher_transactions (voucher_id, amount_cents, balance_after_cents, note, salesperson, created_at)
      VALUES (${rows[0].id}::int, ${t.amount_cents}::int, ${t.balance_after_cents}::int, ${t.note}, ${t.salesperson ?? null}, ${t.created_at})`;
    txAdded++;
  }
}
console.log(`Imported ${added} voucher(s), ${txAdded} transaction(s). Skipped ${skipped} already present.`);
