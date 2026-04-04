import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  addScanToList,
  formatScanListForClipboard,
  totalScanCount,
  type ScanListEntry,
} from '../utils/scanList'
import { BrowserCodeReader, BrowserMultiFormatReader } from '@zxing/browser'
import type { IScannerControls } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType, type Result } from '@zxing/library'

type ScanTiming = NonNullable<
  ConstructorParameters<typeof BrowserMultiFormatReader>[1]
>

export type ZxingFormatMode = 'turbo' | 'lean' | 'full'

/** ZXing mặc định 500ms — phải override. `delayBetweenScanSuccess` quá cao → cảm giác “đơ” sau mỗi lần đọc. */
function getScanTiming(mode: ZxingFormatMode): ScanTiming {
  switch (mode) {
    case 'turbo':
      return {
        delayBetweenScanAttempts: 0,
        delayBetweenScanSuccess: 1000,
        tryPlayVideoTimeout: 9000,
      }
    case 'lean':
      return {
        delayBetweenScanAttempts: 0,
        delayBetweenScanSuccess: 1000,
        tryPlayVideoTimeout: 9000,
      }
    case 'full':
      return {
        delayBetweenScanAttempts: 0,
        delayBetweenScanSuccess: 1000,
        tryPlayVideoTimeout: 9000,
      }
  }
}

/**
 * POS thuần: ít loại nhất → mỗi khung decoder thử nhanh nhất có thể.
 * (Không có CODE_39; vẫn có QR.)
 */
const FORMATS_TURBO: BarcodeFormat[] = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.CODE_128,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.QR_CODE,
]

const FORMATS_LEAN: BarcodeFormat[] = [
  BarcodeFormat.QR_CODE,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
]

const FORMATS_FULL: BarcodeFormat[] = [
  ...FORMATS_LEAN,
  BarcodeFormat.CODE_93,
  BarcodeFormat.ITF,
  BarcodeFormat.CODABAR,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.PDF_417,
  BarcodeFormat.RSS_14,
  BarcodeFormat.RSS_EXPANDED,
]

let scanAudioCtx: AudioContext | null = null

function playTing(): void {
  if (typeof window === 'undefined') return
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    if (!AC) return
    if (!scanAudioCtx || scanAudioCtx.state === 'closed') scanAudioCtx = new AC()
    void scanAudioCtx.resume()
    const t = scanAudioCtx.currentTime
    const osc = scanAudioCtx.createOscillator()
    const g = scanAudioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1046, t)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1)
    osc.connect(g)
    g.connect(scanAudioCtx.destination)
    osc.start(t)
    osc.stop(t + 0.11)
  } catch {
    /* ignore */
  }
}

/** Ưu tiên độ phân giải + fps — một số máy báo OverconstrainedError. */
const VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: 'environment',
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
  },
}

const VIDEO_CONSTRAINTS_MID: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: 'environment',
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  },
}

/** Chỉ camera sau — tương thích rộng nhất. */
const VIDEO_CONSTRAINTS_MIN: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: 'environment' },
}

async function decodeWithFallback(
  reader: BrowserMultiFormatReader,
  video: HTMLVideoElement,
  cb: Parameters<BrowserMultiFormatReader['decodeFromConstraints']>[2],
): Promise<IScannerControls> {
  /**
   * Luôn Full HD trước: barcode 1D cần vạch sắc nét; 720p trước dễ làm mã mờ → phải xoay góc lâu.
   */
  const chain = [
    VIDEO_CONSTRAINTS,
    VIDEO_CONSTRAINTS_MID,
    VIDEO_CONSTRAINTS_MIN,
  ]
  let lastErr: unknown
  for (const c of chain) {
    try {
      return await reader.decodeFromConstraints(c, video, cb)
    } catch (e) {
      lastErr = e
      if (
        e instanceof DOMException &&
        (e.name === 'OverconstrainedError' ||
          e.name === 'ConstraintNotSatisfiedError')
      ) {
        continue
      }
      throw e
    }
  }
  throw lastErr
}

/** Gợi ý focus / phơi sáng liên tục — giảm mờ khi chưa khớp tiêu cự. */
async function applyCameraContinuousFocus(controls: IScannerControls): Promise<void> {
  const apply = controls.streamVideoConstraintsApply
  if (!apply) return
  try {
    /** DOM typings không luôn có exposureMode trong advanced — vẫn hữu ích trên Chrome/Android. */
    await apply({
      advanced: [
        { focusMode: 'continuous' },
        { exposureMode: 'continuous' },
      ],
    } as unknown as MediaTrackConstraints)
  } catch {
    /* ignore — không phải máy nào cũng hỗ trợ */
  }
}

function buildHints(
  formats: BarcodeFormat[],
  tryHarder: boolean,
): Map<DecodeHintType, unknown> {
  const hints = new Map<DecodeHintType, unknown>()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, formats)
  /** Bật = quét kỹ hơn (góc xấu, hơi mờ) — hơi tốn CPU mỗi khung. */
  if (tryHarder) {
    hints.set(DecodeHintType.TRY_HARDER, true)
  }
  return hints
}

