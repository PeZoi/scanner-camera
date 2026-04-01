import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'

const READER_ID = 'qr-reader'

/** html5-qrcode yêu cầu mỗi chiều qrbox ≥ 50px. */
const MIN_QR_BOX = 50

/** Tốc độ quét (FPS) — cao hơn mặc định (~10) để phản hồi gần máy quét. */
const SCAN_FPS = 25

/** FPS khi bật chế độ decode nhanh (nhiều khung hơn / giây — tốn CPU hơn). */
const SCAN_FPS_FAST = 30

/** Sau mỗi lần đọc mã thành công: chờ trước khi cho quét tiếp (tránh trùng lặp). */
const COOLDOWN_MS = 1000

let scanSuccessAudioCtx: AudioContext | null = null

/** Tiếng "ting" ngắn (Web Audio — không cần file .mp3). */
function playScanSuccessTing(): void {
  if (typeof window === 'undefined') return
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    if (!AC) return
    if (!scanSuccessAudioCtx || scanSuccessAudioCtx.state === 'closed') {
      scanSuccessAudioCtx = new AC()
    }
    const ctx = scanSuccessAudioCtx
    void ctx.resume()
    const t0 = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1046.5, t0)
    osc.frequency.exponentialRampToValueAtTime(1568, t0 + 0.07)
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(0.11, t0 + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + 0.12)
  } catch {
    /* ignore */
  }
}

/** Độ phân giải ưu tiên: barcode rõ nét hơn (camera sẽ tự giảm nếu không hỗ trợ). */
const VIDEO_IDEAL = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30, max: 30 },
} as const

/**
 * Focus / phơi sáng liên tục — hỗ trợ quét trong điều kiện ánh sáng yếu & barcode mờ.
 * Một số trình duyệt bỏ qua key không hỗ trợ; nếu getUserMedia lỗi sẽ fallback.
 * (DOM typings không khai báo đủ — cast qua unknown.)
 */
function buildPremiumVideoConstraints(): MediaTrackConstraints {
  const advanced = [
    { focusMode: 'continuous' },
    { exposureMode: 'continuous' },
    { whiteBalanceMode: 'continuous' },
  ] as unknown as MediaTrackConstraintSet[]
  return {
    facingMode: 'environment',
    ...VIDEO_IDEAL,
    advanced,
  }
}

const FORMATS_POS: Html5QrcodeSupportedFormats[] = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.CODABAR,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
  Html5QrcodeSupportedFormats.PDF_417,
]

/**
 * Ít định dạng hơn → mỗi khung hình decoder thử ít loại mã hơn → thường nhanh hơn.
 * Bỏ ITF, Codabar, PDF417, Data Matrix, Code93 nếu bạn không cần.
 */
const FORMATS_LEAN: Html5QrcodeSupportedFormats[] = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
]

/** Vùng quét vuông — ổn cho QR, Data Matrix. */
function qrboxSquare(
  viewfinderWidth: number,
  viewfinderHeight: number,
): { width: number; height: number } {
  const minEdge = Math.min(viewfinderWidth, viewfinderHeight)
  if (minEdge < MIN_QR_BOX) {
    return { width: MIN_QR_BOX, height: MIN_QR_BOX }
  }
  const size = Math.max(
    MIN_QR_BOX,
    Math.min(Math.floor(minEdge * 0.72), minEdge),
  )
  return { width: size, height: size }
}

/**
 * Vùng quét ngang (dải rộng) — barcode 1D (EAN, Code128…) cần chiều ngang đủ.
 */
function qrboxHorizontal(
  viewfinderWidth: number,
  viewfinderHeight: number,
): { width: number; height: number } {
  const w = viewfinderWidth
  const h = viewfinderHeight
  const boxW = Math.max(MIN_QR_BOX, Math.floor(w * 0.88))
  const boxH = Math.max(
    MIN_QR_BOX,
    Math.floor(Math.min(h * 0.45, boxW / 2.4)),
  )
  const finalW = Math.min(boxW, w)
  const finalH = Math.min(boxH, h)
  if (finalW < MIN_QR_BOX || finalH < MIN_QR_BOX) {
    return { width: MIN_QR_BOX, height: MIN_QR_BOX }
  }
  return { width: finalW, height: finalH }
}

export type ScanFrameMode = 'horizontal' | 'square'

const FRAME_MODES: Record<
  ScanFrameMode,
  { aspectRatio: number; qrbox: typeof qrboxSquare; label: string; hint: string }
