import { AnimatePresence } from 'framer-motion'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { PageMotion } from '@/components/PageMotion'
import { RequireAuth } from '@/components/RequireAuth'
import { BoardPage } from '@/pages/Board'
import { DashboardPage } from '@/pages/Dashboard'
import { KitPage } from '@/pages/Kit'
import { KitsPage } from '@/pages/Kits'
import { LibraryPage } from '@/pages/Library'
import { SettingsPage } from '@/pages/Settings'
import { SharePage } from '@/pages/Share'
import { SignInPage } from '@/pages/SignIn'
import { SignUpPage } from '@/pages/SignUp'

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AnimatedRoutes />
      </BrowserRouter>
    </ErrorBoundary>
  )
}

// Routes inside BrowserRouter so useLocation() resolves. AnimatePresence
// mode="wait" makes the exit complete before the new page mounts — keeps
// the fade clean instead of crossing two routes mid-flight.
function AnimatedRoutes() {
  const location = useLocation()
  return (
    <AnimatePresence mode="wait" initial={false}>
      <Routes location={location} key={location.pathname}>
        <Route
          path="/sign-in"
          element={
            <PageMotion>
              <SignInPage />
            </PageMotion>
          }
        />
        <Route
          path="/sign-up"
          element={
            <PageMotion>
              <SignUpPage />
            </PageMotion>
          }
        />
        <Route
          path="/"
          element={
            <RequireAuth>
              <PageMotion>
                <DashboardPage />
              </PageMotion>
            </RequireAuth>
          }
        />
        <Route
          path="/board/:id"
          element={
            <RequireAuth>
              <PageMotion>
                <BoardPage />
              </PageMotion>
            </RequireAuth>
          }
        />
        <Route
          path="/kits"
          element={
            <RequireAuth>
              <PageMotion>
                <KitsPage />
              </PageMotion>
            </RequireAuth>
          }
        />
        <Route
          path="/kits/:id"
          element={
            <RequireAuth>
              <PageMotion>
                <KitPage />
              </PageMotion>
            </RequireAuth>
          }
        />
        <Route
          path="/library"
          element={
            <RequireAuth>
              <PageMotion>
                <LibraryPage />
              </PageMotion>
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <PageMotion>
                <SettingsPage />
              </PageMotion>
            </RequireAuth>
          }
        />
        {/* Public — no RequireAuth. Anyone with the token can view. */}
        <Route
          path="/share/:token"
          element={
            <PageMotion>
              <SharePage />
            </PageMotion>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AnimatePresence>
  )
}
