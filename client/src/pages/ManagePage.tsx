// Manage page /m/:token — reschedule outside cutoff; inside the cutoff a
// keep-or-cancel-with-fee choice with explicit fee disclosure.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, money, fmtLocal, fmtTime } from '../lib/api';

interface ManageData {
  booking: {
    id: string; status: string; startsAt: string; endsAt: string;
    serviceName: string; staffName: string; shopName: string; shopSlug: string;
    timezone: string; amountCents: number; currency: string; customerName: string;
    lateFeeCents: number;
  };
  cancellation: { kind: 'free' | 'late_fee' | 'not_allowed'; refundCents: number; feeCents: number; policyText: string };
  rescheduleAllowed: boolean;
}

export function ManagePage() {
  const { token } = useParams();
  const [data, setData] = useState<ManageData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [resched, setResched] = useState(false);
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<Array<{ startsAt: string }> | null>(null);
  const [done, setDone] = useState('');

  const reload = useCallback(() => {
    api<ManageData>(`/manage/${token}`).then(setData).catch((e) => setError((e as Error).message));
  }, [token]);
  useEffect(reload, [reload]);

  if (error) return <div className="wrap"><div className="card"><h1>Not found</h1><p className="muted">{error}</p></div></div>;
  if (!data) return <div className="wrap"><div className="card muted">Loading…</div></div>;
  const { booking: b, cancellation: q } = data;

  async function doCancel() {
    setBusy(true);
    try {
      const r = await api<{ refundCents: number; feeCents: number }>(`/manage/${token}/cancel`, {
        method: 'POST',
        body: { feeAccepted: q.kind === 'late_fee' },
      });
      setDone(
        r.feeCents > 0
          ? `Cancelled. A ${money(r.feeCents, b.currency)} late fee applied; ${money(r.refundCents, b.currency)} is being refunded.`
          : `Cancelled. ${r.refundCents > 0 ? `${money(r.refundCents, b.currency)} is being refunded in full.` : 'No charge was captured.'}`,
      );
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadSlots(d: string) {
    setDate(d);
    setSlots(null);
    // service id isn't exposed here; the public shop endpoint gives us services by name
    const info = await api<{ services: Array<{ id: string; name: string }> }>(`/shops/${b.shopSlug}`);
    const svc = info.services.find((s) => s.name === b.serviceName);
    if (!svc) return setSlots([]);
    const r = await api<{ slots: Array<{ startsAt: string }> }>(`/shops/${b.shopSlug}/availability?service=${svc.id}&date=${d}`);
    const seen = new Set<string>();
    setSlots(r.slots.filter((s) => (seen.has(s.startsAt) ? false : (seen.add(s.startsAt), true))));
  }

  async function doReschedule(startsAt: string) {
    setBusy(true);
    try {
      await api(`/manage/${token}/reschedule`, { method: 'POST', body: { startsAt } });
      setDone('Rescheduled! A new confirmation email is on its way.');
      setResched(false);
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() + i * 86400_000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: b.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  });

  return (
    <>
      <div className="topbar">
        <span className="brand">{b.shopName}</span>
        <span className="sub">Manage appointment</span>
      </div>
      <div className="wrap">
        <div className="card">
          <h1>{b.serviceName} with {b.staffName}</h1>
          <p>{fmtLocal(b.startsAt, b.timezone)} · {money(b.amountCents, b.currency)} · <span className={`badge ${b.status}`}>{b.status.replace('_', ' ')}</span></p>
          {done && <p className="good">{done}</p>}
          {b.status === 'cancelled' && b.lateFeeCents > 0 && (
            <p className="muted small">A {money(b.lateFeeCents, b.currency)} late-cancellation fee was applied to this booking.</p>
          )}
        </div>

        {(b.status === 'confirmed' || b.status === 'pending_payment') && !done && (
          <div className="card">
            <h2>Change or cancel</h2>
            <div className="policy small">{q.policyText}</div>

            {data.rescheduleAllowed && !resched && (
              <p><button onClick={() => setResched(true)}>Reschedule</button></p>
            )}
            {resched && (
              <>
                <label>New date</label>
                <div className="grid cols">
                  {days.map((d) => (
                    <button key={d} className={`choice ${date === d ? 'sel' : ''}`} onClick={() => loadSlots(d)}>
                      <span className="small t">{new Intl.DateTimeFormat('en-US', { timeZone: b.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00`))}</span>
                    </button>
                  ))}
                </div>
                {date && slots === null && <p className="muted small">Loading times…</p>}
                {slots && (
                  <div className="grid cols" style={{ marginTop: 10 }}>
                    {slots.length === 0 && <p className="muted small">No openings.</p>}
                    {slots.map((s) => (
                      <button key={s.startsAt} className="choice" disabled={busy} onClick={() => doReschedule(s.startsAt)}>
                        <span className="small t">{fmtTime(s.startsAt, b.timezone)}</span>
                      </button>
                    ))}
                  </div>
                )}
                <p><button className="ghost" onClick={() => setResched(false)}>Never mind</button></p>
              </>
            )}

            {q.kind === 'free' && !confirmCancel && (
              <p><button className="ghost" onClick={() => setConfirmCancel(true)}>Cancel appointment (full refund)</button></p>
            )}
            {q.kind === 'late_fee' && !confirmCancel && (
              <>
                <p className="notice">
                  You're within the cancellation window. Cancelling now means a <strong>{money(q.feeCents, b.currency)} late fee</strong> —
                  you'd be refunded <strong>{money(q.refundCents, b.currency)}</strong> of {money(b.amountCents, b.currency)}.
                </p>
                <div className="row">
                  <button onClick={() => setConfirmCancel(false)}>Keep my appointment</button>
                  <button className="warn" onClick={() => setConfirmCancel(true)}>Cancel with {money(q.feeCents, b.currency)} fee</button>
                </div>
              </>
            )}
            {q.kind === 'not_allowed' && (
              <p className="notice">This appointment has already started — please call the shop directly.</p>
            )}
            {confirmCancel && (
              <div className="notice">
                <p style={{ marginTop: 0 }}>
                  {q.kind === 'late_fee'
                    ? `Confirm: cancel with a ${money(q.feeCents, b.currency)} fee and a ${money(q.refundCents, b.currency)} refund?`
                    : 'Confirm: cancel with a full refund?'}
                </p>
                <div className="row">
                  <button className="ghost" onClick={() => setConfirmCancel(false)}>Go back</button>
                  <button className="warn" disabled={busy} onClick={doCancel}>{busy ? 'Cancelling…' : 'Yes, cancel it'}</button>
                </div>
              </div>
            )}
            {error && <p className="notice">{error}</p>}
          </div>
        )}
        <p className="footerbrand">Prelo Booking — Powered by JIE Mastery</p>
      </div>
    </>
  );
}
