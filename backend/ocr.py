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
    """OCR an image (bytes) to plain text; returns "" on failure/empty."""
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


def extract_pdf_ocr_text(pdf_bytes: bytes, scale: float = 2.0) -> str:
    """OCR every page of a scanned PDF: render pages to images → RapidOCR.

    Returns the concatenated text ("" when the PDF can't be rendered/OCR'd).
    ``scale`` increases render resolution for better OCR on small text.
    """
    try:
        import pypdfium2 as pdfium
        import numpy as np

        engine = _get_engine()
        doc = pdfium.PdfDocument(pdf_bytes)
        pages_text: list[str] = []
        try:
            for page in doc:
                bitmap = page.render(scale=scale)
                pil = bitmap.to_pil().convert("RGB")
                result, _elapse = engine(np.array(pil))
                if result:
                    pages_text.append(
                        "\n".join(
                            str(item[1]).strip()
                            for item in result
                            if len(item) > 1 and item[1] and str(item[1]).strip()
                        )
                    )
        finally:
            doc.close()
        return "\n\n".join(p for p in pages_text if p)
    except Exception as exc:
        log.warning("PDF OCR failed: %s", exc)
        return ""
