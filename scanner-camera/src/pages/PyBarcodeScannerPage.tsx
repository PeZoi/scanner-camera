import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  addScanToList,
  formatScanListForClipboard,
  totalScanCount,
  type ScanListEntry,
} from '../utils/scanList'
import { playClassicPosBeep } from '../utils/scanBeep'
import { passesStrictGtinChecksum } from '../utils/barcodeChecksum'

/** Sau mỗi lần ghi nhận mã (beep): không gửi khung / không nhận quét tiếp trong khoảng này. */
const POST_SCAN_COOLDOWN_MS = 1000
/** Cùng một chuỗi decode phải lặp lại liên tiếp N lần mới ghi nhận — giảm đọc nhầm khi rung/góc/mờ. */
const STABLE_STREAK_REQUIRED = 2
const CAPTURE_INTERVAL_MS = 85
const MAX_CAPTURE_SIDE = 1920
const JPEG_QUALITY = 0.86
const OVERLAY_HOLD_MS = 450
const FRAME_META_MAX = 24

/** Ưu tiên độ phân giải — barcode xa cần nhiều pixel trên vạch. */
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

const VIDEO_CONSTRAINTS_MIN: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: 'environment' },
}

function wsBarcodeUrl(): string {
  const env = import.meta.env.VITE_PY_BARCODE_WS
  if (typeof env === 'string' && env.length > 0) return env
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws/pybarcode`
}

type NormPoint = { x: number; y: number }
type NormRect = { x: number; y: number; w: number; h: number }

type DetectPayload = {
  type: 'detect'
  frameId?: number
  found: boolean
  text?: string
  format?: string
  rect?: NormRect
  polygon?: NormPoint[]
}

/** object-cover: scale = max — khớp bbox overlay với video phủ kín khung. */
function mapVideoRectToContainer(
  cw: number,
  ch: number,
  vw: number,
  vh: number,
  rect: NormRect,
): { x: number; y: number; w: number; h: number } {
  const scale = Math.max(cw / vw, ch / vh)
  const dw = vw * scale
  const dh = vh * scale
  const ox = (cw - dw) / 2
  const oy = (ch - dh) / 2
  return {
    x: ox + rect.x * dw,
    y: oy + rect.y * dh,
    w: rect.w * dw,
    h: rect.h * dh,
  }
}

function mapVideoPolyToContainer(
  cw: number,
  ch: number,
  vw: number,
  vh: number,
  poly: NormPoint[],
): NormPoint[] {
  const scale = Math.max(cw / vw, ch / vh)
  const dw = vw * scale
  const dh = vh * scale
  const ox = (cw - dw) / 2
  const oy = (ch - dh) / 2
  return poly.map((p) => ({
    x: ox + p.x * dw,
    y: oy + p.y * dh,
  }))
}

/**
 * Vùng pixel trên video (vw×vh) tương ứng phần nhìn thấy trong khung cw×ch với object-cover.
 */
function visibleVideoCropPixels(
  vw: number,
  vh: number,
  cw: number,
  ch: number,
): { sx: number; sy: number; sw: number; sh: number } {
  if (vw < 2 || vh < 2 || cw < 2 || ch < 2) {
    return { sx: 0, sy: 0, sw: Math.max(1, vw), sh: Math.max(1, vh) }
  }
  const S = Math.max(cw / vw, ch / vh)
  const Vw = vw * S
  const Vh = vh * S
  const ox = (cw - Vw) / 2
  const oy = (ch - Vh) / 2
  const vx0 = Math.max(0, (-ox) / S)
  const vx1 = Math.min(vw, (cw - ox) / S)
  const vy0 = Math.max(0, (-oy) / S)
  const vy1 = Math.min(vh, (ch - oy) / S)
  if (vx1 <= vx0 || vy1 <= vy0) {
    return { sx: 0, sy: 0, sw: vw, sh: vh }
  }
  const sx = Math.max(0, Math.floor(vx0))
  const sy = Math.max(0, Math.floor(vy0))
  const sw = Math.max(1, Math.min(vw - sx, Math.ceil(vx1) - sx))
  const sh = Math.max(1, Math.min(vh - sy, Math.ceil(vy1) - sy))
  return { sx, sy, sw, sh }
}

/** Bbox/polygon chuẩn hóa theo ảnh đã cắt (cùng tỷ lệ sw×sh) → chuẩn hóa theo full video. */
function cropNormRectToFullVideo(
  rect: NormRect,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  vw: number,
  vh: number,
): NormRect {
  return {
    x: (sx + rect.x * sw) / vw,
    y: (sy + rect.y * sh) / vh,
    w: (rect.w * sw) / vw,
    h: (rect.h * sh) / vh,
  }
}

function cropNormPolyToFullVideo(
  poly: NormPoint[],
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  vw: number,
  vh: number,
): NormPoint[] {
  return poly.map((p) => ({
    x: (sx + p.x * sw) / vw,
    y: (sy + p.y * sh) / vh,
  }))
}

/** Kích thước canvas JPEG giữ tỷ lệ sw:sh, cạnh dài tối đa MAX_CAPTURE_SIDE. */
function outputSizeForCrop(sw: number, sh: number): { tw: number; th: number } {
  const ar = sw / sh
  if (sw >= sh) {
    const tw = Math.min(sw, MAX_CAPTURE_SIDE)
    const th = Math.max(2, Math.round(tw / ar))
    return { tw: Math.max(2, tw), th }
  }
  const th = Math.min(sh, MAX_CAPTURE_SIDE)
  const tw = Math.max(2, Math.round(th * ar))
  return { tw, th: Math.max(2, th) }
}

async function getStreamWithFallback(): Promise<MediaStream> {
  const chain = [VIDEO_CONSTRAINTS, VIDEO_CONSTRAINTS_MID, VIDEO_CONSTRAINTS_MIN]
  let last: unknown
  for (const c of chain) {
    try {
      return await navigator.mediaDevices.getUserMedia(c)
    } catch (e) {
      last = e
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
  throw last
}

async function applyContinuousFocus(track: MediaStreamTrack): Promise<void> {
  try {
    await track.applyConstraints({
      advanced: [
        { focusMode: 'continuous' },
        { exposureMode: 'continuous' },
      ],
    } as unknown as MediaTrackConstraints)
  } catch {
    /* ignore */
  }
}

type FrameCropMeta = {
  sx: number
  sy: number
  sw: number
  sh: number
  vw: number
  vh: number
}

export default function PyBarcodeScannerPage() {
  const [scanList, setScanList] = useState<ScanListEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [wsHint, setWsHint] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const captureRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const frameIdRef = useRef(0)
  const inFlightRef = useRef(false)
  /** Thời điểm (ms) sau đó mới được gửi khung / quét tiếp. */
  const scanCooldownUntilRef = useRef(0)
  const frameMetaByIdRef = useRef<Map<number, FrameCropMeta>>(new Map())
  const frameMetaOrderRef = useRef<number[]>([])
  /** Chuỗi vừa decode + số lần trùng liên tiếp (chưa ghi nhận). */
  const stableDecodeRef = useRef<{ text: string; count: number } | null>(null)
  const overlayStateRef = useRef<{
    rect: NormRect | null
    polygon: NormPoint[] | null
    vw: number
    vh: number
    until: number
  } | null>(null)
  const rafRef = useRef<number>(0)
  const genRef = useRef(0)

  const resizeOverlay = useCallback(() => {
    const canvas = overlayRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const r = wrap.getBoundingClientRect()
    const w = Math.max(1, Math.floor(r.width))
    const h = Math.max(1, Math.floor(r.height))
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }, [])

  const drawOverlayLoop = useCallback(() => {
    const canvas = overlayRef.current
    const video = videoRef.current
    if (!canvas || !video) {
      rafRef.current = requestAnimationFrame(drawOverlayLoop)
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      rafRef.current = requestAnimationFrame(drawOverlayLoop)
      return
    }
    const w = canvas.width / (window.devicePixelRatio || 1)
    const h = canvas.height / (window.devicePixelRatio || 1)
    ctx.clearRect(0, 0, w, h)
    const st = overlayStateRef.current
    const now = Date.now()
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (
      st &&
      now < st.until &&
      vw > 0 &&
      vh > 0 &&
      (st.polygon?.length || st.rect)
    ) {
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.95)'
      ctx.lineWidth = 3
      ctx.shadowColor = 'rgba(16, 185, 129, 0.55)'
      ctx.shadowBlur = 12
      if (st.polygon && st.polygon.length >= 3) {
        const pts = mapVideoPolyToContainer(w, h, vw, vh, st.polygon)
        ctx.beginPath()
        pts.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y)
          else ctx.lineTo(p.x, p.y)
        })
        ctx.closePath()
        ctx.stroke()
      } else if (st.rect) {
        const r = mapVideoRectToContainer(w, h, vw, vh, st.rect)
        ctx.strokeRect(r.x, r.y, r.w, r.h)
      }
      ctx.shadowBlur = 0
    }
    rafRef.current = requestAnimationFrame(drawOverlayLoop)
  }, [])

  useEffect(() => {
    const root = document.getElementById('root')
    root?.classList.add('scanner-full')
    const myGen = ++genRef.current
    const videoEl = videoRef.current
    resizeOverlay()
    const ro = new ResizeObserver(() => resizeOverlay())
    if (wrapRef.current) ro.observe(wrapRef.current)

    rafRef.current = requestAnimationFrame(drawOverlayLoop)

    void (async () => {
      setError(null)
      setStarting(true)
      const video = videoEl ?? videoRef.current
      if (!video) {
        if (myGen === genRef.current) setStarting(false)
        return
      }
      try {
        const stream = await getStreamWithFallback()
        if (myGen !== genRef.current) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        video.srcObject = stream
        await video.play()
        const [track] = stream.getVideoTracks()
        if (track) void applyContinuousFocus(track)
        const caps =
          typeof track?.getCapabilities === 'function' ? track.getCapabilities() : {}
        setTorchSupported(
          typeof caps === 'object' &&
            caps !== null &&
            'torch' in caps &&
            (caps as { torch?: boolean }).torch === true,
        )
        setTorchOn(false)
      } catch (e) {
        if (myGen === genRef.current) {
          const msg = e instanceof Error ? e.message : String(e)
          setError(
            `${msg} — Cần HTTPS hoặc localhost, và quyền camera. Sau đó chạy server Python.`,
          )
        }
      } finally {
        if (myGen === genRef.current) setStarting(false)
      }
    })()

    return () => {
      // Hủy phiên camera: tăng gen để callback getUserMedia không setState sau unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- chủ đích đọc genRef mới nhất khi cleanup
      genRef.current++
      root?.classList.remove('scanner-full')
      ro.disconnect()
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      if (videoEl) videoEl.srcObject = null
    }
  }, [drawOverlayLoop, resizeOverlay])

  useEffect(() => {
    let alive = true
    const url = wsBarcodeUrl()
    const ws = new WebSocket(url)
    wsRef.current = ws
    setWsHint(`Đang kết nối ${url}…`)

    ws.onopen = () => {
      if (!alive) return
      setWsHint('Đã kết nối OpenCV + pyzbar (Python).')
    }
    ws.onerror = () => {
      if (!alive) return
      setWsHint(null)
      setError((prev) =>
        prev ??
        'WebSocket lỗi — chạy `python server.py` trong thư mục python-barcode-server (cổng 8765).',
      )
    }
    ws.onclose = () => {
      if (!alive) return
      setWsHint(null)
    }

    ws.onmessage = (ev) => {
      inFlightRef.current = false
      let data: unknown
      try {
        data = JSON.parse(String(ev.data)) as unknown
      } catch {
        return
      }
      if (!data || typeof data !== 'object') return
      const o = data as Record<string, unknown>
      if (o.type === 'error' && typeof o.message === 'string') {
        setWsHint(`Lỗi server: ${o.message}`)
        return
      }
      if (o.type !== 'detect') return
      const d = o as unknown as DetectPayload
      const video = videoRef.current
      if (!d.found || !d.text || !video || video.videoWidth < 2) return

      const now = Date.now()
      if (now < scanCooldownUntilRef.current) return

      const rawText = d.text.trim()
      if (!rawText) return

      const strictGtin = import.meta.env.VITE_BARCODE_STRICT_GTIN === 'true'
      if (strictGtin && !passesStrictGtinChecksum(rawText)) {
        stableDecodeRef.current = null
        overlayStateRef.current = null
        return
      }

      const fid =
        typeof d.frameId === 'number' && Number.isFinite(d.frameId)
          ? d.frameId
          : null
      const meta = fid != null ? frameMetaByIdRef.current.get(fid) : undefined
      if (!meta) return

      const { sx, sy, sw, sh, vw, vh } = meta
      const rectFull =
        d.rect != null
          ? cropNormRectToFullVideo(d.rect, sx, sy, sw, sh, vw, vh)
          : null
      const polyFull =
        d.polygon != null && d.polygon.length > 0
          ? cropNormPolyToFullVideo(d.polygon, sx, sy, sw, sh, vw, vh)
          : null

      let st = stableDecodeRef.current
      if (!st || st.text !== rawText) {
        st = { text: rawText, count: 1 }
      } else {
        st = { text: rawText, count: st.count + 1 }
      }
      stableDecodeRef.current = st

      const until = now + OVERLAY_HOLD_MS
      overlayStateRef.current = {
        rect: rectFull,
        polygon: polyFull,
        vw,
        vh,
        until,
      }

      if (st.count < STABLE_STREAK_REQUIRED) return

      stableDecodeRef.current = null
      scanCooldownUntilRef.current = now + POST_SCAN_COOLDOWN_MS
      setScanList((prev) => addScanToList(prev, rawText, d.format ?? null))
      playClassicPosBeep()
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(18)
      }
    }

    return () => {
      alive = false
      ws.close()
      wsRef.current = null
    }
  }, [])

  useEffect(() => {
    const tick = () => {
      const ws = wsRef.current
      const video = videoRef.current
      const cap = captureRef.current
      const wrap = wrapRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN || !video || !cap || !wrap) return
      if (video.readyState < 2 || video.videoWidth < 2) return
      if (inFlightRef.current) return
      if (Date.now() < scanCooldownUntilRef.current) return

      const vw = video.videoWidth
      const vh = video.videoHeight
      const cr = wrap.getBoundingClientRect()
      if (cr.width < 2 || cr.height < 2) return
      const cw = cr.width
      const ch = cr.height
      const { sx, sy, sw, sh } = visibleVideoCropPixels(vw, vh, cw, ch)
      const { tw, th } = outputSizeForCrop(sw, sh)

      cap.width = tw
      cap.height = th
      const c = cap.getContext('2d')
      if (!c) return
      c.drawImage(video, sx, sy, sw, sh, 0, 0, tw, th)
      const jpeg = cap.toDataURL('image/jpeg', JPEG_QUALITY)
      const b64 = jpeg.replace(/^data:image\/jpeg;base64,/, '')
      const frameId = ++frameIdRef.current

      const metaMap = frameMetaByIdRef.current
      const order = frameMetaOrderRef.current
      metaMap.set(frameId, { sx, sy, sw, sh, vw, vh })
      order.push(frameId)
      while (order.length > FRAME_META_MAX) {
        const old = order.shift()
        if (old != null) metaMap.delete(old)
      }

      inFlightRef.current = true
      ws.send(
        JSON.stringify({
          type: 'frame',
          frameId,
          jpeg: b64,
        }),
      )
    }
    const intervalId = window.setInterval(tick, CAPTURE_INTERVAL_MS)
    return () => {
      window.clearInterval(intervalId)
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
          Scanner Python (OpenCV + WebSocket)
        </h1>
        <p className="max-w-[48ch] text-sm leading-snug text-[#8b92a8]">
          Chỉ gửi đúng <strong className="text-[#cbd5e1]">vùng đang hiển thị</strong>. Cùng một mã
          phải đọc trùng <strong className="text-[#cbd5e1]">{STABLE_STREAK_REQUIRED} lần liên tiếp</strong>{' '}
          mới beep / lưu (giảm lỗi đọc nhầm khi xoay máy). Sau mỗi lần lưu chờ ~{POST_SCAN_COOLDOWN_MS / 1000}
          s. Tùy chọn: <code className="text-sky-200/90">VITE_BARCODE_STRICT_GTIN=true</code> để chỉ
          chấp nhận EAN/UPC đúng checksum (có thể loại cả mã thật nếu in lệch chuẩn).
        </p>
        {wsHint && (
          <p className="mt-2 text-xs text-sky-300/90" role="status">
            {wsHint}
          </p>
        )}
        <p className="mt-2 text-xs leading-relaxed text-[#6b7280]">
          Backend: <code className="text-sky-200/90">python-barcode-server/server.py</code> (cổng{' '}
          <code className="text-sky-200/90">PY_BARCODE_PORT</code>, mặc định 8765). Prod:{' '}
          <code className="text-sky-200/90">VITE_PY_BARCODE_WS</code>.{' '}
          <Link className="text-sky-400/90 underline" to="/scanner-zxing">
            So sánh ZXing
          </Link>
        </p>
      </header>

      <div
        ref={wrapRef}
        className="relative mx-3 mt-1 shrink-0 overflow-hidden rounded-2xl bg-black shadow-[0_0_0_1px_rgba(56,189,248,0.15)] sm:mx-auto sm:max-w-2xl"
      >
        <div className="relative aspect-video w-full min-h-0">
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
          <video
            ref={videoRef}
            className="size-full object-cover"
            muted
            playsInline
            autoPlay
          />
          <canvas
            ref={overlayRef}
            className="pointer-events-none absolute inset-0 z-10"
            aria-hidden
          />
        </div>
        <canvas ref={captureRef} className="hidden" aria-hidden />
        {torchSupported && !error && (
          <div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2">
            <button
              type="button"
              onClick={() => {
                const track = streamRef.current?.getVideoTracks()[0]
                if (!track) return
                const next = !torchOn
                void track.applyConstraints({
                  advanced: [{ torch: next }],
                } as unknown as MediaTrackConstraints)
                  .then(() => setTorchOn(next))
                  .catch(() => {})
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
              Bật server Python, giữ mã trong khung; vùng viền là bbox từ server. Trùng mã trong
              ~1s không lặp lại tiếng beep.
            </span>
          )}
        </div>
      </section>
    </div>
  )
}
