"""
Hình học 2D cho bbox và polygon: chuẩn hóa tọa độ pixel → [0,1], tính diện tích đa giác.

Dùng khi:
- OpenCV trả points pixel → cần gửi cho frontend tỉ lệ theo kích thước frame
- pyzbar trả ``Rect`` + ``polygon`` pixel
- Chọn “mã lớn nhất” (proxy độ tin cậy) bằng diện tích polygon hoặc diện tích rect
"""

from __future__ import annotations

from typing import Any


def clamp01(x: float) -> float:
    """Giới hạn số thực vào đoạn [0, 1] (tránh tràn do làm tròn)."""
    return max(0.0, min(1.0, x))


def norm_rect(left: int, top: int, width: int, height: int, iw: int, ih: int) -> dict[str, float]:
    """
    Chuyển bbox pixel sang ``x, y, w, h`` chuẩn hóa theo ``iw × ih``.

    ``left, top`` là góc trên-trái; ``width, height`` tối thiểu 1 pixel sau khi clamp.
    """
    return {
        "x": clamp01(left / iw),
        "y": clamp01(top / ih),
        "w": clamp01(width / iw),
        "h": clamp01(height / ih),
    }


def norm_polygon_pyzbar(pts: Any, iw: int, ih: int) -> list[dict[str, float]]:
    """Điểm pyzbar (có ``.x``, ``.y``) → danh sách ``{x, y}`` trong [0, 1]."""
    out: list[dict[str, float]] = []
    for p in pts:
        x, y = int(p.x), int(p.y)
        out.append({"x": clamp01(x / iw), "y": clamp01(y / ih)})
    return out


def polygon_area(poly: list[dict[str, float]]) -> float:
    """
    Diện tích đa giác (công thức shoelace) trên mặt phẳng **đã chuẩn hóa**.

    Đơn vị là “đơn vị vuông” trong không gian 0..1 (so sánh tương đối giữa các hit).
    """
    if len(poly) < 3:
        return 0.0
    s = 0.0
    for i in range(len(poly)):
        j = (i + 1) % len(poly)
        s += poly[i]["x"] * poly[j]["y"] - poly[j]["x"] * poly[i]["y"]
    return abs(s) * 0.5
