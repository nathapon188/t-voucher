import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import BoxField from './BoxField.jsx';
import Barcode from './Barcode.jsx';
import { api, money, date, dateTime } from './api.js';
import { SALESPEOPLE } from '../server/salespeople.js';

function Progress({ v }) {
  const pct = v.initial ? (v.balance / v.initial) * 100 : 0;
  return (
    <div className="progress" aria-hidden="true">
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

function SalespersonPicker({ amount, onPick, onCancel }) {
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onCancel]);

  // Portal to <body> so the tilted card's transform doesn't affect the overlay
  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="sp-title" onClick={e => e.stopPropagation()}>
        <div id="sp-title" className="modal-title">Who is making this sale?</div>
        <div className="muted small">Deducting {money(amount)}</div>
        <div className="sp-grid">
          {SALESPEOPLE.map((name, i) => (
            <button key={name} className="sp-btn" onClick={() => onPick(name)} autoFocus={i === 0}>{name}</button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function AddVoucher({ onAdded, onCancel }) {
  const [code, setCode] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      onAdded(await api.create({ code, value, description, expiresAt: expiresAt || null }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-form" onSubmit={submit}>
      <label>Voucher no. <span className="opt">blank = auto</span>
        <input
          className="mono"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40))}
          placeholder="e.g. GV-10045"
          autoFocus
          spellCheck="false"
        />
      </label>
      <label>Value (AUD)
        <input type="number" min="0.01" step="0.01" value={value} onChange={e => setValue(e.target.value)} placeholder="50.00" required />
      </label>
      <label>Description <span className="opt">optional</span>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Store credit" maxLength={200} />
      </label>
      <label>Expiry <span className="opt">optional</span>
        <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
      </label>
      <div className="add-actions">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!value || busy}>{busy ? 'Adding...' : 'Add voucher'}</button>
      </div>
      {error && <p className="msg err">{error}</p>}
    </form>
  );
}

function VoucherDetail({ v, onChanged, onDeleted, celebrate, appleWallet }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [history, setHistory] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [shake, setShake] = useState(false);
  const [picking, setPicking] = useState(false);

  const loadHistory = useCallback(() => api.transactions(v.id).then(setHistory).catch(() => {}), [v.id]);

  useEffect(() => {
    setAmount(''); setNote(''); setMsg(null); setConfirmDelete(false); setPicking(false);
    loadHistory();
  }, [v.id, loadHistory]);

  function askSalesperson(e) {
    e.preventDefault();
    setMsg(null);
    setPicking(true);
  }

  async function deduct(salesperson) {
    setPicking(false);
    setBusy(true); setMsg(null);
    try {
      const { voucher, transaction } = await api.deduct(v.id, { amount, note, salesperson });
      onChanged(voucher);
      setMsg({ type: 'ok', text: `Deducted ${money(transaction.amount)} by ${transaction.salesperson} at ${dateTime(transaction.createdAt)}. Remaining ${money(voucher.balance)}.` });
      setAmount(''); setNote('');
      loadHistory();
      celebrate();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
      setShake(true); setTimeout(() => setShake(false), 400);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy(true);
    try {
      await api.remove(v.id);
      onDeleted(v.id);
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
      setBusy(false);
    }
  }

  const amountNum = Number(amount);
  const canDeduct = v.status === 'active' && amountNum > 0 && amountNum <= v.balance && !busy;

  return (
    <div className="detail">
      <div className="detail-head">
        <span className="mono code-lg">{v.code}</span>
        <span className={`badge ${v.status}`}>{v.status}</span>
      </div>
      {v.description && <div className="muted">{v.description}</div>}

      <div className="balance">
        <span className="balance-label">Remaining credit</span>
        <span className="balance-value">{money(v.balance)}</span>
        <span className="muted small">of {money(v.initial)} · Expires {date(v.expiresAt)}</span>
      </div>
      <Progress v={v} />

      <Barcode value={v.code} />
      {appleWallet && v.status === 'active' && (
        <a className="wallet-btn" href={`/api/vouchers/${v.id}/pass`}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M3 10h18M3 13.5h18" stroke="currentColor" strokeWidth="1.6" /></svg>
          Add to Apple Wallet
        </a>
      )}

      {v.status === 'active' ? (
        <form className="deduct" onSubmit={askSalesperson}>
          <div className="deduct-row">
            <div className={`amount ${shake ? 'shake' : ''}`}>
              <span>$</span>
              <input
                type="number" min="0.01" step="0.01" max={v.balance}
                value={amount} onChange={e => { setAmount(e.target.value); setMsg(null); }}
                placeholder="0.00" aria-label="Amount to deduct"
              />
            </div>
            <button type="button" className="ghost" onClick={() => setAmount(v.balance.toFixed(2))}>Full</button>
          </div>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional), e.g. Store 214 sale" maxLength={200} />
          <button className="primary" disabled={!canDeduct}>
            {busy ? 'Deducting...' : amountNum > 0 ? `Deduct ${money(amountNum)}` : 'Deduct credit'}
          </button>
          {amountNum > v.balance && <p className="msg err">Amount is more than the remaining credit.</p>}
        </form>
      ) : (
        <p className="msg muted">{v.status === 'expired' ? 'This voucher has expired.' : 'This voucher has no credit left.'}</p>
      )}
      {msg && <p className={`msg ${msg.type}`} role="status">{msg.text}</p>}
      {picking && <SalespersonPicker amount={amountNum} onPick={deduct} onCancel={() => setPicking(false)} />}

      <div className="history">
        <div className="section-title">History</div>
        {history.length === 0 ? (
          <div className="muted small">No deductions yet.</div>
        ) : (
          history.map(t => (
            <div key={t.id} className="history-row">
              <div>
                <div>-{money(t.amount)}</div>
                <div className="muted small">{dateTime(t.createdAt)}{t.salesperson ? ` · ${t.salesperson}` : ''}{t.note ? ` · ${t.note}` : ''}</div>
              </div>
              <div className="muted small right">Bal. {money(t.balanceAfter)}</div>
            </div>
          ))
        )}
      </div>

      <div className="danger">
        {confirmDelete && <button className="ghost" onClick={() => setConfirmDelete(false)}>Keep</button>}
        <button className={`delete ${confirmDelete ? 'armed' : ''}`} onClick={remove} disabled={busy}>
          {confirmDelete ? 'Confirm delete' : 'Delete voucher'}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const field = useRef(null);
  const card = useRef(null);
  const [vouchers, setVouchers] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tilt, setTilt] = useState('');
  const [appleWallet, setAppleWallet] = useState(false);

  useEffect(() => { api.config().then(c => setAppleWallet(c.appleWallet)).catch(() => {}); }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      api.list(query)
        .then(rows => { setVouchers(rows); setError(''); })
        .catch(err => setError(err.message))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const move = e => {
      const rx = (e.clientY / window.innerHeight - 0.5) * -4;
      const ry = (e.clientX / window.innerWidth - 0.5) * 5;
      setTilt(`rotateX(${rx}deg) rotateY(${ry}deg)`);
    };
    const leave = () => setTilt('');
    window.addEventListener('pointermove', move);
    document.addEventListener('pointerleave', leave);
    return () => { window.removeEventListener('pointermove', move); document.removeEventListener('pointerleave', leave); };
  }, []);

  const celebrate = () => {
    const r = card.current.getBoundingClientRect();
    field.current?.ripple(r.left + r.width / 2, r.top + r.height / 2, 55);
  };

  const selected = vouchers.find(v => v.id === selectedId);

  return (
    <>
      <BoxField ref={field} />
      <div className="vignette" />
      <main className="stage">
        <section className="card" ref={card} style={{ transform: tilt }}>
          <header className="top">
            <div>
              <h1><img src="/logo.ico" alt="" className="logo" />Vouchers</h1>
              <p className="muted small">Select a voucher to deduct credit.</p>
            </div>
            {!adding && <button className="primary small-btn" onClick={() => setAdding(true)}>+ Add voucher</button>}
          </header>

          {adding && (
            <AddVoucher
              onCancel={() => setAdding(false)}
              onAdded={v => { setVouchers(list => [v, ...list]); setSelectedId(v.id); setAdding(false); celebrate(); }}
            />
          )}

          <div className="layout">
            <div className="list-col">
              <input className="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search code or description" />
              <div className="list">
                {loading && <div className="muted small pad">Loading...</div>}
                {error && <div className="msg err pad">{error}</div>}
                {!loading && !error && vouchers.length === 0 && (
                  <div className="muted small pad">{query ? 'No vouchers match.' : 'No vouchers yet. Add one to get started.'}</div>
                )}
                {vouchers.map(v => (
                  <button key={v.id} className={`row ${v.id === selectedId ? 'sel' : ''} ${v.status}`} onClick={() => setSelectedId(v.id)}>
                    <div className="row-top">
                      <span className="mono">{v.code}</span>
                      <span className="row-bal">{money(v.balance)}</span>
                    </div>
                    <div className="row-sub">
                      <span className="muted small ellipsis">{v.description || 'No description'}</span>
                      <span className={`badge ${v.status}`}>{v.status}</span>
                    </div>
                    <Progress v={v} />
                  </button>
                ))}
              </div>
            </div>

            <div className="detail-col">
              {selected ? (
                <VoucherDetail
                  v={selected}
                  celebrate={celebrate}
                  appleWallet={appleWallet}
                  onChanged={nv => setVouchers(list => list.map(x => (x.id === nv.id ? nv : x)))}
                  onDeleted={id => { setVouchers(list => list.filter(x => x.id !== id)); setSelectedId(null); }}
                />
              ) : (
                <div className="empty">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z" />
                    <path d="M13 6v2M13 11v2M13 16v2" />
                  </svg>
                  <div>Select a voucher from the list</div>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
