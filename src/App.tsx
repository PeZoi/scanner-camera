import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import HomePage from './pages/HomePage'

const ScannerPage = lazy(() => import('./pages/ScannerPage'))
const ZxingScannerPage = lazy(() => import('./pages/ZxingScannerPage'))
const ScanbotBarcodePage = lazy(() => import('./pages/ScanbotBarcodePage'))

function ScannerFallback() {
  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'grid',
        placeItems: 'center',
        background: '#0a0b10',
        color: '#9b92b0',
        fontSize: 15,
      }}
    >
      Đang tải scanner…
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route
        path="/scanner"
        element={
          <Suspense fallback={<ScannerFallback />}>
            <ScannerPage />
          </Suspense>
        }
      />
      <Route
        path="/scanner-zxing"
        element={
          <Suspense fallback={<ScannerFallback />}>
            <ZxingScannerPage />
          </Suspense>
        }
      />
      <Route
        path="/scanner-scanbot"
        element={
          <Suspense fallback={<ScannerFallback />}>
            <ScanbotBarcodePage />
          </Suspense>
        }
      />
    </Routes>
  )
}
