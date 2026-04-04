"""
Cấu hình từ biến môi trường và singleton tốn tài nguyên (thread pool, detector).

Tách riêng để:
- Dễ test (mock env)
- Tránh import vòng: các module khác chỉ đọc hằng số / hàm lấy executor tại đây
"""

from __future__ import annotations

import logging
import os
from typing import Any
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor

import cv2

log = logging.getLogger("pybarcode")

# --- Hằng số ảnh / pipeline (không phụ thuộc env) ---

# Cạnh dài tối đa (pixel) sau imdecode — tránh ảnh quá lớn làm treo CPU / RAM.
MAX_SIDE = 2560

# Trung bình độ sáng (0..1) của kênh gray; dưới ngưỡng → coi là “ảnh tối”
# và đổi thứ tự các bước tiền xử lý (ưu tiên gamma + CLAHE mạnh trước).
DARK_LUMA_THRESHOLD = 0.38

# Cạnh dài tối đa để cho phép nhánh upscale 2× (tránh OOM trên ảnh đã lớn).
MAX_SIDE_FOR_2X_UPSCALE = 1600


def listen_port() -> int:
    """
    Cổng WebSocket TCP.

    Env: ``PY_BARCODE_PORT`` (mặc định 8765). Phải khớp proxy Vite / ``VITE_PY_BARCODE_WS``.
    """
    raw = os.environ.get("PY_BARCODE_PORT", "8765").strip()
    try:
        p = int(raw)
    except ValueError:
        log.warning("PY_BARCODE_PORT=%r không hợp lệ — dùng 8765", raw)
        return 8765
    if not (1 <= p <= 65535):
        log.warning("PY_BARCODE_PORT=%s ngoài 1..65535 — dùng 8765", p)
        return 8765
    return p


@lru_cache(maxsize=1)
def decode_executor() -> ThreadPoolExecutor:
    """
    Thread pool dùng cho ``run_in_executor``: mọi ``decode_jpeg_bytes`` chạy ở đây.

    - Không chặn event loop asyncio → client vẫn nhận/ghi WebSocket mượt.
    - Env ``BARCODE_DECODE_WORKERS``: số worker (1..32).
    - Mặc định: ``max(4, min(16, cpu_count + 2))`` — cân bằng đa client / đa frame.
    """
    raw = os.environ.get("BARCODE_DECODE_WORKERS", "").strip()
    if raw:
        try:
            n = max(1, min(32, int(raw)))
            log.info("BARCODE_DECODE_WORKERS=%s", n)
            return ThreadPoolExecutor(max_workers=n, thread_name_prefix="decode")
        except ValueError:
            pass
    cpu = os.cpu_count() or 4
    n = max(4, min(16, cpu + 2))
    log.info("ThreadPool decode: max_workers=%s (đặt BARCODE_DECODE_WORKERS để ghi đè)", n)
    return ThreadPoolExecutor(max_workers=n, thread_name_prefix="decode")


# --- pyzbar (tùy chọn): trên Windows thường cần DLL ZBar ---
try:
    from pyzbar import pyzbar as _pyzbar_module  # type: ignore[no-redef]

    PYZBAR_AVAILABLE = True
    _pyzbar = _pyzbar_module
except Exception as e:  # ImportError, OSError (thiếu DLL), …
    _pyzbar = None
    PYZBAR_AVAILABLE = False
    log.warning("pyzbar không dùng được (%s) — chỉ dùng OpenCV BarcodeDetector.", e)

# Một instance detector cho toàn process (OpenCV khuyến nghị tái sử dụng).
_OPENCV_BARCODE = cv2.barcode.BarcodeDetector()


def opencv_detector() -> Any:
    """Trả singleton ``cv2.barcode.BarcodeDetector`` (C++ backend bên dưới)."""
    return _OPENCV_BARCODE


def pyzbar_module():
    """
    Trả module pyzbar nếu import được, ngược lại ``None``.
    Dùng trong ``backends`` để gọi ``decode`` an toàn.
    """
    return _pyzbar if PYZBAR_AVAILABLE else None


# Bật: chỉ chấp nhận chuỗi thuần số độ dài 8/12/13 nếu đúng checksum GS1.
STRICT_GTIN = os.environ.get("STRICT_GTIN", "").strip().lower() in ("1", "true", "yes", "on")
