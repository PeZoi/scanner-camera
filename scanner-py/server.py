"""
Điểm vào chạy server quét barcode (WebSocket).

Logic nằm trong package ``barcode_server/`` (module nhỏ, có docstring/comment chi tiết).

Chạy từ thư mục ``scanner-py``::

    python server.py

Hoặc::

    python -m barcode_server
"""

from __future__ import annotations

import asyncio
import logging
import sys

logging.basicConfig(level=logging.INFO)

from barcode_server.websocket_server import main

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.getLogger("pybarcode").info("Đã dừng server (Ctrl+C).")
        sys.exit(0)
