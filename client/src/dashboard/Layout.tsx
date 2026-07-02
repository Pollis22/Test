import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

export function DashboardLayout() {
  const nav = useNavigate();
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);

  useEffect(() => {
    api<{ user: { email: string; role: string } }>(`/auth/me`)
      .then((r) => setUser(r.user))
      .catch(() => nav('/dashboard/login'));
  }, [nav]);

  if (!user) return <div className="wrap muted">Loading…</div>;

  return (
    <div className="dash">
      <nav className="sidebar">
        <div style={{ color: '#fff', fontWeight: 700, padding: '4px 12px 16px' }}>
          Prelo <span style={{ color: '#06B6D4' }}>Booking</span>
        </div>
        <NavLink to="/dashboard/calendar">Calendar</NavLink>
        <NavLink to="/dashboard/bookings">Bookings</NavLink>
        <NavLink to="/dashboard/services">Services</NavLink>
        <NavLink to="/dashboard/staff">Staff</NavLink>
        <NavLink to="/dashboard/customers">Customers</NavLink>
        <NavLink to="/dashboard/settings">Settings</NavLink>
        <a href="#logout" onClick={async (e) => { e.preventDefault(); await api('/auth/logout', { method: 'POST' }); nav('/dashboard/login'); }}>
          Sign out ({user.email.split('@')[0]})
        </a>
      </nav>
      <main><Outlet /></main>
    </div>
  );
}
