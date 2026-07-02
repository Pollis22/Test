// Day + week calendar with per-staff columns; create/cancel bookings,
// block time, mark completed/no_show.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, money, fmtTime } from '../lib/api';

interface CalBooking {
  id: string; staff_id: string; starts_at: string; ends_at: string; status: string;
  source: string; amount_cents: number; customer_name: string; customer_phone: string;
  service_name: string; staff_name: string; staff_color: string | null;
}
interface CalTimeOff { id: string; staff_id: string; starts_at: string; ends_at: string; reason: string | null }
interface StaffRow { id: string; display_name: string; color: string | null; active: boolean }
interface ServiceRow { id: string; name: string; duration_min: number; price_cents: number; active: boolean }

function dayISO(offset: number): string {
  const d = new Date(Date.now() + offset * 86400_000);
  return d.toISOString().slice(0, 10);
}

export function CalendarPage() {
  const [mode, setMode] = useState<'day' | 'week'>('day');
  const [anchor, setAnchor] = useState(dayISO(0));
  const [bookings, setBookings] = useState<CalBooking[]>([]);
  const [timeOff, setTimeOff] = useState<CalTimeOff[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [sel, setSel] = useState<CalBooking | null>(null);
  const [creating, setCreating] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [msg, setMsg] = useState('');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const from = useMemo(() => `${anchor}T00:00:00`, [anchor]);
  const to = useMemo(() => {
    const days = mode === 'day' ? 1 : 7;
    return new Date(new Date(`${anchor}T00:00:00`).getTime() + days * 86400_000).toISOString();
  }, [anchor, mode]);

  const reload = useCallback(() => {
    api<{ bookings: CalBooking[]; timeOff: CalTimeOff[] }>(`/dashboard/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => { setBookings(r.bookings); setTimeOff(r.timeOff); });
  }, [from, to]);

  useEffect(() => {
    api<{ staff: StaffRow[] }>(`/dashboard/staff`).then((r) => setStaff(r.staff.filter((s) => s.active)));
    api<{ services: ServiceRow[] }>(`/dashboard/services`).then((r) => setServices(r.services.filter((s) => s.active)));
  }, []);
  useEffect(reload, [reload]);

  async function setStatus(id: string, status: 'completed' | 'no_show') {
    await api(`/dashboard/bookings/${id}/status`, { method: 'POST', body: { status } });
    setSel(null);
    reload();
  }

  async function cancelBooking(id: string) {
    const r = await api<{ refundCents: number }>(`/dashboard/bookings/${id}/cancel`, { method: 'POST' });
    setMsg(`Cancelled — ${money(r.refundCents)} refunded (staff cancel, fee waived per shop policy).`);
    setSel(null);
    reload();
  }

  const days = mode === 'day' ? [anchor] : Array.from({ length: 7 }, (_, i) =>
    new Date(new Date(`${anchor}T00:00:00`).getTime() + i * 86400_000).toISOString().slice(0, 10));

  return (
    <>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <h1>Calendar</h1>
        <div className="row">
          <button className="ghost" onClick={() => setAnchor(dayISO(0))}>Today</button>
          <button className="ghost" onClick={() => setAnchor(new Date(new Date(`${anchor}T00:00:00`).getTime() - (mode === 'day' ? 1 : 7) * 86400_000).toISOString().slice(0, 10))}>←</button>
          <strong>{anchor}</strong>
          <button className="ghost" onClick={() => setAnchor(new Date(new Date(`${anchor}T00:00:00`).getTime() + (mode === 'day' ? 1 : 7) * 86400_000).toISOString().slice(0, 10))}>→</button>
          <select style={{ width: 'auto' }} value={mode} onChange={(e) => setMode(e.target.value as 'day' | 'week')}>
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
          <button onClick={() => setCreating(true)}>+ Booking</button>
          <button className="ghost" onClick={() => setBlocking(true)}>Block time</button>
        </div>
      </div>
      {msg && <p className="good">{msg}</p>}

      {days.map((d) => (
        <div className="card" key={d}>
          <h2>{new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
          <div className="cal" style={{ gridTemplateColumns: `repeat(${Math.max(staff.length, 1)}, 1fr)` }}>
            {staff.map((s) => <div key={s.id} className="cell head" style={{ borderTop: `3px solid ${s.color ?? '#06B6D4'}` }}>{s.display_name}</div>)}
            {staff.map((s) => (
              <div key={s.id} className="cell" style={{ minHeight: 120 }}>
                {bookings
                  .filter((b) => b.staff_id === s.id && b.starts_at.slice(0, 10) === d)
                  .map((b) => (
                    <div key={b.id} className="ev" onClick={() => setSel(b)}>
                      <strong>{fmtTime(b.starts_at, tz)}</strong> {b.service_name}<br />
                      <span className="muted">{b.customer_name}</span> <span className={`badge ${b.status}`}>{b.status.replace('_', ' ')}</span>
                    </div>
                  ))}
                {timeOff
                  .filter((t) => t.staff_id === s.id && t.starts_at.slice(0, 10) <= d && t.ends_at.slice(0, 10) >= d)
                  .map((t) => (
                    <div key={t.id} className="ev" style={{ borderLeftColor: '#94a3b8', background: '#f1f5f9' }}>
                      Blocked {t.reason ? `— ${t.reason}` : ''}
                      <button className="ghost small" style={{ padding: '1px 7px', marginLeft: 6 }}
                        onClick={async () => { await api(`/dashboard/time-off/${t.id}`, { method: 'DELETE' }); reload(); }}>✕</button>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      ))}

      {sel && (
        <div className="card" style={{ borderColor: '#06B6D4' }}>
          <h2>{sel.service_name} — {sel.customer_name}</h2>
          <p className="muted">{fmtTime(sel.starts_at, tz)}–{fmtTime(sel.ends_at, tz)} with {sel.staff_name} · {money(sel.amount_cents)} · {sel.customer_phone} · source: {sel.source}</p>
          <div className="row">
            {sel.status === 'confirmed' && <>
              <button onClick={() => setStatus(sel.id, 'completed')}>Mark completed</button>
              <button className="ghost" onClick={() => setStatus(sel.id, 'no_show')}>No-show</button>
              <button className="warn" onClick={() => cancelBooking(sel.id)}>Cancel (no fee)</button>
            </>}
            <button className="ghost" onClick={() => setSel(null)}>Close</button>
          </div>
        </div>
      )}

      {creating && <CreateBookingForm staff={staff} services={services} onDone={() => { setCreating(false); reload(); }} />}
      {blocking && <BlockTimeForm staff={staff} onDone={() => { setBlocking(false); reload(); }} />}
    </>
  );
}

function CreateBookingForm({ staff, services, onDone }: {
  staff: StaffRow[]; services: ServiceRow[]; onDone: () => void;
}) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [staffId, setStaffId] = useState(staff[0]?.id ?? '');
  const [when, setWhen] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api('/dashboard/bookings', {
        method: 'POST',
        body: {
          serviceId, staffId,
          startsAt: new Date(when).toISOString(),
          customer: { name, phone, email: email || null },
        },
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ borderColor: '#06B6D4' }}>
      <h2>New booking (confirmed, no payment)</h2>
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>Service</label>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.duration_min}m)</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Staff</label>
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
          </select>
        </div>
      </div>
      <label>Date & time</label>
      <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      <div className="row">
        <div style={{ flex: 1 }}><label>Customer name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div style={{ flex: 1 }}><label>Phone (E.164)</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+15551234567" /></div>
      </div>
      <label>Email (optional)</label>
      <input value={email} onChange={(e) => setEmail(e.target.value)} />
      {error && <p className="notice">{error}</p>}
      <p className="row">
        <button disabled={busy || !when || !name || !phone} onClick={submit}>{busy ? 'Saving…' : 'Create booking'}</button>
        <button className="ghost" onClick={onDone}>Cancel</button>
      </p>
    </div>
  );
}

function BlockTimeForm({ staff, onDone }: { staff: StaffRow[]; onDone: () => void }) {
  const [staffId, setStaffId] = useState(staff[0]?.id ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  async function submit() {
    try {
      await api(`/dashboard/staff/${staffId}/time-off`, {
        method: 'POST',
        body: { startsAt: new Date(from).toISOString(), endsAt: new Date(to).toISOString(), reason: reason || undefined },
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="card" style={{ borderColor: '#06B6D4' }}>
      <h2>Block time</h2>
      <label>Staff</label>
      <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
        {staff.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
      </select>
      <div className="row">
        <div style={{ flex: 1 }}><label>From</label><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div style={{ flex: 1 }}><label>To</label><input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <label>Reason (optional)</label>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lunch, appointment, vacation…" />
      {error && <p className="notice">{error}</p>}
      <p className="row">
        <button disabled={!from || !to} onClick={submit}>Block</button>
        <button className="ghost" onClick={onDone}>Cancel</button>
      </p>
    </div>
  );
}
