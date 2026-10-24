import { BrowserRouter, Route, Routes } from 'react-router'
import type { QueryClient } from '@tanstack/react-query'

import { AuthProvider } from './auth/AuthProvider.tsx'
import { QueryProvider } from './data/QueryProvider.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { OverviewPage } from './pages/OverviewPage.tsx'
import { RegisterPage } from './pages/RegisterPage.tsx'
import { ShellLayout } from './pages/ShellLayout.tsx'
import { WalletsPage } from './pages/WalletsPage.tsx'
import { ContractsPage } from './pages/ContractsPage.tsx'
import { NotFoundPage } from './pages/placeholders.tsx'
import { GuestOnly } from './routes/GuestOnly.tsx'
import { RequireAuth } from './routes/RequireAuth.tsx'

/**
 * Declarative routing only, with no loaders or actions: server state is TanStack
 * Query's, and running two data layers would mean unwinding one of them later.
 *
 * The query provider sits inside the auth provider and around the routes, so no
 * data view can mount without an identity and none can outlive one.
 */
/**
 * `queryClient` is a seam for tests. The application builds its own, and the
 * only reason to pass one is to look inside the cache afterwards.
 */
export function AppRoutes({ queryClient }: { queryClient?: QueryClient } = {}) {
  return (
    <QueryProvider client={queryClient}>
      <Routes>
        <Route element={<GuestOnly />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
        </Route>

        <Route element={<RequireAuth />}>
          <Route path="/" element={<ShellLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="wallets" element={<WalletsPage />} />
            <Route path="contracts" element={<ContractsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </QueryProvider>
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
