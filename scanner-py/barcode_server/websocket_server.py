"""
Lớp asyncio + websockets: một kết nối = một hàng đợi frame + một worker decode.

Kiến trúc (tránh backlog khi decode chậm hơn FPS camera):

1. **Hàng đợi tối đa 1 phần tử** (``maxsize=1``): mỗi tin ``frame`` mới đến,
   nếu queue đầy thì **bỏ frame cũ**, chỉ giữ frame mới nhất — luôn ưu tiên “hình hiện tại”.
2. **decode_worker** (coroutine): lấy từ queue, ``run_in_executor(pool, process_frame_sync, raw)``,
   rồi ``send`` JSON. Decode không block event loop.
3. **handler**: lặp ``async for message``, đẩy vào queue; khi disconnect hoặc lỗi,
   hủy worker và set cờ dừng.

``main()``: ``websockets.serve`` trên ``0.0.0.0:listen_port()``, ``max_size`` lớn cho JPEG base64.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

from barcode_server import config
from barcode_server.protocol import process_frame_sync

log = logging.getLogger("pybarcode")


def queue_put_latest(q: asyncio.Queue[str], raw: str) -> None:
    """
    Đưa ``raw`` vào queue; nếu đầy, **pop** phần tử cũ rồi put lại.

    Hành vi: luôn có tối đa 1 frame chờ; frame bị bỏ là frame **cũ hơn** (đã lỗi thời).
    """
    try:
        q.put_nowait(raw)
    except asyncio.QueueFull:
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            pass
        try:
            q.put_nowait(raw)
        except asyncio.QueueFull:
            pass


async def handler(connection: Any) -> None:
    """Một client WebSocket: queue + worker + vòng lặp nhận message."""
    peer = getattr(connection, "remote_address", "?")
    log.info("client connected %s", peer)

    loop = asyncio.get_running_loop()
    ex = config.decode_executor()
    q: asyncio.Queue[str] = asyncio.Queue(maxsize=1)
    stop = asyncio.Event()

    async def decode_worker() -> None:
        while not stop.is_set():
            try:
                raw = await asyncio.wait_for(q.get(), timeout=0.1)
            except asyncio.TimeoutError:
                continue
            try:
                reply = await loop.run_in_executor(ex, process_frame_sync, raw)
                await connection.send(json.dumps(reply))
            except Exception:
                log.exception("decode_worker send")
                break

    task = asyncio.create_task(decode_worker())

    try:
        async for message in connection:
            if isinstance(message, bytes):
                await connection.send(json.dumps({"type": "error", "message": "binary_not_supported"}))
                continue
            queue_put_latest(q, message)
    except ConnectionClosed:
        log.info("client disconnected %s", peer)
    except Exception:
        log.exception("handler")
    finally:
        stop.set()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


async def main() -> None:
    """Khởi động server WebSocket; chạy đến khi process bị kill (``await Future()``)."""
    host = "0.0.0.0"
    port = config.listen_port()
    config.decode_executor()

    async with websockets.serve(
        handler,
        host,
        port,
        max_size=12 * 1024 * 1024,
    ):
        ex = config.decode_executor()
        nw = getattr(ex, "_max_workers", None)
        log.info(
            "WebSocket barcode server ws://%s:%s (%s) | queue=latest-frame | workers=%s",
            host,
            port,
            "OpenCV + pyzbar" if config.PYZBAR_AVAILABLE else "chỉ OpenCV BarcodeDetector",
            nw if nw is not None else "?",
        )
        await asyncio.Future()
