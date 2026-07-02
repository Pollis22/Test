import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Rule { weekday: number; startTime: string; endTime: string }
interface StaffRow {
  id: string; display_name: string; email: string | null; color: string | null;
  active: boolean; google_sync_enabled: boolean; rules: Rule[];
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function StaffPage() {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [color, setColor] = useState('#06B6D4');
  const [editingRules, setEditingRules] = useState<{ staffId: string; rules: Rule[] } | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    api<{ staff: StaffRow[] }>(`/dashboard/staff`).then((r) => setStaff(r.staff));
  }, []);
  useEffect(reload, [reload]);

  async function addStaff() {
    try {
      await api(`/dashboard/staff`, { method: 'POST', body: { displayName: name, email: email || null, color } });
      setAdding(false); setName(''); setEmail('');
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveRules() {
    if (!editingRules) return;
    try {
      await api(`/dashboard/staff/${editingRules.staffId}/availability`, {
        method: 'PUT',
        body: { rules: editingRules.rules.map((r) => ({ ...r, startTime: r.startTime.slice(0, 5), endTime: r.endTime.slice(0, 5) })) },
      });
      setEditingRules(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <h1>Staff</h1>
        <button onClick={() => setAdding(true)}>+ Staff member</button>
      </div>
      {error && <p className="notice">{error}</p>}

      {staff.map((s) => (
        <div className="card" key={s.id}>
          <div className="row spread">
            <h2 style={{ margin: 0 }}>
              <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 6, background: s.color ?? '#06B6D4', marginRight: 8 }} />
              {s.display_name}
            </h2>
            <button className="ghost" onClick={() => setEditingRules({ staffId: s.id, rules: [...s.rules] })}>Edit weekly hours</button>
          </div>
          <p className="muted small">{s.email ?? 'no email'} · Google sync: {s.google_sync_enabled ? 'on' : 'off'}</p>
          <p className="small">
            {DAYS.map((d, i) => {
              const r = s.rules.find((x) => x.weekday === i);
              return <span key={i} style={{ marginRight: 12 }}><strong>{d}</strong> {r ? `${r.startTime.slice(0, 5)}–${r.endTime.slice(0, 5)}` : '—'}</span>;
            })}
          </p>
        </div>
      ))}

      {adding && (
        <div className="card" style={{ borderColor: '#06B6D4' }}>
          <h2>New staff member</h2>
          <label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} />
          <label>Email</label><input value={email} onChange={(e) => setEmail(e.target.value)} />
          <label>Calendar color</label><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 80, padding: 2 }} />
          <p className="row">
            <button disabled={!name} onClick={addStaff}>Add</button>
            <button className="ghost" onClick={() => setAdding(false)}>Cancel</button>
          </p>
        </div>
      )}

      {editingRules && (
        <div className="card" style={{ borderColor: '#06B6D4' }}>
          <h2>Weekly hours</h2>
          {DAYS.map((d, i) => {
            const rule = editingRules.rules.find((r) => r.weekday === i);
            return (
              <div className="row" key={i} style={{ marginBottom: 6 }}>
                <span style={{ width: 40 }}><strong>{d}</strong></span>
                <input type="checkbox" style={{ width: 'auto' }} checked={!!rule}
                  onChange={(e) => {
                    const rules = editingRules.rules.filter((r) => r.weekday !== i);
                    if (e.target.checked) rules.push({ weekday: i, startTime: '09:00', endTime: '18:00' });
                    setEditingRules({ ...editingRules, rules });
                  }} />
                {rule && <>
                  <input type="time" style={{ width: 120 }} value={rule.startTime.slice(0, 5)}
                    onChange={(e) => setEditingRules({
                      ...editingRules,
                      rules: editingRules.rules.map((r) => (r.weekday === i ? { ...r, startTime: e.target.value } : r)),
                    })} />
                  <span>–</span>
                  <input type="time" style={{ width: 120 }} value={rule.endTime.slice(0, 5)}
                    onChange={(e) => setEditingRules({
                      ...editingRules,
                      rules: editingRules.rules.map((r) => (r.weekday === i ? { ...r, endTime: e.target.value } : r)),
                    })} />
                </>}
              </div>
            );
          })}
          <p className="row">
            <button onClick={saveRules}>Save hours</button>
            <button className="ghost" onClick={() => setEditingRules(null)}>Cancel</button>
          </p>
        </div>
      )}
    </>
  );
}
