import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
/**
 * Classic scanner: `createBarcodeScanner` nhận **object cấu hình** (theo
 * [Classic UI](https://docs.scanbot.io/web/barcode-scanner-sdk/barcode-scanner/classic-scanner-ui/)).
 * Không dùng `new ScanbotSDK.Config.BarcodeScannerViewConfiguration()` — trên bundle thực tế
 * constructor đó có thể `undefined` (không phải do trial; trial chỉ giới hạn license, không xóa API).
 */
import ScanbotSDK from 'scanbot-web-sdk/ui'
import type { BarcodeScannerResultWithSize } from 'scanbot-web-sdk/@types/model/barcode/barcode-result'
import type { BarcodeScannerViewConfiguration } from 'scanbot-web-sdk/@types/model/configuration/barcode-scanner-view-configuration'
import type { IBarcodeScannerHandle } from 'scanbot-web-sdk/@types/interfaces/i-barcode-scanner-handle'
import { scanbotEnginePath } from '../scanbot/engine'
import {
  addScanToList,
  formatScanListForClipboard,
  totalScanCount,
  type ScanListEntry,
} from '../utils/scanList'
import { playClassicPosBeep } from '../utils/scanBeep'

const CONTAINER_ID = 'scanbot-barcode-container'

function licenseKeyFromEnv(): string {
  const k = import.meta.env.VITE_SCANBOT_LICENSE_KEY
  return typeof k === 'string' ? k : ''
}

function formatScanbotError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const origin =
    typeof window !== 'undefined' ? window.location.origin : ''
  if (/license/i.test(msg)) {
    return [
      msg,
      '',
      'License trial thường gắn với domain/host đã đăng ký.',
      `Host hiện tại: ${origin}`,
      'Thử http://localhost:… thay vì 127.0.0.1 nếu chưa đăng ký IP.',
      'https://docs.scanbot.io/trial/',
    ].join('\n')
  }
  return msg
}

/** Tránh cập nhật UI/spam khi cùng một mã trong nhiều khung liên tiếp. */
const SAME_CODE_COOLDOWN_MS = 900

