"""
Gói xử lý quét barcode qua WebSocket (OpenCV + tùy chọn pyzbar).

Cấu trúc module:
- ``config``          : biến môi trường, hằng số, ThreadPool, detector OpenCV, cờ pyzbar
- ``models``          : kiểu dữ liệu ``BarcodeHit``
- ``geometry``        : chuẩn hóa bbox/polygon, diện tích đa giác
- ``gtin``            : kiểm tra checksum GS1 khi bật STRICT_GTIN
- ``preprocessing``   : gamma, CLAHE, sharpen, denoise, resize
- ``backends``        : OpenCV BarcodeDetector rồi pyzbar
- ``pipeline``        : chiến lược nhiều biến thể ảnh + ``decode_jpeg_bytes``
- ``protocol``        : parse JSON WebSocket → decode → dict trả client
- ``websocket_server``: handler asyncio, hàng đợi frame mới nhất, ``main()``

Điểm vào chương trình: từ thư mục ``scanner-py`` chạy ``python server.py`` hoặc
``python -m barcode_server`` (xem ``server.py`` / ``__main__.py``).
"""

__all__: list[str] = []
