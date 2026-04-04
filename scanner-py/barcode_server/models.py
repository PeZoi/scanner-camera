"""
Kiểu dữ liệu dùng chung giữa các bước decode và phản hồi JSON.

``rect`` / ``polygon`` luôn ở hệ tọa độ **chuẩn hóa 0..1** theo **chiều rộng/cao
của ảnh đã đưa vào decoder** (sau imdecode + resize), để client có thể map lại
lên video gốc nếu biết vùng crop.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class BarcodeHit:
    """Một mã đọc được (có thể có nhiều hit trên cùng một ảnh)."""

    text: str
    """Nội dung giải mã (UTF-8)."""

    format: str
    """Nhãn định dạng: ``OPENCV`` hoặc tên symbology từ pyzbar (EAN13, …)."""

    rect: dict[str, float]
    """Hình chữ nhật axis-aligned: ``x, y, w, h`` trong [0, 1]."""

    polygon: list[dict[str, float]]
    """Đỉnh đa giác ``{x, y}`` trong [0, 1]; rỗng nếu backend không trả points."""
