import { BrowserRouter, Route, Routes } from 'react-router'

import { AuthProvider } from './auth/AuthProvider.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { RegisterPage } from './pages/RegisterPage.tsx'
import { ShellLayout } from './pages/ShellLayout.tsx'
import {
  ContractsPage,
  DashboardPage,
  NotFoundPage,
  WalletsPage,
} from './pages/placeholders.tsx'
import { GuestOnly } from './routes/GuestOnly.tsx'
import { RequireAuth } from './routes/RequireAuth.tsx'

/**
 * Declarative routing only, with no loaders or actions. Week 8 data fetching
 * is TanStack Query, and running two data layers would mean unwinding one of
 * them later.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route path="/" element={<ShellLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="wallets" element={<WalletsPage />} />
          <Route path="contracts" element={<ContractsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}
