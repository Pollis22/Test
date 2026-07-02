import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

export function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      nav('/dashboard/calendar');
    } catch {
      setError('Invalid email or password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <span className="brand">Prelo <span className="accent">Booking</span></span>
        <span className="sub">Barber dashboard · Powered by JIE Mastery</span>
      </div>
      <div className="wrap" style={{ maxWidth: 420 }}>
        <form className="card" onSubmit={submit}>
          <h1>Sign in</h1>
          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" autoFocus />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="notice">{error}</p>}
          <p><button disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button></p>
        </form>
      </div>
    </>
  );
}
