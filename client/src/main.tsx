import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import './styles.css';
import { BookingWizard } from './pages/BookingWizard';
import { ManagePage } from './pages/ManagePage';
import { DashboardLayout } from './dashboard/Layout';
import { LoginPage } from './dashboard/LoginPage';
import { CalendarPage } from './dashboard/CalendarPage';
import { BookingsPage } from './dashboard/BookingsPage';
import { ServicesPage } from './dashboard/ServicesPage';
import { StaffPage } from './dashboard/StaffPage';
import { CustomersPage } from './dashboard/CustomersPage';
import { SettingsPage } from './dashboard/SettingsPage';

const router = createBrowserRouter([
  { path: '/m/:token', element: <ManagePage /> },
  { path: '/dashboard/login', element: <LoginPage /> },
  {
    path: '/dashboard',
    element: <DashboardLayout />,
    children: [
      { index: true, element: <Navigate to="calendar" replace /> },
      { path: 'calendar', element: <CalendarPage /> },
      { path: 'bookings', element: <BookingsPage /> },
      { path: 'services', element: <ServicesPage /> },
      { path: 'staff', element: <StaffPage /> },
      { path: 'customers', element: <CustomersPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
  { path: '/:slug', element: <BookingWizard /> },
  {
    path: '/',
    element: (
      <div className="wrap">
        <div className="topbar" style={{ borderRadius: 12, marginTop: 30 }}>
          <span className="brand">Prelo <span className="accent">Booking</span></span>
          <span className="sub">Powered by JIE Mastery</span>
        </div>
        <div className="card" style={{ marginTop: 14 }}>
          <h1>Book your next appointment</h1>
          <p className="muted">Visit your shop's booking page, e.g. <a href="/demo-cuts">/demo-cuts</a>, or the <a href="/dashboard">barber dashboard</a>.</p>
        </div>
      </div>
    ),
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
