"""
Tiền xử lý ảnh BGR (OpenCV) trước khi đưa vào decoder.

Mục tiêu:
- Ảnh tối / tương phản thấp: gamma + CLAHE trên kênh L (LAB) làm nổi vạch
- Nhiễu ISO cao: bilateral nhẹ (đắt CPU — chỉ dùng vài nhánh)
- Tem nền tối vạch sáng: thử “invert-like” từ gray
- Ảnh nhỏ trên sensor: upscale 2× (sau khi đã CLAHE/gamma phù hợp)

Tất cả hàm nhận/ trả ``numpy.ndarray`` BGR ``uint8``.
"""

from __future__ import annotations

import cv2
import numpy as np


def mean_luminance_01(bgr: np.ndarray) -> float:
    """
    Độ sáng trung bình toàn ảnh trong [0, 1].

    Dùng để quyết định **thứ tự** các biến thể trong ``pipeline.smart_decode_variants``
    (ảnh tối → ưu tiên pipeline “sáng” trước).
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return float(np.mean(gray)) / 255.0


def gamma_bgr(bgr: np.ndarray, gamma: float) -> np.ndarray:
    """
    Điều chỉnh gamma trên từng kênh BGR (LUT).

    ``gamma < 1`` → làm **sáng** (hữu ích khi under-exposed).
    Giới hạn ``gamma`` trong [0.2, 3.0] để tránh ảnh vỡ / quá tối.
    """
    g = max(0.2, min(3.0, gamma))
    inv = 1.0 / g
    table = (np.linspace(0, 1, 256) ** inv * 255).astype(np.uint8)
    return cv2.LUT(bgr, table)


def clahe_bgr(bgr: np.ndarray, clip_limit: float = 2.5) -> np.ndarray:
    """
    CLAHE chỉ trên kênh L của LAB — tăng cục bộ tương phản mà ít đổi màu.

    ``clip_limit`` cao hơn → tăng tương phản mạnh hơn (dễ artifact trên vùng đồng nhất).
    """
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(8, 8))
    l2 = clahe.apply(l)
    merged = cv2.merge((l2, a, b))
    return cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)


def clahe_strong(bgr: np.ndarray) -> np.ndarray:
    """CLAHE với ``clip_limit=4.0`` — dành cho ảnh rất tối hoặc flat lighting."""
    return clahe_bgr(bgr, clip_limit=4.0)


def sharpen(bgr: np.ndarray) -> np.ndarray:
    """Làm nét laplacian-style (kernel 3×3) — có thể khuếch đại nhiễu; dùng sau CLAHE."""
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    return cv2.filter2D(bgr, -1, kernel)


def denoise_bilateral_light(bgr: np.ndarray) -> np.ndarray:
    """
    Bilateral filter nhẹ: giữ cạnh vạch, giảm grain.

    ``d=5`` để chi phí O(pixel) vẫn chấp nhận được trên server.
    """
    return cv2.bilateralFilter(bgr, d=5, sigmaColor=60, sigmaSpace=60)


def grayscale_invert_bgr(bgr: np.ndarray) -> np.ndarray:
    """
    Chuyển gray rồi đảo 255-x, merge lại 3 kênh.

    Một số mã in trên nền đậm, vạch sáng — detector 1D thường kỳ vọng nền sáng hơn.
    """
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    inv = 255 - g
    return cv2.cvtColor(inv, cv2.COLOR_GRAY2BGR)


def resize_max_side(bgr: np.ndarray, max_side: int) -> np.ndarray:
    """
    Thu nhỏ nếu cạnh dài > ``max_side`` (giữ tỉ lệ, INTER_AREA).

    Giảm chi phí decode và tránh buffer quá lớn; ``max_side`` lấy từ ``config.MAX_SIDE``.
    """
    h, w = bgr.shape[:2]
    m = max(h, w)
    if m <= max_side:
        return bgr
    scale = max_side / m
    nw = max(2, int(round(w * scale)))
    nh = max(2, int(round(h * scale)))
    return cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_AREA)


def upscale_2x(bgr: np.ndarray) -> np.ndarray:
    """Phóng đại 2× mỗi chiều (INTER_CUBIC) — thử khi mã quá nhỏ trên frame."""
    h, w = bgr.shape[:2]
    return cv2.resize(bgr, (w * 2, h * 2), interpolation=cv2.INTER_CUBIC)
