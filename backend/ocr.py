"""Lightweight OCR for screenshots using RapidOCR (self-contained ONNX models).

No system tesseract required — the models ship inside the Python package.
"""

from __future__ import annotations

import io
import logging

log = logging.getLogger("uvicorn.error")

_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR

        _engine = RapidOCR()
        log.info("RapidOCR engine initialised.")
    return _engine


def extract_image_text(image_bytes: bytes) -> str:
    """OCR an image (bytes) to plain text; returns \"\" on failure/empty."""
    try:
        import numpy as np
        from PIL import Image

        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        arr = np.array(img)
        engine = _get_engine()
        result, _elapse = engine(arr)
        if not result:
            return ""
        lines = [
            str(item[1]).strip()
            for item in result
            if len(item) > 1 and item[1] and str(item[1]).strip()
        ]
        return "\n".join(lines)
    except Exception as exc:
        log.warning("OCR failed: %s", exc)
        return ""
