import { AnimatePresence } from 'framer-motion'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { PageMotion } from '@/components/PageMotion'
import { RequireAuth } from '@/components/RequireAuth'
import { BoardPage } from '@/pages/Board'
import { DashboardPage } from '@/pages/Dashboard'
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AnimatePresence>
  )
}
