import { useEffect, useState } from 'react';
import { api, money, fmtLocal } from '../lib/api';

interface Customer {
  id: string; name: string; phone: string; email: string | null; notes: string | null;
  visits: number; last_visit: string | null;
}
interface HistoryRow { id: string; starts_at: string; status: string; amount_cents: number; service_name: string; staff_name: string }

export function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sel, setSel] = useState<Customer | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    api<{ customers: Customer[] }>(`/dashboard/customers`).then((r) => setCustomers(r.customers));
  }, []);

  async function open(c: Customer) {
    setSel(c);
    const r = await api<{ history: HistoryRow[] }>(`/dashboard/customers/${c.id}`);
    setHistory(r.history);
  }

  return (
    <>
      <h1 style={{ marginBottom: 14 }}>Customers</h1>
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Visits</th><th>Last visit</th></tr></thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => open(c)}>
                <td><strong>{c.name}</strong></td>
                <td>{c.phone}</td>
                <td className="muted">{c.email ?? '—'}</td>
                <td>{c.visits}</td>
                <td className="muted">{c.last_visit ? fmtLocal(c.last_visit, tz) : '—'}</td>
              </tr>
            ))}
            {!customers.length && <tr><td colSpan={5} className="muted">No customers yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {sel && (
        <div className="card" style={{ borderColor: '#06B6D4' }}>
          <div className="row spread">
            <h2>{sel.name}</h2>
            <button className="ghost" onClick={() => setSel(null)}>Close</button>
          </div>
          <p className="muted small">{sel.phone} · {sel.email ?? 'no email'}{sel.notes ? ` · ${sel.notes}` : ''}</p>
          <table>
            <thead><tr><th>When</th><th>Service</th><th>Staff</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{fmtLocal(h.starts_at, tz)}</td>
                  <td>{h.service_name}</td>
                  <td>{h.staff_name}</td>
                  <td>{money(h.amount_cents)}</td>
                  <td><span className={`badge ${h.status}`}>{h.status.replace('_', ' ')}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
