// Mobile-first booking flow: service → staff ("Any" = least-loaded) →
// date/time grid → details + policy ack → pay → confirmation.
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, money, fmtLocal, fmtTime } from '../lib/api';

interface ShopInfo {
  shop: {
    slug: string; name: string; timezone: string; currency: string;
    cancelCutoffHours: number; lateCancelFeeCents: number; policyText: string;
  };
  services: Array<{ id: string; name: string; durationMin: number; priceCents: number }>;
  staff: Array<{ id: string; displayName: string; color: string | null }>;
  payments: { mode: 'stripe' | 'mock'; publishableKey: string | null };
}

interface Slot { staffId: string; startsAt: string; endsAt: string }

interface CreatedBooking {
  bookingId: string; manageToken: string; status: string; amountCents: number;
  holdExpiresAt: string | null;
  payment: { provider: 'stripe' | 'mock'; intentId: string; clientSecret: string } | null;
}

function nextDays(n: number, timezone: string): Array<{ iso: string; label: string }> {
  const out = [];
  const fmtIso = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtLabel = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric' });
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() + i * 86400_000);
    out.push({ iso: fmtIso.format(d), label: i === 0 ? 'Today' : fmtLabel.format(d) });
  }
  return out;
}

export function BookingWizard() {
  const { slug } = useParams();
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [step, setStep] = useState(0);
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState<'any' | string>('any');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [startsAt, setStartsAt] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<CreatedBooking | null>(null);
  const [paid, setPaid] = useState(false);

  useEffect(() => {
    api<ShopInfo>(`/shops/${slug}`).then(setInfo).catch(() => setNotFound(true));
  }, [slug]);

  useEffect(() => {
    if (!info || !serviceId || !date) return;
    setSlots(null);
    const staffQ = staffId !== 'any' ? `&staff=${staffId}` : '';
    api<{ slots: Slot[] }>(`/shops/${slug}/availability?service=${serviceId}&date=${date}${staffQ}`)
      .then((r) => setSlots(r.slots))
      .catch(() => setSlots([]));
  }, [info, serviceId, staffId, date, slug]);

  const days = useMemo(() => (info ? nextDays(14, info.shop.timezone) : []), [info]);
  const uniqueTimes = useMemo(() => {
    if (!slots) return [];
    const seen = new Set<string>();
    return slots.filter((s) => (seen.has(s.startsAt) ? false : (seen.add(s.startsAt), true)));
  }, [slots]);

  if (notFound) return <div className="wrap"><div className="card"><h1>Shop not found</h1></div></div>;
  if (!info) return <div className="wrap"><div className="card muted">Loading…</div></div>;
  const service = info.services.find((s) => s.id === serviceId);

  async function submitBooking() {
    setBusy(true);
    setError('');
    try {
      const r = await api<CreatedBooking>(`/shops/${slug}/bookings`, {
        method: 'POST',
        body: {
          serviceId, staffId, startsAt,
          customer: { name, phone, email: email || null },
          policyAck: ack,
        },
      });
      setCreated(r);
      setStep(4);
    } catch (err) {
      const e = err as Error & { code?: string };
      setError(e.code === 'SLOT_TAKEN' ? 'That time was just taken — please pick another.' : e.message);
      if (e.code === 'SLOT_TAKEN') { setStep(2); setStartsAt(''); setSlots(null); setDate((d) => d); }
    } finally {
      setBusy(false);
    }
  }

  async function payNow() {
    if (!created?.payment) return;
    setBusy(true);
    setError('');
    try {
      if (created.payment.provider === 'mock') {
        await api(`/payments/mock/confirm`, { method: 'POST', body: { intentId: created.payment.intentId } });
        setPaid(true);
      } else {
        // Stripe mode: redirect-style confirmation happens on the manage page
        // via Stripe.js Elements (loaded only when keys exist).
        window.location.href = `/m/${created.manageToken}?pay=1`;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <span className="brand">{info.shop.name}</span>
        <span className="sub">via Prelo Booking · Powered by JIE Mastery</span>
      </div>
      <div className="wrap">
        <div className="steps">{[0, 1, 2, 3, 4].map((i) => <div key={i} className={`dot ${step >= i ? 'on' : ''}`} />)}</div>

        {step === 0 && (
          <div className="card">
            <h1>Choose a service</h1>
            <div className="grid">
              {info.services.map((s) => (
                <button key={s.id} className={`choice ${serviceId === s.id ? 'sel' : ''}`}
                  onClick={() => { setServiceId(s.id); setStep(1); }}>
                  <div className="row spread"><span className="t">{s.name}</span><span>{money(s.priceCents, info.shop.currency)}</span></div>
                  <div className="muted small">{s.durationMin} min</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="card">
            <h1>Choose your barber</h1>
            <div className="grid">
              <button className={`choice ${staffId === 'any' ? 'sel' : ''}`} onClick={() => { setStaffId('any'); setStep(2); }}>
                <span className="t">Any available</span>
                <div className="muted small">We'll match you with the least-booked barber</div>
              </button>
              {info.staff.map((s) => (
                <button key={s.id} className={`choice ${staffId === s.id ? 'sel' : ''}`} onClick={() => { setStaffId(s.id); setStep(2); }}>
                  <span className="t">{s.displayName}</span>
                </button>
              ))}
            </div>
            <p><button className="ghost" onClick={() => setStep(0)}>← Back</button></p>
          </div>
        )}

        {step === 2 && (
          <div className="card">
            <h1>Pick a time</h1>
            <p className="muted small">{service?.name} · {service?.durationMin} min · times shown in {info.shop.timezone}</p>
            <div className="grid cols" style={{ marginBottom: 14 }}>
              {days.map((d) => (
                <button key={d.iso} className={`choice ${date === d.iso ? 'sel' : ''}`} onClick={() => { setDate(d.iso); setStartsAt(''); }}>
                  <span className="small t">{d.label}</span>
                </button>
              ))}
            </div>
            {date && slots === null && <p className="muted">Checking openings…</p>}
            {date && slots !== null && uniqueTimes.length === 0 && <p className="notice">No openings that day — try another date.</p>}
            <div className="grid cols">
              {uniqueTimes.map((s) => (
                <button key={s.startsAt} className={`choice ${startsAt === s.startsAt ? 'sel' : ''}`} onClick={() => setStartsAt(s.startsAt)}>
                  <span className="small t">{fmtTime(s.startsAt, info.shop.timezone)}</span>
                </button>
              ))}
            </div>
            <p className="row">
              <button className="ghost" onClick={() => setStep(1)}>← Back</button>
              <button disabled={!startsAt} onClick={() => setStep(3)}>Continue</button>
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="card">
            <h1>Your details</h1>
            <p className="muted small">{service?.name} · {fmtLocal(startsAt, info.shop.timezone)} · {money(service?.priceCents ?? 0, info.shop.currency)}</p>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            <label>Mobile phone</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+15551234567" inputMode="tel" />
            <label>Email (for confirmation & receipts)</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" inputMode="email" />
            <div className="policy">
              <strong>Cancellation policy:</strong> {info.shop.policyText}
              <div className="row" style={{ marginTop: 8 }}>
                <input type="checkbox" id="ack" style={{ width: 'auto' }} checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <label htmlFor="ack" style={{ margin: 0 }}>I understand and accept</label>
              </div>
            </div>
            {error && <p className="notice">{error}</p>}
            <p className="row">
              <button className="ghost" onClick={() => setStep(2)}>← Back</button>
              <button disabled={busy || !name || !phone || !ack} onClick={submitBooking}>
                {busy ? 'Holding your slot…' : 'Continue to payment'}
              </button>
            </p>
          </div>
        )}

        {step === 4 && created && !paid && (
          <div className="card">
            <h1>Payment</h1>
            <p className="muted">Your slot is held for 10 minutes. Complete payment to confirm.</p>
            <p><strong>{service?.name}</strong> · {fmtLocal(startsAt, info.shop.timezone)} · {money(created.amountCents, info.shop.currency)}</p>
            {info.payments.mode === 'mock' && (
              <p className="notice small">Test environment — payments are simulated (no card required).</p>
            )}
            {error && <p className="notice">{error}</p>}
            <button disabled={busy} onClick={payNow}>
              {busy ? 'Processing…' : `Pay ${money(created.amountCents, info.shop.currency)}`}
            </button>
          </div>
        )}

        {step === 4 && created && paid && (
          <div className="card">
            <h1>You're booked! ✂️</h1>
            <p className="good">{service?.name} confirmed for {fmtLocal(startsAt, info.shop.timezone)}.</p>
            {email && <p className="muted small">A confirmation email with your manage link is on its way.</p>}
            <p><a className="btn" href={`/m/${created.manageToken}`}>Manage this appointment</a></p>
            <div className="policy small">{info.shop.policyText}</div>
          </div>
        )}

        <p className="footerbrand">Prelo Booking — Powered by JIE Mastery</p>
      </div>
    </>
  );
}