> = {
  horizontal: {
    aspectRatio: 16 / 9,
    qrbox: qrboxHorizontal,
    label: 'Ngang · barcode',
    hint: 'Khung dải — tối ưu mã vạch 1D',
  },
  square: {
    aspectRatio: 4 / 3,
    qrbox: qrboxSquare,
    label: 'Vuông · QR',
    hint: 'Khung cân — tối ưu QR / mã 2D',
  },
}

export default function ScannerPage() {
  const [lastText, setLastText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [frameMode, setFrameMode] = useState<ScanFrameMode>('horizontal')
  /** Ít format + FPS cao — ưu tiên tốc độ, bỏ một số loại mã. */
  const [fastDecode, setFastDecode] = useState(false)

  const scannerRef = useRef<Html5Qrcode | null>(null)
  const effectiveFps = fastDecode ? SCAN_FPS_FAST : SCAN_FPS

  useEffect(() => {
    const root = document.getElementById('root')
    root?.classList.add('scanner-full')

    let cancelled = false
    const formats = fastDecode ? FORMATS_LEAN : FORMATS_POS
    const scanner = new Html5Qrcode(READER_ID, {
      verbose: false,
      formatsToSupport: formats,
      useBarCodeDetectorIfSupported: true,
    })
    scannerRef.current = scanner

    let gateOpen = true
    let cooldownTimer: ReturnType<typeof setTimeout> | null = null

    const safeShutdown = () => {
      if (cooldownTimer !== null) {
        clearTimeout(cooldownTimer)
        cooldownTimer = null
      }
      gateOpen = true
      try {
        if (scanner.isScanning) {
          scanner
            .stop()
            .then(() => {
              try {
                scanner.clear()
              } catch {
                /* ignore */
              }
            })
            .catch(() => {})
        } else {
          try {
            scanner.clear()
          } catch {
            /* ignore */
          }
        }
      } catch {
        try {
          scanner.clear()
        } catch {
          /* ignore */
        }
      }
    }

    const run = async () => {
      setError(null)
      setStarting(true)
      setTorchSupported(false)
      setTorchOn(false)

      const frame = FRAME_MODES[frameMode]
      const baseConfig = {
        fps: fastDecode ? SCAN_FPS_FAST : SCAN_FPS,
        qrbox: frame.qrbox,
        aspectRatio: frame.aspectRatio,
      } as const

      const tryStart = async (usePremiumConstraints: boolean) => {
        await scanner.start(
          { facingMode: 'environment' },
          usePremiumConstraints
            ? { ...baseConfig, videoConstraints: buildPremiumVideoConstraints() }
            : baseConfig,
          (decodedText) => {
            if (cancelled || !gateOpen) return
            gateOpen = false
            setLastText(decodedText)
            playScanSuccessTing()
            if (typeof navigator !== 'undefined' && navigator.vibrate) {
              navigator.vibrate(25)
            }
            try {
              scanner.pause(false)
            } catch {
              gateOpen = true
              return
            }
            cooldownTimer = setTimeout(() => {
              cooldownTimer = null
              if (cancelled) {
                gateOpen = true
                return
              }
              try {
                scanner.resume()
              } catch {
                /* ignore */
              }
              gateOpen = true
            }, COOLDOWN_MS)
          },
          () => {},
        )
      }

      try {
        try {
          await tryStart(true)
        } catch (first) {
          if (cancelled) return
          const retry =
            first instanceof DOMException &&
            (first.name === 'OverconstrainedError' ||
              first.name === 'ConstraintNotSatisfiedError')
          if (retry) {
            await tryStart(false)
          } else {
            throw first
          }
        }
        if (cancelled) {
          safeShutdown()
          return
        }
        try {
          const caps = scanner.getRunningTrackCameraCapabilities()
          setTorchSupported(caps.torchFeature().isSupported())
          setTorchOn(false)
        } catch {
          setTorchSupported(false)
        }
      } catch (e) {
        if (cancelled) {
          safeShutdown()
          return
        }
        const msg =
          e instanceof Error ? e.message : 'Không thể mở camera.'
        setError(
          `${msg} — Thử cấp quyền camera hoặc dùng HTTPS / localhost.`,
        )
      } finally {
        if (!cancelled) setStarting(false)
      }
    }

    run()

    return () => {
      cancelled = true
      root?.classList.remove('scanner-full')
      setTorchSupported(false)
      setTorchOn(false)
      scannerRef.current = null
      safeShutdown()
    }
  }, [frameMode, fastDecode])

  const toggleTorch = useCallback(() => {
    const scanner = scannerRef.current
    if (!scanner?.isScanning) return
    try {
      const torch = scanner.getRunningTrackCameraCapabilities().torchFeature()
      if (!torch.isSupported()) return
      const next = !torchOn
      void torch.apply(next).then(() => setTorchOn(next))
    } catch {
      /* ignore */
    }
  }, [torchOn])

  const copyResult = async () => {
    if (!lastText) return
    try {
      await navigator.clipboard.writeText(lastText)
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="box-border flex min-h-dvh flex-col bg-linear-to-br from-[#12141c] via-[#0a0b10] to-[#0f1118] pb-[calc(env(safe-area-inset-bottom)+12px)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-left text-[#e8e6ed]"
    >
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
        <p className="max-w-[40ch] text-sm leading-snug text-[#8b8799]">
          {effectiveFps} FPS
          {fastDecode ? ' · decode nhanh (ít định dạng)' : ''} ·{' '}
          {FRAME_MODES[frameMode].hint}
        </p>
        <div
          className="mt-3 flex flex-wrap gap-2"
          role="group"
          aria-label="Chế độ khung quét"
        >
          {(Object.keys(FRAME_MODES) as ScanFrameMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={starting && !error}
              onClick={() => setFrameMode(mode)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition sm:text-sm ${
                frameMode === mode
                  ? 'bg-purple-500/35 text-white ring-1 ring-purple-400/60'
                  : 'bg-zinc-800/80 text-[#b4abc4] ring-1 ring-zinc-600/60 hover:bg-zinc-700/80'
              } disabled:opacity-50`}
            >
              {FRAME_MODES[mode].label}
            </button>
          ))}
        </div>
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-[#a39ab8]">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0 rounded border-zinc-500 accent-purple-500"
            checked={fastDecode}
            disabled={starting && !error}
            onChange={(e) => setFastDecode(e.target.checked)}
          />
          <span>
            <strong className="text-[#e4dff0]">Decode nhanh</strong> — 30 FPS,
            chỉ QR + EAN + Code128/39 + UPC (bỏ ITF, Codabar, PDF417, Data
            Matrix…). Tắt nếu cần đủ loại mã.
          </span>
        </label>
      </header>

      <div
        className={`relative mx-3 mt-1 shrink-0 overflow-hidden rounded-2xl bg-[#050508] shadow-[0_0_0_1px_rgba(192,132,252,0.12),0_20px_50px_-20px_rgba(0,0,0,0.85)] sm:mx-auto ${
          frameMode === 'horizontal' ? 'max-w-2xl' : 'max-w-lg'
        }`}
      >
        <div
          className={`w-full min-h-0 ${
            frameMode === 'horizontal' ? 'aspect-video' : 'aspect-4/3'
          }`}
        >
          {starting && !error && (
            <div
              className="pointer-events-none absolute inset-0 z-2 flex items-center justify-center bg-[rgba(5,5,8,0.55)] p-5 text-center text-[15px] text-[#d4c8e8]"
              aria-live="polite"
            >
              Đang bật camera…
            </div>
          )}
          {error && (
            <div
              className="pointer-events-none absolute inset-0 z-2 flex items-center justify-center bg-[rgba(40,12,20,0.88)] p-5 text-center text-[15px] leading-relaxed text-red-200"
              role="alert"
            >
              {error}
            </div>
          )}
          <div
            id={READER_ID}
            className="size-full min-h-0 [&_video]:h-full! [&_video]:w-full! [&_video]:rounded-xl [&_video]:object-cover"
          />
        </div>
        {torchSupported && !error && (
          <div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2">
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

      <section
        className="mx-3 mt-4 shrink-0 rounded-2xl border border-purple-500/15 bg-[rgba(30,28,42,0.85)] p-4 backdrop-blur-md sm:mx-auto sm:mt-5 sm:max-w-lg"
        aria-live="polite"
      >
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <span className="text-xs uppercase tracking-[0.08em] text-[#9b92b0]">
            Kết quả gần nhất
          </span>
          {lastText && (
            <button
              type="button"
              className="cursor-pointer rounded-lg border border-purple-400/35 bg-purple-500/10 px-3 py-1.5 text-sm text-[#e9d5ff] active:scale-[0.98]"
              onClick={copyResult}
            >
              Sao chép
            </button>
          )}
        </div>
        <div className="wrap-break-word">
          {lastText ? (
            <code className="block whitespace-pre-wrap rounded-lg bg-black/35 px-3 py-2.5 font-mono text-sm leading-relaxed text-[#c8f5c4]">
              {lastText}
            </code>
          ) : (
            <span className="text-sm text-[#6d6578]">
              Chưa có dữ liệu — quét để thử
            </span>
          )}
        </div>
      </section>
    </div>
  )
}
