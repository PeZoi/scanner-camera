"""
Lớp “backend” decode: OpenCV ``detectAndDecodeMulti`` trước, pyzbar sau (fallback).

Thứ tự cố ý:
- OpenCV BarcodeDetector thường ổn định trên Windows (không cần DLL ZBar ngoài).
- pyzbar bổ sung symbology / trường hợp OpenCV bỏ sót nếu môi trường cài đủ ZBar.

Mỗi hàm trả ``list[BarcodeHit]`` — ``pipeline`` sẽ gộp, chấm điểm, lọc GTIN.
"""

from __future__ import annotations

import numpy as np

from barcode_server import config
from barcode_server.geometry import clamp01, norm_polygon_pyzbar, norm_rect
from barcode_server.models import BarcodeHit


def hits_from_opencv(bgr: np.ndarray) -> list[BarcodeHit]:
    """
    Gọi ``BarcodeDetector.detectAndDecodeMulti``.

    OpenCV có thể trả nhiều mã; ``points`` layout phụ thuộc phiên bản — xử lý
    ``ndim == 3`` (batch theo index) hoặc ``ndim == 2`` (một mã).
    """
    ih, iw = bgr.shape[:2]
    if iw < 2 or ih < 2:
        return []

    det = config.opencv_detector()
    ok, decoded_info, points, _straight = det.detectAndDecodeMulti(bgr)
    if not ok or not decoded_info:
        return []

    P = np.asarray(points) if points is not None else None
    hits: list[BarcodeHit] = []

    for i, text in enumerate(decoded_info):
        if not text:
            continue

        poly: list[dict[str, float]] = []
        quad: np.ndarray | None = None

        if P is not None and P.size > 0:
            if P.ndim == 3 and i < P.shape[0]:
                quad = P[i]
            elif P.ndim == 3 and P.shape[0] == 1:
                quad = P[0]
            elif P.ndim == 2 and len(decoded_info) == 1:
                quad = P

        if quad is not None:
            for j in range(int(quad.shape[0])):
                x, y = float(quad[j, 0]), float(quad[j, 1])
                poly.append({"x": clamp01(x / iw), "y": clamp01(y / ih)})

        if poly:
            xs = [p["x"] for p in poly]
            ys = [p["y"] for p in poly]
            left = int(round(min(xs) * iw))
            top = int(round(min(ys) * ih))
            w = max(1, int(round((max(xs) - min(xs)) * iw)))
            h = max(1, int(round((max(ys) - min(ys)) * ih)))
            rect = norm_rect(left, top, w, h, iw, ih)
        else:
            rect = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}

        hits.append(
            BarcodeHit(
                text=str(text),
                format="OPENCV",
                rect=rect,
                polygon=poly,
            )
        )

    return hits


def hits_from_pyzbar(bgr: np.ndarray) -> list[BarcodeHit]:
    """``pyzbar.decode`` trên ảnh BGR; trả rỗng nếu pyzbar không khả dụng."""
    mod = config.pyzbar_module()
    if mod is None:
        return []

    ih, iw = bgr.shape[:2]
    decoded = mod.decode(bgr)
    hits: list[BarcodeHit] = []

    for d in decoded:
        try:
            text = d.data.decode("utf-8", errors="replace")
        except Exception:
            text = d.data.decode("latin-1", errors="replace")

        fmt = d.type or "UNKNOWN"
        rect = d.rect
        left, top, w, h = rect.left, rect.top, rect.width, rect.height
        poly = norm_polygon_pyzbar(d.polygon, iw, ih) if d.polygon else []

        hits.append(
            BarcodeHit(
                text=text,
                format=str(fmt),
                rect=norm_rect(left, top, w, h, iw, ih),
                polygon=poly,
            )
        )

    return hits


def decode_image_bgr(bgr: np.ndarray) -> list[BarcodeHit]:
    """
    Một lần thử trên ảnh BGR đã tiền xử lý: OpenCV trước, pyzbar nếu OpenCV rỗng.
    """
    if bgr is None or bgr.size == 0:
        return []

    hits = hits_from_opencv(bgr)
    if hits:
        return hits
    return hits_from_pyzbar(bgr)
