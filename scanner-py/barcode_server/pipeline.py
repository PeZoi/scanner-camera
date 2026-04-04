"""
Pipeline end-to-end: JPEG bytes → decode thông minh nhiều biến thể → dict JSON-friendly.

``decode_jpeg_bytes`` là hàm **đồng bộ**, nặng CPU — luôn gọi từ thread pool
(``websocket_server`` + ``run_in_executor``), không gọi trực tiếp trong coroutine
trừ khi chấp nhận block event loop.
"""

from __future__ import annotations

from typing import Any, Callable

import cv2
import numpy as np

from barcode_server import config
from barcode_server.backends import decode_image_bgr
from barcode_server.geometry import polygon_area
from barcode_server.gtin import passes_strict_gtin
from barcode_server.models import BarcodeHit
from barcode_server.preprocessing import (
    clahe_bgr,
    clahe_strong,
    denoise_bilateral_light,
    gamma_bgr,
    grayscale_invert_bgr,
    mean_luminance_01,
    resize_max_side,
    sharpen,
    upscale_2x,
)


def _try_variant(
    bgr: np.ndarray,
    tag: str,
    fn: Callable[[np.ndarray], np.ndarray],
    variants: list[str],
) -> list[BarcodeHit]:
    """
    Áp preprocessor ``fn``, decode; nếu có hit thì append ``tag`` vào ``variants``
    (để client/debug biết nhánh nào thắng).
    """
    try:
        img = fn(bgr)
        hits = decode_image_bgr(img)
        if hits:
            variants.append(tag)
        return hits
    except Exception:
        return []


def smart_decode_variants(bgr: np.ndarray, variants: list[str]) -> list[BarcodeHit]:
    """
    Chiến lược đa bước:

    1. Ước lượng độ sáng trung bình; ảnh **tối** dùng thứ tự ưu tiên khác (gamma/CLAHE mạnh trước).
    2. Mỗi bước: gọi ``decode_image_bgr`` (OpenCV → pyzbar).
    3. Nếu vẫn không có mã và cạnh dài ≤ ``MAX_SIDE_FOR_2X_UPSCALE``: thử upscale 2×
       trên ảnh đã CLAHE/gamma “cơ bản” cho tối/sáng.

    Trả về danh sách hit (thường dừng ở bước đầu tiên có kết quả).
    """
    luma = mean_luminance_01(bgr)
    is_dark = luma < config.DARK_LUMA_THRESHOLD

    # (tag, preprocessor) — thứ tự quan trọng: giảm số lần decode trung bình + tăng hit rate tối
    if is_dark:
        pipeline: list[tuple[str, Callable[[np.ndarray], np.ndarray]]] = [
            ("gamma075_clahe4", lambda x: clahe_strong(gamma_bgr(x, 0.75))),
            ("clahe4", clahe_strong),
            ("denoise_clahe4", lambda x: clahe_strong(denoise_bilateral_light(x))),
            ("gamma065_clahe_sharp", lambda x: sharpen(clahe_bgr(gamma_bgr(x, 0.65), 3.0))),
            ("raw", lambda x: x),
            ("clahe", lambda x: clahe_bgr(x, 2.5)),
            ("clahe_sharp", lambda x: sharpen(clahe_bgr(x, 2.5))),
            ("invert_like", grayscale_invert_bgr),
        ]
    else:
        pipeline = [
            ("raw", lambda x: x),
            ("clahe", lambda x: clahe_bgr(x, 2.5)),
            ("clahe_sharp", lambda x: sharpen(clahe_bgr(x, 2.5))),
            ("gamma085", lambda x: gamma_bgr(x, 0.85)),
            ("invert_like", grayscale_invert_bgr),
        ]

    for tag, fn in pipeline:
        hits = _try_variant(bgr, tag, fn, variants)
        if hits:
            return hits

    # Mã nhỏ / xa: phóng 2× trên ảnh đã làm nét tối ưu cho tối/sáng
    if max(bgr.shape[0], bgr.shape[1]) <= config.MAX_SIDE_FOR_2X_UPSCALE:
        base = clahe_strong(gamma_bgr(bgr, 0.72)) if is_dark else clahe_bgr(bgr, 2.5)
        up = upscale_2x(base)
        hits = _try_variant(up, "2x_clahe_base", lambda x: x, variants)
        if not hits:
            hits = _try_variant(up, "2x_sharp", sharpen, variants)
        if hits:
            return hits

    return []


def decode_jpeg_bytes(jpeg: bytes) -> dict[str, Any]:
    """
    Điểm vào chính từ worker thread:

    - ``imdecode`` JPEG → BGR
    - ``resize_max_side`` theo ``config.MAX_SIDE``
    - ``smart_decode_variants``
    - Chọn **một** hit tốt nhất theo diện tích polygon (hoặc diện tích rect)
    - Nếu ``STRICT_GTIN``: loại hit sai checksum

    Trả dict có khóa ``found``, và khi thành công: ``text``, ``format``, ``rect``, ``polygon``, ``variants``.
    """
    variants: list[str] = []
    if not jpeg:
        return {"found": False, "reason": "empty", "variants": variants}

    arr = np.frombuffer(jpeg, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return {"found": False, "reason": "imdecode_failed", "variants": variants}

    bgr = resize_max_side(bgr, config.MAX_SIDE)
    all_hits = smart_decode_variants(bgr, variants)

    if not all_hits:
        return {"found": False, "reason": "no_barcode", "variants": variants}

    def score(h: BarcodeHit) -> float:
        if h.polygon:
            return polygon_area(h.polygon)
        return h.rect["w"] * h.rect["h"]

    candidates = all_hits
    if config.STRICT_GTIN:
        candidates = [h for h in all_hits if passes_strict_gtin(h.text)]
        if not candidates:
            return {"found": False, "reason": "no_valid_gtin_checksum", "variants": variants}

    best = max(candidates, key=score)
    return {
        "found": True,
        "text": best.text,
        "format": best.format,
        "rect": best.rect,
        "polygon": best.polygon,
        "variants": variants,
    }
