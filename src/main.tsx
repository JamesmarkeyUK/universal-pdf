import React from 'react'
import ReactDOM from 'react-dom/client'
import { UniversalProvider } from '@unisim/sdk'

console.log(`build: ${import.meta.env.VITE_BUILD_SHA}`)
import App from './App'
import SignMobilePage from './components/Signature/SignMobilePage'
import SignRequestPage from './components/Signature/SignRequestPage'
import SignCertificatePage from './components/Signature/SignCertificatePage'
import { UsageTracker } from '@unisim/sdk'
import ErrorBoundary from './components/ErrorBoundary'
import { usePdfStore } from './stores/pdfStore'
import { useAnnotationStore } from './stores/annotationStore'
import { useSignatureStore } from './stores/signatureStore'
import './index.css'
import './styles/xfa.css'
import './styles/textlayer.css'

if (import.meta.env.DEV) {
  ;(window as unknown as { __stores: unknown }).__stores = {
    pdf: usePdfStore,
    ann: useAnnotationStore,
    sig: useSignatureStore
  }
}

// The packaged Electron renderer loads index.html over file://, which has
// no parent zone to scope a cookie to — leave cookieDomain undefined so the
// SDK falls back to localStorage. The browser web build (Vite mode
// 'production') still rides the shared .unisim.co.uk cookie.
const isDesktop = import.meta.env.MODE === 'desktop'

// `?mockauth=1` in a DEV build only: the SDK serves its offline fixture world
// (james@unisim.co.uk / KyJam91, org "UNI·SIM Demo") instead of the real
// Supabase project, so the signed-in chrome — the profile dropdown, the company
// badge, the hosted-backup gate — can be opened and driven with no network and
// no real account. `e2e/actions-menu.e2e.mjs` runs on it.
//
// ⚠️ Deliberately opt-in per page load AND fenced behind `import.meta.env.DEV`,
// which is statically false in every shipped build, so the flag cannot be typed
// into a URL in the packaged desktop app or on the website. The SDK adds a
// second guard of its own (mockAuth is ignored whenever `cookieDomain` is set).
const mockAuth =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has('mockauth')

const universalConfig = {
  supabaseUrl: import.meta.env.VITE_PLATFORM_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_PLATFORM_SUPABASE_ANON_KEY,
  product: 'pdf' as const,
  cookieDomain: !isDesktop && import.meta.env.PROD ? '.unisim.co.uk' : undefined,
  mockAuth,
}

// `?sign=<token>` is the phone-side of the sign-on-mobile handoff (opened by
// scanning the QR in the signature pad) — render just the signing page.
// `?signdoc=<token>` is a "Send to sign" recipient link — the full editor with
// the sender's stored PDF loaded and a sign-and-return banner.
// `?cert=<cert_id>` is the public tamper-evident certificate page for a signed
// document (preview + download + timestamped provenance log).
const params = new URLSearchParams(window.location.search)
const signToken = params.get('sign')
const signDocToken = params.get('signdoc')
const certId = params.get('cert')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <UniversalProvider config={universalConfig}>
        <UsageTracker />
        {signToken ? <SignMobilePage token={signToken} />
          : signDocToken ? <SignRequestPage token={signDocToken} />
          : certId ? <SignCertificatePage certId={certId} />
          : <App />}
      </UniversalProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