export default function ScanbotBarcodePage() {
  const [scanList, setScanList] = useState<ScanListEntry[]>([])
  const [status, setStatus] = useState<'idle' | 'initializing' | 'running' | 'error'>('idle')
  const [hint, setHint] = useState<string | null>(null)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)

  const handleRef = useRef<IBarcodeScannerHandle | null>(null)
  const lastCodeAtRef = useRef<{ text: string; at: number }>({ text: '', at: 0 })
  const scanGenRef = useRef(0)

  useEffect(() => {
    const root = document.getElementById('root')
    root?.classList.add('scanner-full')
    return () => root?.classList.remove('scanner-full')
  }, [])

  const toggleTorch = useCallback(() => {
    const h = handleRef.current
    if (!h) return
    const next = !torchOn
    void h.setTorchState(next).then(() => setTorchOn(next))
  }, [torchOn])

  useEffect(() => {
    const myGen = ++scanGenRef.current
    let cancelled = false

    const run = async () => {
      setHint(null)
      setStatus('initializing')

      if (!document.getElementById(CONTAINER_ID)) {
        if (myGen === scanGenRef.current) {
          setStatus('error')
          setHint('Không tìm thấy container camera.')
        }
        return
      }

      try {
        const sdk = await ScanbotSDK.initialize({
          licenseKey: licenseKeyFromEnv(),
          enginePath: scanbotEnginePath(),
          verboseLogging: false,
        })
        if (cancelled || myGen !== scanGenRef.current) return

        /**
         * Classic `createBarcodeScanner` không áp dụng `Sound`/`Vibration` (chỉ RTU
         * `ScanbotSDK.UI.createBarcodeScanner` mới có). Bíp phát trong `onBarcodesDetected`.
         */
        const viewConfig = {
          containerId: CONTAINER_ID,
          previewMode: 'FILL_IN' as const,
          backgroundColor: '#050508',
          /** Ẩn dòng chữ kiểu “Move the finder over a barcode” trên preview. */
          userGuidance: { visible: false },
          /** Khung quét ngang (16:9) — hợp QR và mã vạch 1D dạng dải. */
          finder: {
            _type: 'ViewFinderConfiguration' as const,
            visible: true,
            aspectRatio: { width: 16, height: 9 },
          },
          videoConstraints: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30, max: 30 },
          },
          captureDelay: 750,
          scannerConfiguration: {
            engineMode: 'NEXT_GEN' as const,
          },
          onBarcodesDetected: (e: BarcodeScannerResultWithSize) => {
            if (e.isEmpty() || !e.barcodes.length) return
            const bar = e.barcodes[0]
            const text = bar.text
            const now = Date.now()
            const { text: prev, at } = lastCodeAtRef.current
            if (text === prev && now - at < SAME_CODE_COOLDOWN_MS) return
            lastCodeAtRef.current = { text, at: now }

            playClassicPosBeep()
            if (typeof navigator !== 'undefined' && navigator.vibrate) {
              navigator.vibrate(25)
            }
            setScanList((prev) =>
              addScanToList(prev, text, String(bar.format)),
            )
          },
          onError: (err: unknown) => {
            console.error('[Scanbot]', err)
          },
        } as unknown as BarcodeScannerViewConfiguration

        const handle = await sdk.createBarcodeScanner(viewConfig)
        if (cancelled || myGen !== scanGenRef.current) {
          handle.dispose()
          return
        }

        handleRef.current = handle
        setStatus('running')
        try {
          const caps = handle.getCapabilities?.() as MediaTrackCapabilities & {
            torch?: boolean
          }
          setTorchSupported(Boolean(caps?.torch))
        } catch {
          setTorchSupported(false)
        }
        setTorchOn(false)
      } catch (e) {
        if (myGen === scanGenRef.current) {
          setStatus('error')
          setHint(formatScanbotError(e))
        }
      }
    }

    void run()

    return () => {
      cancelled = true
      try {
        handleRef.current?.dispose()
      } catch {
        /* ignore */
      }
      handleRef.current = null
      lastCodeAtRef.current = { text: '', at: 0 }
    }
  }, [])

  const copyAll = async () => {
    if (!scanList.length) return
    try {
      await navigator.clipboard.writeText(formatScanListForClipboard(scanList))
    } catch {
      /* ignore */
    }
  }

  const clearList = () => setScanList([])
  const totalScans = totalScanCount(scanList)

  const showError = status === 'error' && hint
  const showLoading = status === 'initializing'

  return (
    <div className="box-border flex min-h-dvh flex-col bg-linear-to-br from-[#12141c] via-[#0a0b10] to-[#0f1118] pb-[calc(env(safe-area-inset-bottom)+12px)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-left text-[#e8e6ed]">
      <header className="shrink-0 px-4 pb-2 pt-3">
        <Link
          className="mb-2.5 inline-block py-1.5 text-[15px] text-[#c4b8dc] hover:text-[#e9d5ff]"
          to="/"
        >
          ← Trang chủ
        </Link>
        <h1 className="mb-1.5 text-2xl font-medium tracking-tight text-[#f3f0f8] sm:text-[1.65rem]">
          Quét QR / mã vạch
        </h1>
        <p className="max-w-[48ch] text-sm leading-snug text-[#8b8799]">
          Scanbot Classic · camera trong khung · quét liên tục (onBarcodesDetected)
        </p>
        <p className="mt-2 text-xs leading-relaxed text-[#6d6578]">
          Cần <code className="rounded bg-black/40 px-1">VITE_SCANBOT_LICENSE_KEY</code>.{' '}
          <a
            className="text-[#c4b8dc] underline"
            href="https://docs.scanbot.io/web/barcode-scanner-sdk/introduction/"
            target="_blank"
            rel="noreferrer"
          >
            Tài liệu
          </a>
        </p>
      </header>

      <div className="relative mx-3 mt-1 shrink-0 overflow-hidden rounded-2xl bg-[#050508] shadow-[0_0_0_1px_rgba(192,132,252,0.12),0_20px_50px_-20px_rgba(0,0,0,0.85)] sm:mx-auto sm:max-w-2xl">
        <div className="relative aspect-video w-full min-h-[220px]">
          <div
            id={CONTAINER_ID}
            className="absolute inset-0 z-0 size-full min-h-0 [&_video]:h-full! [&_video]:w-full! [&_video]:object-cover"
          />
          {showLoading && (
            <div
              className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[rgba(5,5,8,0.75)] p-6 text-center"
              aria-live="polite"
            >
              <p className="text-[15px] text-[#d4c8e8]">Đang tải engine &amp; camera…</p>
            </div>
          )}
          {showError && (
            <div
              className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[rgba(40,12,20,0.9)] p-5 text-center text-[13px] leading-relaxed text-red-200"
              role="alert"
            >
              {hint}
            </div>
          )}
          {status === 'running' && torchSupported && !showError && (
            <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2">
              <button
                type="button"
                onClick={toggleTorch}
                className={`rounded-full px-4 py-2 text-sm font-medium shadow-lg transition ${
                  torchOn
                    ? 'bg-amber-400 text-zinc-900'
                    : 'bg-zinc-800/90 text-amber-100 ring-1 ring-amber-500/40'
                }`}
              >
                {torchOn ? 'Tắt đèn' : 'Bật đèn (tối)'}
              </button>
            </div>
          )}
        </div>
      </div>

      <section
        className="mx-3 mt-4 flex min-h-0 flex-1 flex-col rounded-2xl border border-purple-500/15 bg-[rgba(30,28,42,0.85)] p-4 backdrop-blur-md sm:mx-auto sm:mt-5 sm:max-w-2xl"
        aria-live="polite"
      >
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xs uppercase tracking-[0.08em] text-[#9b92b0]">
              Danh sách mã
            </span>
            <span className="text-sm text-[#a89bc4]">
              Tổng lượt quét:{' '}
              <strong className="font-semibold text-[#e9d5ff]">{totalScans}</strong>
            </span>
          </div>
          {scanList.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-lg border border-purple-400/35 bg-purple-500/10 px-3 py-1.5 text-sm text-[#e9d5ff] active:scale-[0.98]"
                onClick={() => void copyAll()}
              >
                Sao chép tất cả
              </button>
              <button
                type="button"
                className="rounded-lg border border-zinc-500/50 bg-zinc-800/80 px-3 py-1.5 text-sm text-[#c4b8dc] active:scale-[0.98]"
                onClick={clearList}
              >
                Xóa danh sách
              </button>
            </div>
          )}
        </div>
        <div className="max-h-[min(50vh,320px)] min-h-0 overflow-y-auto wrap-break-word">
          {scanList.length > 0 ? (
            <ul className="space-y-2 pr-1">
              {scanList.map((row) => (
                <li
                  key={row.text}
                  className="rounded-lg border border-purple-500/10 bg-black/30 px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <code className="block flex-1 whitespace-pre-wrap font-mono text-sm leading-relaxed text-[#c8f5c4]">
                      {row.text}
                    </code>
                    <span className="shrink-0 rounded-md bg-purple-500/25 px-2 py-0.5 text-xs font-semibold tabular-nums text-[#e9d5ff]">
                      ×{row.count}
                    </span>
                  </div>
                  {row.format && (
                    <p className="mt-1 font-mono text-[11px] text-purple-300/80">
                      {row.format}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-sm text-[#6d6578]">
              {status === 'running'
                ? 'Hướng camera vào mã — quét để lưu (trùng mã thì tăng số lần).'
                : showError
                  ? 'Xem lỗi phía trên'
                  : 'Đang khởi động…'}
            </span>
          )}
        </div>
      </section>
    </div>
  )
}
