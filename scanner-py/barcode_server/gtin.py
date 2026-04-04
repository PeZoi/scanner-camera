"""
Kiểm tra checksum cho mã số thuần chữ số (GS1 retail).

Dùng khi ``STRICT_GTIN=1``: lọc bỏ các chuỗi “trông giống” EAN/UPC nhưng sai check digit
(do nhiễu ảnh / false positive của detector).

Tham chiếu thuật toán:
- EAN-13 / EAN-8 / UPC-A: tổng có trọng số theo vị trí chẵn/lẻ, check = (10 - sum % 10) % 10.
"""

from __future__ import annotations


def valid_ean13(s: str) -> bool:
    """13 chữ số, check digit vị trí cuối (trọng số 1,3 xen kẽ từ trái, bỏ digit 13)."""
    if len(s) != 13 or not s.isdigit():
        return False
    total = sum(int(s[i]) * (1 if i % 2 == 0 else 3) for i in range(12))
    return (10 - (total % 10)) % 10 == int(s[12])


def valid_ean8(s: str) -> bool:
    """8 chữ số, trọng số 3,1 xen kẽ trên 7 digit đầu."""
    if len(s) != 8 or not s.isdigit():
        return False
    total = sum(int(s[i]) * (3 if i % 2 == 0 else 1) for i in range(7))
    return (10 - (total % 10)) % 10 == int(s[7])


def valid_upca(s: str) -> bool:
    """UPC-A: 12 chữ số, cùng quy tắc trọng số như EAN-13 nhưng không có country prefix ở đầu."""
    if len(s) != 12 or not s.isdigit():
        return False
    total = sum(int(s[i]) * (3 if i % 2 == 0 else 1) for i in range(11))
    return (10 - (total % 10)) % 10 == int(s[11])


def passes_strict_gtin(text: str) -> bool:
    """
    Nếu chuỗi **chỉ gồm chữ số** và độ dài 8 / 12 / 13 → bắt buộc đúng checksum tương ứng.

    Các chuỗi không thuộc các dạng trên (QR text, Code128 chữ, …) → **luôn cho qua**
    (không áp checksum).
    """
    t = text.strip()
    if not t.isdigit():
        return True
    n = len(t)
    if n == 13:
        return valid_ean13(t)
    if n == 8:
        return valid_ean8(t)
    if n == 12:
        return valid_upca(t)
    return True
