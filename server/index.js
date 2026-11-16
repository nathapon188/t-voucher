import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS vouchers (
    id             SERIAL PRIMARY KEY,
    code           TEXT UNIQUE NOT NULL,
    description    TEXT,
    initial_cents  INTEGER NOT NULL CHECK (initial_cents > 0),
    balance_cents  INTEGER NOT NULL CHECK (balance_cents >= 0),
    expires_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS voucher_transactions (
    id                   SERIAL PRIMARY KEY,
    voucher_id           INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
    balance_after_cents  INTEGER NOT NULL,
    note                 TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS voucher_transactions_voucher_id_idx ON voucher_transactions (voucher_id);
`);

const app = express();
app.use(express.json());

// Unambiguous characters (no 0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => {
  const pick = () => ALPHABET[crypto.randomInt(ALPHABET.length)];
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `${part()}-${part()}`;
};
const toCents = v => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 100000 ? Math.round(n * 100) : null;
};
const isExpired = v => v.expires_at && new Date(v.expires_at) <= new Date();

const view = v => ({
  id: v.id,
  code: v.code,
  description: v.description,
  initial: v.initial_cents / 100,
  balance: v.balance_cents / 100,
  expiresAt: v.expires_at,
  createdAt: v.created_at,
  status: isExpired(v) ? 'expired' : v.balance_cents === 0 ? 'used' : 'active'
});
const txView = t => ({
  id: t.id,
  amount: t.amount_cents / 100,
  balanceAfter: t.balance_after_cents / 100,
  note: t.note,
  createdAt: t.created_at
});

// List vouchers (optional ?q= search on code or description)
app.get('/api/vouchers', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const { rows } = q
    ? await pool.query(
        `SELECT * FROM vouchers WHERE code ILIKE $1 OR description ILIKE $1 ORDER BY created_at DESC LIMIT 200`,
        [`%${q}%`]
      )
    : await pool.query('SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 200');
  res.json(rows.map(view));
});

// Add a voucher
app.post('/api/vouchers', async (req, res) => {
  const cents = toCents(req.body.value);
  if (!cents) return res.status(400).json({ error: 'Enter a value between $0.01 and $100,000.' });
  const description = (req.body.description || '').toString().trim().slice(0, 200) || null;
  const expiresAt = req.body.expiresAt ? new Date(`${req.body.expiresAt}T23:59:59`) : null;
  if (expiresAt && (isNaN(expiresAt) || expiresAt <= new Date())) {
    return res.status(400).json({ error: 'Expiry date must be in the future.' });
  }
  // Optional voucher number entered by the user; otherwise one is generated
  const customCode = (req.body.code || '').toString().trim().toUpperCase();
  if (customCode && !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(customCode)) {
    return res.status(400).json({ error: 'Voucher no. can only use letters, numbers and dashes (max 40 characters).' });
  }
  if (customCode) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO vouchers (code, description, initial_cents, balance_cents, expires_at)
         VALUES ($1, $2, $3, $3, $4) RETURNING *`,
        [customCode, description, cents, expiresAt]
      );
      return res.status(201).json(view(rows[0]));
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: `Voucher no. ${customCode} already exists.` });
      throw e;
    }
  }
  for (let i = 0; i < 5; i++) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO vouchers (code, description, initial_cents, balance_cents, expires_at)
         VALUES ($1, $2, $3, $3, $4) RETURNING *`,
        [newCode(), description, cents, expiresAt]
      );
      return res.status(201).json(view(rows[0]));
    } catch (e) {
      if (e.code !== '23505') throw e; // retry only on duplicate code
    }
  }
  res.status(500).json({ error: 'Could not generate a unique code. Try again.' });
});

// Delete a voucher (its transactions are removed with it)
app.delete('/api/vouchers/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM vouchers WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Voucher not found.' });
  res.json({ ok: true });
});

// Transaction history for one voucher
app.get('/api/vouchers/:id/transactions', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM voucher_transactions WHERE voucher_id = $1 ORDER BY created_at DESC',
    [Number(req.params.id)]
  );
  res.json(rows.map(txView));
});

// Deduct credit from a voucher
app.post('/api/vouchers/:id/deduct', async (req, res) => {
  const id = Number(req.params.id);
  const cents = toCents(req.body.amount);
  if (!cents) return res.status(400).json({ error: 'Enter an amount greater than $0.00.' });
  const note = (req.body.note || '').toString().trim().slice(0, 200) || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the row so two deductions at once can't overspend the balance
    const { rows } = await client.query('SELECT * FROM vouchers WHERE id = $1 FOR UPDATE', [id]);
    const v = rows[0];
    if (!v) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Voucher not found.' }); }
    if (isExpired(v)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This voucher has expired.' }); }
    if (cents > v.balance_cents) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Not enough credit. Remaining balance is $${(v.balance_cents / 100).toFixed(2)}.` });
    }
    const updated = await client.query(
      'UPDATE vouchers SET balance_cents = balance_cents - $2 WHERE id = $1 RETURNING *',
      [id, cents]
    );
    const tx = await client.query(
      `INSERT INTO voucher_transactions (voucher_id, amount_cents, balance_after_cents, note)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, cents, updated.rows[0].balance_cents, note]
    );
    await client.query('COMMIT');
    res.json({ voucher: view(updated.rows[0]), transaction: txView(tx.rows[0]) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// Serve the built React app (npm run build, then npm start)
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
app.use(express.static(dist));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

// Express 4 doesn't catch rejected promises from async handlers; forward them
for (const layer of app._router.stack) {
  const route = layer.route;
  if (!route) continue;
  for (const l of route.stack) {
    const fn = l.handle;
    if (fn.constructor.name === 'AsyncFunction') l.handle = (req, res, next) => fn(req, res, next).catch(next);
  }
}

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
