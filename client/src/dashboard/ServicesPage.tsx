import { useCallback, useEffect, useState } from 'react';
import { api, money } from '../lib/api';

interface Service {
  id: string; name: string; duration_min: number; price_cents: number;
  buffer_after_min: number; active: boolean; staff_ids: string[];
}
interface StaffRow { id: string; display_name: string }

export function ServicesPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [editing, setEditing] = useState<Partial<Service> | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    api<{ services: Service[] }>(`/dashboard/services`).then((r) => setServices(r.services));
  }, []);
  useEffect(() => {
    reload();
    api<{ staff: StaffRow[] }>(`/dashboard/staff`).then((r) => setStaff(r.staff));
  }, [reload]);

  async function save() {
    if (!editing) return;
    setError('');
    const body = {
      name: editing.name ?? '',
      durationMin: Number(editing.duration_min ?? 30),
      priceCents: Number(editing.price_cents ?? 0),
      bufferAfterMin: Number(editing.buffer_after_min ?? 0),
      active: editing.active ?? true,
      staffIds: editing.staff_ids ?? staff.map((s) => s.id),
    };
    try {
      if (editing.id) await api(`/dashboard/services/${editing.id}`, { method: 'PUT', body });
      else await api(`/dashboard/services`, { method: 'POST', body });
      setEditing(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <h1>Services</h1>
        <button onClick={() => setEditing({ active: true, staff_ids: staff.map((s) => s.id) })}>+ Service</button>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Service</th><th>Duration</th><th>Buffer</th><th>Price</th><th>Staff</th><th>Active</th><th /></tr></thead>
          <tbody>
            {services.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong></td>
                <td>{s.duration_min} min</td>
                <td>{s.buffer_after_min} min</td>
                <td>{money(s.price_cents)}</td>
                <td className="muted small">{s.staff_ids.length}/{staff.length}</td>
                <td>{s.active ? '✓' : '—'}</td>
                <td><button className="ghost" onClick={() => setEditing(s)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="card" style={{ borderColor: '#06B6D4' }}>
          <h2>{editing.id ? 'Edit service' : 'New service'}</h2>
          <label>Name</label>
          <input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Duration (min)</label>
              <input type="number" value={editing.duration_min ?? 30} onChange={(e) => setEditing({ ...editing, duration_min: Number(e.target.value) })} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Buffer after (min)</label>
              <input type="number" value={editing.buffer_after_min ?? 0} onChange={(e) => setEditing({ ...editing, buffer_after_min: Number(e.target.value) })} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Price (cents)</label>
              <input type="number" value={editing.price_cents ?? 0} onChange={(e) => setEditing({ ...editing, price_cents: Number(e.target.value) })} />
            </div>
          </div>
          <label>Offered by</label>
          <div className="row">
            {staff.map((s) => (
              <label key={s.id} className="row" style={{ fontWeight: 400, margin: 0 }}>
                <input type="checkbox" style={{ width: 'auto' }}
                  checked={(editing.staff_ids ?? []).includes(s.id)}
                  onChange={(e) => {
                    const cur = new Set(editing.staff_ids ?? []);
                    e.target.checked ? cur.add(s.id) : cur.delete(s.id);
                    setEditing({ ...editing, staff_ids: [...cur] });
                  }} />
                {s.display_name}
              </label>
            ))}
          </div>
          <label className="row" style={{ fontWeight: 400 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={editing.active ?? true}
              onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active
          </label>
          {error && <p className="notice">{error}</p>}
          <p className="row">
            <button onClick={save}>Save</button>
            <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
          </p>
        </div>
      )}
    </>
  );
}
