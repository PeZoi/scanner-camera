"""
Giao thức tin nhắn WebSocket (text JSON) giữa client và server.

Client gửi frame dạng::

    {"type": "frame", "frameId": <any>, "jpeg": "<base64>"}

Server trả::

    {"type": "detect", "frameId": ..., "found": bool, ...}

Hoặc lỗi / pong ping. Toàn bộ parse + decode JPEG diễn ra trong luồng worker
qua ``process_frame_sync`` (được ``run_in_executor`` gọi).
"""

from __future__ import annotations

import base64
import json
from typing import Any

from barcode_server.pipeline import decode_jpeg_bytes


def process_frame_sync(raw: str) -> dict[str, Any]:
    """
    Xử lý **một** chuỗi text nhận từ WebSocket (đồng bộ).

    - JSON không hợp lệ → ``{"type": "error", "message": "invalid_json"}``
    - ``type: ping`` → ``{"type": "pong"}``
    - ``type: frame`` → base64 decode JPEG → ``decode_jpeg_bytes`` → ``type: detect`` + kết quả
    """
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return {"type": "error", "message": "invalid_json"}

    if msg.get("type") != "frame":
        if msg.get("type") == "ping":
            return {"type": "pong"}
        return {"type": "error", "message": "unknown_type"}

    b64 = msg.get("jpeg")
    if not isinstance(b64, str) or not b64:
        return {"type": "error", "message": "missing_jpeg"}

    try:
        jpeg = base64.b64decode(b64, validate=False)
    except Exception as e:
        return {"type": "error", "message": f"b64_decode: {e}"}

    fid = msg.get("frameId")
    result = decode_jpeg_bytes(jpeg)
    out: dict[str, Any] = {"type": "detect", "frameId": fid}
    out.update(result)
    return out
