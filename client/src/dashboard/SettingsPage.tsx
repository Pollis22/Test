import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Settings {
  shop: {
    slug: string; name: string; timezone: string; currency: string;
    cancelCutoffHours: number; lateCancelFeeCents: number; staffCancelWaivesFee: boolean;
    stripeConnected: boolean; subscriptionTier: string;
  };
  features: { payments: 'stripe' | 'mock'; google: boolean };
}

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<Settings>(`/dashboard/settings`).then(setS);
  }, []);

  if (!s) return <p className="muted">Loading…</p>;

  async function save() {
    setMsg(''); setError('');
    try {
      await api(`/dashboard/settings`, {
        method: 'PUT',
        body: {
          name: s!.shop.name,
          timezone: s!.shop.timezone,
          cancelCutoffHours: s!.shop.cancelCutoffHours,
          lateCancelFeeCents: s!.shop.lateCancelFeeCents,
          staffCancelWaivesFee: s!.shop.staffCancelWaivesFee,
        },
      });
      setMsg('Saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function connectStripe() {
    try {
      const r = await api<{ url: string }>(`/dashboard/settings/stripe-connect`, { method: 'POST' });
      window.location.href = r.url;
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <h1 style={{ marginBottom: 14 }}>Settings</h1>
      {msg && <p className="good">{msg}</p>}
      {error && <p className="notice">{error}</p>}

      <div className="card">
        <h2>Shop profile</h2>
        <p className="muted small">Booking page: /{s.shop.slug} · tier: {s.shop.subscriptionTier}</p>
        <label>Shop name</label>
        <input value={s.shop.name} onChange={(e) => setS({ ...s, shop: { ...s.shop, name: e.target.value } })} />
        <label>Timezone (IANA)</label>
        <input value={s.shop.timezone} onChange={(e) => setS({ ...s, shop: { ...s.shop, timezone: e.target.value } })} />
      </div>

      <div className="card">
        <h2>Cancellation policy</h2>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Free-cancel cutoff (hours before start)</label>
            <input type="number" value={s.shop.cancelCutoffHours}
              onChange={(e) => setS({ ...s, shop: { ...s.shop, cancelCutoffHours: Number(e.target.value) } })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>Late-cancellation fee (cents)</label>
            <input type="number" value={s.shop.lateCancelFeeCents}
              onChange={(e) => setS({ ...s, shop: { ...s.shop, lateCancelFeeCents: Number(e.target.value) } })} />
          </div>
        </div>
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={s.shop.staffCancelWaivesFee}
            onChange={(e) => setS({ ...s, shop: { ...s.shop, staffCancelWaivesFee: e.target.checked } })} />
          Staff-initiated cancellations waive the fee
        </label>
        <p className="policy small">
          Customers see: “Free cancellation until {s.shop.cancelCutoffHours} hours before your appointment.
          Cancellations within {s.shop.cancelCutoffHours} hours incur a ${(s.shop.lateCancelFeeCents / 100).toFixed(0)} fee.”
        </p>
      </div>

      <div className="card">
        <h2>Payments</h2>
        <p className="muted small">Mode: <strong>{s.features.payments}</strong>{s.features.payments === 'mock' && ' (no Stripe key configured — simulated payments)'}</p>
        <p>Stripe Connect: {s.shop.stripeConnected ? <span className="badge confirmed">connected</span> : <span className="badge cancelled">not connected</span>}</p>
        <button className="navy" onClick={connectStripe}>{s.shop.stripeConnected ? 'Re-run onboarding' : 'Connect Stripe'}</button>
      </div>

      <div className="card">
        <h2>Google Calendar</h2>
        <p className="muted small">{s.features.google ? 'Enabled — connect per staff member on the Staff page.' : 'Off — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to enable.'}</p>
      </div>

      <p><button onClick={save}>Save settings</button></p>
    </>
  );
}
