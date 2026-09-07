import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUniversal, useUser, useCredits, useHostedUploads, useAppFreeToken, type HostedUpload } from '@unisim/sdk'
import { usePdfStore } from '../stores/pdfStore'
import { storeCurrentPdf, deleteHostedPdf, openHostedPdf, HostedObjectMissingError } from '../lib/hostedStore'
import { downloadBackup, importBackup } from '../lib/pdfBackup'

const SIGNIN_URL = 'https://app.unisim.co.uk/login'
// Was /subscription.html until 2026-09-07, when the marketing site split its
// one pricing page in two. The token card moved to /everyday; /subscription is
// now the Assess Suite's seats and licences and sells no tokens at all — so a
// link left pointing there sends someone who wants one upload to a £5,000/year
// enterprise plan. Not a 404: it renders fine, which is why it needed finding.
const GET_TOKENS_URL = 'https://www.unisim.co.uk/everyday'

// "Store this PDF" — the free local option (already automatic via recents) plus
// the paid "Hosted by UNI·SIM" cloud option (one token per upload, refunded on
// delete) gated behind a Universal ID. Backend: 0041 + the SDK hosted helpers.
export default function HostedStoreDialog() {
  const open = usePdfStore((s) => s.hostedStoreOpen)
  const setOpen = usePdfStore((s) => s.setHostedStoreOpen)
  const doc = usePdfStore((s) => s.doc)

  const { supabase, session, activeOrgId } = useUniversal()
  const { user } = useUser()
  const { credits, refresh: refreshCredits } = useCredits()
  // Every org gets one free returnable PDF token (migration 0045) — the RPC
  // spends it before the purchased wallet, so the button gates on either.
  const { status: freeToken, refresh: refreshFreeToken } = useAppFreeToken('pdf')
  const { uploads, loading: listLoading, refresh: refreshList } = useHostedUploads('pdf')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justStored, setJustStored] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  // The id of a backup whose file turned out not to exist. Held per-row rather
  // than in `error` so the explanation and the "Remove it" button sit against
  // the entry they are about — there can be several in the list, and a message
  // at the bottom of the panel would not say which one it meant.
  const [missingId, setMissingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  if (!open) return null

  const signedIn = !!session?.user && session.user.is_anonymous !== true
  const tokens = credits ?? 0
  const canStore = freeToken === 'available' || tokens > 0

  function close() {
    setOpen(false)
    setError(null)
    setJustStored(false)
    setImportErr(null)
    setMissingId(null)
  }

  function onDownloadBackup() {
    if (!doc) return
    downloadBackup()
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked later
    if (!file) return
    setImportErr(null)
    setImportBusy(true)
    try {
      await importBackup(file)
      close() // the restored PDF + edits are now in the editor
    } catch (err) {
      setImportErr((err as Error).message)
    } finally {
      setImportBusy(false)
    }
  }

  async function onStore() {
    if (!doc || !activeOrgId || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await storeCurrentPdf(supabase, activeOrgId)
      if (!res.ok) {
        setError(
          res.error === 'no_credits'
            ? 'You have no tokens left. Get more to keep storing PDFs online.'
            : res.error ?? 'Could not store this PDF.',
        )
      } else {
        setJustStored(true)
        refreshCredits()
        refreshFreeToken()
        refreshList()
        window.setTimeout(() => setJustStored(false), 2200)
      }
    } finally {
      setBusy(false)
    }
  }

  async function onOpen(upload: HostedUpload) {
    if (busy) return
    setBusy(true)
    setError(null)
    setMissingId(null)
    try {
      await openHostedPdf(supabase, upload)
      close()
    } catch (e) {
      // A genuinely absent file is not an error to shrug at the user — it is a
      // dead entry, and the only useful thing to say is which one and what to
      // do about it. Anything else (offline, session expired) still surfaces as
      // an ordinary message, because deleting the backup would be the wrong
      // advice.
      if (e instanceof HostedObjectMissingError) setMissingId(upload.id)
      else setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(upload: HostedUpload) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await deleteHostedPdf(supabase, upload)
      if (!res.ok) setError(res.error ?? 'Could not delete this PDF.')
      else {
        setMissingId((id) => (id === upload.id ? null : id))
        refreshCredits()
        refreshFreeToken()
        refreshList()
      }
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
    >
      {/* ⚠️ One box that scrolls would take the title and the Close button with
          it. This is a flex column capped at the viewport instead, with the
          title row pinned OUTSIDE the scrolling body.
          `max-h-[min(100%,100dvh)]`: 100% is the overlay's content box and
          100dvh shrinks with iOS's browser chrome, so min() takes whichever is
          actually visible — a `vh` cap does not, because `vh` is the LARGE
          viewport on iOS. */}
      <div className="flex w-full max-w-lg max-h-[min(100%,100dvh)] flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-bold text-slate-900">Back up this PDF</h2>
          <button onClick={close} aria-label="Close" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {/* Tier 1 — Save to browser (local, temporary): automatic recents. */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">Save to browser</span>
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">Local · temporary</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              This PDF is already kept on this device automatically, so a refresh reopens it. It stays in this browser and never leaves it.
            </p>
          </div>

          {/* Tier 2 — Save to desktop: a re-importable backup file the guest keeps. */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">Save to desktop</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">Re-import later</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Download this PDF and your annotations as one backup file. Import it any time — on any device — to carry on editing exactly where you left off.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onDownloadBackup}
                disabled={!doc || importBusy}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-black disabled:opacity-50"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 16h12" />
                </svg>
                Download backup
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={importBusy}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 hover:bg-slate-50 disabled:opacity-50"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 17V7m0 0L6.5 10.5M10 7l3.5 3.5M4 4h12" />
                </svg>
                {importBusy ? 'Importing…' : 'Import a backup'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={onImportFile}
                className="hidden"
              />
            </div>
            {!doc && <p className="mt-2 text-xs text-slate-400">Open a PDF to back it up — or import a backup to restore one.</p>}
            {importErr && <p className="mt-2 text-sm text-rose-600">{importErr}</p>}
          </div>

          {/* Tier 3 — Universal subscription: paid "Hosted by UNI·SIM" cloud. */}
          <div className="rounded-xl border border-orange-200 bg-white p-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">Hosted by UNI SIM</span>
              <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-orange-700">Universal subscription</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Keep this PDF online against your Universal ID. One token per upload — delete it and your token comes straight back.
            </p>

            {!signedIn ? (
              <div className="mt-3 rounded-lg bg-slate-50 p-3">
                <p className="text-sm text-slate-700">Sign in with your <strong>Universal ID</strong> to store PDFs online.</p>
                <a href={SIGNIN_URL} className="mt-2 inline-flex rounded-lg bg-orange-700 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-800">
                  Create / sign in with Universal ID →
                </a>
              </div>
            ) : (
              <div className="mt-3">
                <div className="flex items-center justify-between rounded-lg bg-orange-50/60 px-3 py-2 text-sm">
                  <span className="text-slate-600">{user?.email}</span>
                  <span className="font-semibold text-orange-700">
                    {freeToken === 'available'
                      ? `Free token${tokens > 0 ? ` + ${tokens} purchased` : ' available'}`
                      : `${tokens} token${tokens === 1 ? '' : 's'}`}
                  </span>
                </div>

                {doc ? (
                  canStore ? (
                    <button
                      onClick={onStore}
                      disabled={busy}
                      className="mt-3 w-full rounded-lg bg-orange-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-800 disabled:opacity-50"
                    >
                      {busy ? 'Backing up…' : justStored ? '✓ Backed up' : `Back up this PDF online${freeToken === 'available' ? '' : ' (1 token)'}`}
                    </button>
                  ) : freeToken === null ? null : (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <p className="text-sm text-amber-800">
                        {freeToken === 'held'
                          ? 'Your free PDF token is in use — delete the stored PDF below to get it back, or add tokens.'
                          : 'You have no tokens left.'}
                      </p>
                      <a href={GET_TOKENS_URL} target="_blank" rel="noreferrer" className="mt-2 inline-flex rounded-lg bg-orange-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-orange-800">
                        Get tokens →
                      </a>
                    </div>
                  )
                ) : (
                  <p className="mt-3 text-xs text-slate-500">Open a PDF to back it up.</p>
                )}

                {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}

                {/* The user's hosted PDFs */}
                <div className="mt-4">
                  <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">Your backups</p>
                  {listLoading ? (
                    <p className="text-xs text-slate-400">Loading…</p>
                  ) : uploads.length === 0 ? (
                    <p className="text-xs text-slate-400">None yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {uploads.map((u) => (
                        <li key={u.id} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium text-slate-700">{u.file_name || 'document.pdf'}</span>
                              <span className="block text-[10px] text-slate-400">{new Date(u.created_at).toLocaleDateString()}</span>
                            </span>
                            <button onClick={() => onOpen(u)} disabled={busy} className="shrink-0 rounded-md bg-orange-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-800 disabled:opacity-50">Open</button>
                            <button onClick={() => onDelete(u)} disabled={busy} className="shrink-0 rounded-md px-2 py-1.5 text-xs font-medium text-slate-400 hover:text-rose-600 disabled:opacity-50" title="Delete and refund the token">Delete</button>
                          </div>

                          {/* A backup with nothing behind it. Say which file,
                              say plainly that the upload never finished, and
                              make clearing it up one click — the token comes
                              back with it, so there is nothing to lose by
                              tidying. This replaces storage's bare "Object not
                              found", which read like the app had mislaid the
                              user's document. */}
                          {missingId === u.id && (
                            <div
                              role="alert"
                              data-testid="hosted-missing"
                              className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2"
                            >
                              <p className="text-[11px] leading-snug text-amber-900">
                                <strong className="font-semibold">{u.file_name || 'document.pdf'}</strong> is listed here,
                                but there is no file behind it — this upload never finished, so nothing was ever stored.
                                Your token is still being held for it.
                              </p>
                              <button
                                type="button"
                                onClick={() => onDelete(u)}
                                disabled={busy}
                                className="mt-2 inline-flex rounded-md bg-amber-700 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
                              >
                                Remove this entry and get the token back
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
