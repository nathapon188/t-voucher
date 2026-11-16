async function call(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

export const api = {
  config: () => call('/api/config'),
  list: q => call(`/api/vouchers${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  create: body => call('/api/vouchers', { method: 'POST', body: JSON.stringify(body) }),
  remove: id => call(`/api/vouchers/${id}`, { method: 'DELETE' }),
  transactions: id => call(`/api/vouchers/${id}/transactions`),
  deduct: (id, body) => call(`/api/vouchers/${id}/deduct`, { method: 'POST', body: JSON.stringify(body) })
};

export const money = n => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
export const date = d =>
  d ? new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'No expiry';
export const dateTime = d =>
  new Date(d).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
