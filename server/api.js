// Voucher API shared by the Netlify Function (production) and the Express dev server (local).
// Takes a standard Request and returns a standard Response.
import { getDatabase, MissingDatabaseConnectionError } from '@netlify/database';
import crypto from 'node:crypto';
import { buildPass, walletEnabled } from './wallet.js';

let sql;
let ready;

// Netlify sets NETLIFY_DB_URL automatically; locally it comes from .env
function db() {
  if (!sql) {
    try {
      sql = getDatabase().sql;
    } catch (e) {
      if (e instanceof MissingDatabaseConnectionError) {
        throw Object.assign(new Error('NETLIFY_DB_URL is not set.'), { status: 500 });
      }
      throw e;
    }
  }
  return sql;
}

// Create tables on first use (once per cold start)
async function init() {
  ready ??= (async () => {
    const s = db();
    await s`
      CREATE TABLE IF NOT EXISTS vouchers (
        id             SERIAL PRIMARY KEY,
        code           TEXT UNIQUE NOT NULL,
        description    TEXT,
        initial_cents  INTEGER NOT NULL CHECK (initial_cents > 0),
        balance_cents  INTEGER NOT NULL CHECK (balance_cents >= 0),
        expires_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await s`
      CREATE TABLE IF NOT EXISTS voucher_transactions (
        id                   SERIAL PRIMARY KEY,
        voucher_id           INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
        amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
        balance_after_cents  INTEGER NOT NULL,
        note                 TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await s`CREATE INDEX IF NOT EXISTS voucher_transactions_voucher_id_idx ON voucher_transactions (voucher_id)`;
  })();
  try {
    await ready;
  } catch (e) {
    ready = null;
    throw e;
  }
}

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

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function listVouchers(url) {
  const s = db();
  const q = (url.searchParams.get('q') || '').trim();
  const rows = q
    ? await s`SELECT * FROM vouchers WHERE code ILIKE ${'%' + q + '%'} OR description ILIKE ${'%' + q + '%'}
              ORDER BY created_at DESC LIMIT 200`
    : await s`SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 200`;
  return json(rows.map(view));
}

async function createVoucher(body) {
  const s = db();
  const cents = toCents(body.value);
  if (!cents) return json({ error: 'Enter a value between $0.01 and $100,000.' }, 400);
  const description = (body.description || '').toString().trim().slice(0, 200) || null;

  // Expiry is the end of the chosen day, Sydney time
  const expiryDate = body.expiresAt ? String(body.expiresAt) : null;
  if (expiryDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) return json({ error: 'Invalid expiry date.' }, 400);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    if (expiryDate < today) return json({ error: 'Expiry date must be today or later.' }, 400);
  }

  const customCode = (body.code || '').toString().trim().toUpperCase();
  if (customCode && !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(customCode)) {
    return json({ error: 'Voucher no. can only use letters, numbers and dashes (max 40 characters).' }, 400);
  }

  // Returns no row if the code already exists
  const insert = code => s`
    INSERT INTO vouchers (code, description, initial_cents, balance_cents, expires_at)
    VALUES (${code}, ${description}, ${cents}::int, ${cents}::int,
            CASE WHEN ${expiryDate}::date IS NULL THEN NULL
                 ELSE (${expiryDate}::date + time '23:59:59') AT TIME ZONE 'Australia/Sydney' END)
    ON CONFLICT (code) DO NOTHING
    RETURNING *`;

  if (customCode) {
    const rows = await insert(customCode);
    return rows.length
      ? json(view(rows[0]), 201)
      : json({ error: `Voucher no. ${customCode} already exists.` }, 409);
  }
  for (let i = 0; i < 5; i++) {
    const rows = await insert(newCode());
    if (rows.length) return json(view(rows[0]), 201);
  }
  return json({ error: 'Could not generate a unique code. Try again.' }, 500);
}

async function deleteVoucher(id) {
  const rows = await db()`DELETE FROM vouchers WHERE id = ${id}::int RETURNING id`;
  return rows.length ? json({ ok: true }) : json({ error: 'Voucher not found.' }, 404);
}

async function listTransactions(id) {
  const rows = await db()`SELECT * FROM voucher_transactions WHERE voucher_id = ${id}::int ORDER BY created_at DESC`;
  return json(rows.map(txView));
}

async function deduct(id, body) {
  const s = db();
  const cents = toCents(body.amount);
  if (!cents) return json({ error: 'Enter an amount greater than $0.00.' }, 400);
  const note = (body.note || '').toString().trim().slice(0, 200) || null;

  // One atomic statement: only deducts if there is enough credit and the voucher hasn't expired,
  // so two deductions at the same moment can never overspend the balance.
  const rows = await s`
    WITH upd AS (
      UPDATE vouchers SET balance_cents = balance_cents - ${cents}::int
      WHERE id = ${id}::int AND balance_cents >= ${cents}::int
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING *
    ), tx AS (
      INSERT INTO voucher_transactions (voucher_id, amount_cents, balance_after_cents, note)
      SELECT id, ${cents}::int, balance_cents, ${note}::text FROM upd
      RETURNING *
    )
    SELECT row_to_json(upd.*) AS voucher, row_to_json(tx.*) AS tx FROM upd, tx`;

  if (rows.length) return json({ voucher: view(rows[0].voucher), transaction: txView(rows[0].tx) });

  const found = await s`SELECT * FROM vouchers WHERE id = ${id}::int`;
  if (!found.length) return json({ error: 'Voucher not found.' }, 404);
  const v = found[0];
  if (isExpired(v)) return json({ error: 'This voucher has expired.' }, 409);
  return json({ error: `Not enough credit. Remaining balance is $${(v.balance_cents / 100).toFixed(2)}.` }, 409);
}

async function walletPass(id) {
  if (!walletEnabled()) return json({ error: 'Apple Wallet is not set up yet.' }, 503);
  const rows = await db()`SELECT * FROM vouchers WHERE id = ${id}::int`;
  if (!rows.length) return json({ error: 'Voucher not found.' }, 404);
  const v = rows[0];
  return new Response(buildPass(v), {
    headers: {
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': `attachment; filename="voucher-${v.code}.pkpass"`,
      'Cache-Control': 'no-store'
    }
  });
}

export async function handleApi(request) {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;
    if (path === '/api/config' && method === 'GET') return json({ appleWallet: walletEnabled() });

    await init();
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await request.json().catch(() => ({})) : {};

    if (path === '/api/vouchers' && method === 'GET') return await listVouchers(url);
    if (path === '/api/vouchers' && method === 'POST') return await createVoucher(body);

    let m;
    if ((m = path.match(/^\/api\/vouchers\/(\d+)$/)) && method === 'DELETE') return await deleteVoucher(m[1]);
    if ((m = path.match(/^\/api\/vouchers\/(\d+)\/transactions$/)) && method === 'GET') return await listTransactions(m[1]);
    if ((m = path.match(/^\/api\/vouchers\/(\d+)\/deduct$/)) && method === 'POST') return await deduct(m[1], body);
    if ((m = path.match(/^\/api\/vouchers\/(\d+)\/pass$/)) && method === 'GET') return await walletPass(m[1]);

    return json({ error: 'Not found.' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e.status === 500 ? e.message : 'Server error.' }, 500);
  }
}