function formatsForMode(mode: ZxingFormatMode): BarcodeFormat[] {
  switch (mode) {
    case 'turbo':
      return FORMATS_TURBO
    case 'lean':
      return FORMATS_LEAN
    case 'full':
      return FORMATS_FULL
  }
}

export default function ZxingScannerPage() {
  const [scanList, setScanList] = useState<ScanListEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  const [formatMode, setFormatMode] = useState<ZxingFormatMode>('lean')
  /** Bám mã tốt hơn khi góc / ánh sáng không lý tưởng (ZXing TRY_HARDER). */
  const [tryHarder, setTryHarder] = useState(true)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  /** Tăng mỗi khi unmount / đổi chế độ — tránh Strict Mode chạy 2 decode chồng lên nhau. */
  const scanGenRef = useRef(0)

  useLayoutEffect(() => {
    const root = document.getElementById('root')
    root?.classList.add('scanner-full')

    const myGen = ++scanGenRef.current
    const formats = formatsForMode(formatMode)
    const scanTiming = getScanTiming(formatMode)

    const hints = buildHints(formats, tryHarder)
    const reader = new BrowserMultiFormatReader(
      hints as unknown as Map<DecodeHintType, import('@zxing/library').BarcodeFormat[] | boolean>,
      scanTiming,
    )

    const onResult = (result: Result | undefined): void => {
      if (myGen !== scanGenRef.current || !result) return
      const text = result.getText()
      const fmt = String(result.getBarcodeFormat())
      setScanList((prev) => addScanToList(prev, text, fmt))
      playTing()
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(20)
      }
    }

    const videoEl = videoRef.current

    ;(async () => {
      setError(null)
      setStarting(true)
      if (!videoEl) {
        if (myGen === scanGenRef.current) setStarting(false)
        return
      }

      try {
        BrowserCodeReader.cleanVideoSource(videoEl)
      } catch {
        /* ignore */
      }

      try {
        const controls = await decodeWithFallback(reader, videoEl, onResult)
        if (myGen !== scanGenRef.current) {
          controls.stop()
          return
        }
        controlsRef.current = controls
        void applyCameraContinuousFocus(controls)
        setTorchSupported(typeof controls.switchTorch === 'function')
        setTorchOn(false)
      } catch (e) {
        if (myGen === scanGenRef.current) {
          const msg = e instanceof Error ? e.message : String(e)
          setError(
            `${msg} — Cấp quyền camera, HTTPS (hoặc localhost), thử đổi “Định dạng”.`,
          )
        }
      } finally {
        if (myGen === scanGenRef.current) setStarting(false)
      }
    })()

    return () => {
      scanGenRef.current++
      root?.classList.remove('scanner-full')
      try {
        controlsRef.current?.stop()
      } catch {
        /* ignore */
      }
      controlsRef.current = null
      if (videoEl) {
        try {
          BrowserCodeReader.cleanVideoSource(videoEl)
        } catch {
          /* ignore */
        }
      }
    }
  }, [formatMode, tryHarder])

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

  return (
    <div className="box-border flex min-h-dvh flex-col bg-linear-to-br from-[#0c1220] via-[#0a0f18] to-[#0d1520] pb-[calc(env(safe-area-inset-bottom)+12px)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-left text-[#e8e6ed]">
      <header className="shrink-0 px-4 pb-2 pt-3">
        <Link
          className="mb-2.5 inline-block py-1.5 text-[15px] text-[#8b9dc8] hover:text-[#c7d2f0]"
          to="/"
        >
          ← Trang chủ
        </Link>
        <h1 className="mb-1.5 text-2xl font-medium tracking-tight text-[#eef2ff] sm:text-[1.65rem]">
          Scanner ZXing
        </h1>
        <p className="max-w-[48ch] text-sm leading-snug text-[#8b92a8]">
          Full HD trước (vạch rõ) · đã đọc chờ{' '}
          {getScanTiming(formatMode).delayBetweenScanSuccess}
          ms · {tryHarder ? 'TRY_HARDER bật' : 'TRY_HARDER tắt'} (bám mã)
        </p>
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm text-[#9ca3af]">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0 rounded border-zinc-500 accent-emerald-500"
            checked={tryHarder}
            disabled={starting && !error}
            onChange={(e) => setTryHarder(e.target.checked)}
          />
          <span>
            <strong className="text-[#e2e8f0]">Bám mã khó (TRY_HARDER)</strong>{' '}
            — xử lý kỹ hơn mỗi khung, phù hợp khi phải xoay góc / ánh sáng yếu (hơi
            tốn CPU).
          </span>
        </label>
        <div className="mt-3 flex flex-wrap gap-2" role="group">
          <button
            type="button"
            disabled={starting && !error}
            onClick={() => setFormatMode('turbo')}
            className={`rounded-full px-3 py-1.5 text-xs font-medium sm:text-sm ${
              formatMode === 'turbo'
                ? 'bg-emerald-500/40 text-white ring-1 ring-emerald-400/50'
                : 'bg-zinc-800/90 text-[#9ca3af] ring-1 ring-zinc-600/60'
            }`}
          >
            Turbo
          </button>
          <button
            type="button"
            disabled={starting && !error}
            onClick={() => setFormatMode('lean')}
            className={`rounded-full px-3 py-1.5 text-xs font-medium sm:text-sm ${
              formatMode === 'lean'
                ? 'bg-sky-500/40 text-white ring-1 ring-sky-400/50'
                : 'bg-zinc-800/90 text-[#9ca3af] ring-1 ring-zinc-600/60'
            }`}
          >
            Tối giản
          </button>
          <button
            type="button"
            disabled={starting && !error}
            onClick={() => setFormatMode('full')}
            className={`rounded-full px-3 py-1.5 text-xs font-medium sm:text-sm ${
              formatMode === 'full'
                ? 'bg-sky-500/40 text-white ring-1 ring-sky-400/50'
                : 'bg-zinc-800/90 text-[#9ca3af] ring-1 ring-zinc-600/60'
            }`}
          >
            Đủ định dạng
          </button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[#6b7280]">
          Mẹo: giữ mã nằm ngang trong khung, cách 15–25cm, đủ sáng; tránh rung
          tay.{' '}
          <Link className="text-sky-400/90 underline" to="/scanner">
            So sánh html5-qrcode
          </Link>
        </p>
      </header>

      <div className="relative mx-3 mt-1 shrink-0 overflow-hidden rounded-2xl bg-black shadow-[0_0_0_1px_rgba(56,189,248,0.15)] sm:mx-auto sm:max-w-2xl">
        <div className="aspect-video w-full min-h-0">
          {starting && !error && (
            <div className="pointer-events-none absolute inset-0 z-2 flex items-center justify-center bg-black/60 text-sm text-sky-100/90">
              Đang mở camera…
            </div>
          )}
          {error && (
            <div
              className="pointer-events-none absolute inset-0 z-2 flex items-center justify-center bg-red-950/80 p-4 text-center text-sm text-red-100"
              role="alert"
            >
              {error}
            </div>
          )}
          {/* Không dùng autoPlay — ZXing tự gọi play(); tránh AbortError / "already playing". */}
          <video
            ref={videoRef}
            className="size-full object-cover"
            muted
            playsInline
          />
        </div>
        {torchSupported && !error && (
          <div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2">
            <button
              type="button"
              onClick={() => {
                const c = controlsRef.current
                if (!c?.switchTorch) return
                const next = !torchOn
                void c.switchTorch(next).then(() => setTorchOn(next))
              }}
              className={`rounded-full px-4 py-2 text-sm font-medium shadow-lg ${
                torchOn
                  ? 'bg-amber-400 text-zinc-900'
                  : 'bg-zinc-800/90 text-amber-100 ring-1 ring-amber-500/40'
              }`}
            >
              {torchOn ? 'Tắt đèn' : 'Đèn (tối)'}
            </button>
          </div>
        )}
      </div>

      <section className="mx-3 mt-4 flex min-h-0 flex-1 flex-col rounded-2xl border border-sky-500/20 bg-[rgba(15,23,42,0.85)] p-4 backdrop-blur-md sm:mx-auto sm:mt-5 sm:max-w-2xl">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-xs uppercase tracking-wide text-[#64748b]">
              Danh sách mã
            </p>
            <span className="text-sm text-[#94a3b8]">
              Tổng lượt quét:{' '}
              <strong className="font-semibold text-sky-200">{totalScans}</strong>
            </span>
          </div>
          {scanList.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-lg border border-sky-400/40 bg-sky-500/15 px-3 py-1.5 text-sm text-sky-100 active:scale-[0.98]"
                onClick={() => void copyAll()}
              >
                Sao chép tất cả
              </button>
              <button
                type="button"
                className="rounded-lg border border-zinc-500/50 bg-zinc-800/80 px-3 py-1.5 text-sm text-[#94a3b8] active:scale-[0.98]"
                onClick={clearList}
              >
                Xóa danh sách
              </button>
            </div>
          )}
        </div>
        <div className="max-h-[min(50vh,320px)] min-h-0 overflow-y-auto">
          {scanList.length > 0 ? (
            <ul className="space-y-2 pr-1">
              {scanList.map((row) => (
                <li
                  key={row.text}
                  className="rounded-lg border border-sky-500/15 bg-black/35 px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <code className="block flex-1 whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-emerald-200">
                      {row.text}
                    </code>
                    <span className="shrink-0 rounded-md bg-sky-500/25 px-2 py-0.5 text-xs font-semibold tabular-nums text-sky-100">
                      ×{row.count}
                    </span>
                  </div>
                  {row.format && (
                    <p className="mt-1 font-mono text-[11px] text-sky-300/85">
                      {row.format}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-sm text-[#64748b]">
              Giữ mã nằm ngang — quét để lưu (trùng mã thì tăng số lần). Nếu lâu
              không đọc — bật “Bám mã khó” hoặc đèn.
            </span>
          )}
        </div>
      </section>
    </div>
  )
}
