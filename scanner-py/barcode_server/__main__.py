"""Cho phép: ``python -m barcode_server`` (tương đương ``python server.py``)."""

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
