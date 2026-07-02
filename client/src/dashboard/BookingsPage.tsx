import { useEffect, useState } from 'react';
import { api, money, fmtLocal } from '../lib/api';

interface Row {
  id: string; starts_at: string; status: string; source: string; amount_cents: number;
  late_fee_cents: number; customer_name: string; customer_phone: string;
  service_name: string; staff_name: string;
}

export function BookingsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    api<{ bookings: Row[] }>(`/dashboard/bookings${status ? `?status=${status}` : ''}`).then((r) => setRows(r.bookings));
  }, [status]);

  return (
    <>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <h1>Bookings</h1>
        <select style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['confirmed', 'pending_payment', 'completed', 'cancelled', 'no_show'].map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>When</th><th>Customer</th><th>Service</th><th>Staff</th><th>Amount</th><th>Status</th><th>Source</th></tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td>{fmtLocal(b.starts_at, tz)}</td>
                <td>{b.customer_name}<br /><span className="muted small">{b.customer_phone}</span></td>
                <td>{b.service_name}</td>
                <td>{b.staff_name}</td>
                <td>{money(b.amount_cents)}{b.late_fee_cents > 0 && <span className="muted small"> (−{money(b.late_fee_cents)} fee)</span>}</td>
                <td><span className={`badge ${b.status}`}>{b.status.replace('_', ' ')}</span></td>
                <td className="muted">{b.source}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted">No bookings yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
