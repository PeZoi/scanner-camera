/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SCANBOT_LICENSE_KEY?: string
  /** WebSocket tới server Python (OpenCV + pyzbar). Mặc định dev: proxy `/ws/pybarcode`. */
  readonly VITE_PY_BARCODE_WS?: string
  /** Bật kiểm tra checksum EAN-8/12/13 (mặc định tắt — một số mã thật có thể lệch check). */
  readonly VITE_BARCODE_STRICT_GTIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
