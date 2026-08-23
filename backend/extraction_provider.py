"""AI extraction providers: Omniroute (primary) → Ollama (fallback).

Omniroute is a local OpenAI-compatible gateway (default http://localhost:20128/v1).
Both providers share the same OpenAI chat-completions JSON shape, so a single
``_chat_completion`` helper serves text and vision requests.
"""

from __future__ import annotations

import base64
import asyncio
import logging
import os

import httpx

log = logging.getLogger("uvicorn.error")

OMNIROUTE_BASE_URL = os.environ.get(
    "OMNIROUTE_BASE_URL", "http://localhost:20128/v1"
).rstrip("/")
OMNIROUTE_API_KEY = os.environ.get("OMNIROUTE_API_KEY", "")
EXTRACTION_MODEL = os.environ.get("EXTRACTION_MODEL", "auto/best-fast")
VISION_MODEL = os.environ.get("VISION_MODEL", "auto/best-vision")
OLLAMA_BASE_URL = os.environ.get("LLM_BASE_URL", "http://localhost:11434").rstrip("/")
OLLAMA_VISION_MODEL = os.environ.get("OLLAMA_VISION_MODEL", "llama3.2-vision")
TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "120"))


async def _chat_completion(
    base_url: str,
    model: str,
    messages: list[dict],
    api_key: str = "",
    max_tokens: int = 4096,
) -> str:
    """OpenAI-compatible chat completion → the model's text content.

    Transient 5xx responses (the Omniroute gateway is occasionally flaky) are
    retried once with a short backoff.
    """
    url = f"{base_url}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "stream": False,  # Omniroute defaults to SSE; require plain JSON
    }

    async def _once() -> str:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
        return data["choices"][0]["message"]["content"]

    try:
        return await _once()
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code >= 500:
            await asyncio.sleep(1.0)
            return await _once()
        raise


# ---------------------------------------------------------------------------
# Text extraction (Omniroute)
# ---------------------------------------------------------------------------
async def query_omniroute_text(prompt: str) -> str | None:
    """Send an itinerary prompt to Omniroute; returns raw content or None."""
    try:
        return await _chat_completion(
            OMNIROUTE_BASE_URL,
            EXTRACTION_MODEL,
            [{"role": "user", "content": prompt}],
            OMNIROUTE_API_KEY,
        )
    except Exception as exc:
        log.warning("Omniroute text extraction failed (%s): %s", EXTRACTION_MODEL, exc)
        return None


# ---------------------------------------------------------------------------
# Vision extraction (screenshots / scanned docs)
# ---------------------------------------------------------------------------
def _image_messages(image_bytes: bytes, mime: str) -> list[dict]:
    b64 = base64.b64encode(image_bytes).decode()
    return [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "This image contains a travel itinerary. Extract the "
                    "visited locations following the instructions.",
                },
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        }
    ]


async def query_omniroute_vision(image_bytes: bytes, mime: str = "image/png") -> str | None:
    """Send an image to Omniroute's vision model; returns raw content or None."""
    try:
        return await _chat_completion(
            OMNIROUTE_BASE_URL,
            VISION_MODEL,
            _image_messages(image_bytes, mime),
            OMNIROUTE_API_KEY,
        )
    except Exception as exc:
        log.warning("Omniroute vision extraction failed (%s): %s", VISION_MODEL, exc)
        return None


async def query_ollama_vision(image_bytes: bytes, mime: str = "image/png") -> str | None:
    """Fallback: Ollama's native /api/generate with an image (vision model)."""
    try:
        b64 = base64.b64encode(image_bytes).decode()
        payload = {
            "model": OLLAMA_VISION_MODEL,
            "prompt": "This image contains a travel itinerary. Extract the visited "
            "locations following the instructions.",
            "images": [b64],
            "stream": False,
            "num_predict": 4096,
            "options": {"temperature": 0.0},
        }
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.post(f"{OLLAMA_BASE_URL}/api/generate", json=payload)
            r.raise_for_status()
            data = r.json()
        return data.get("response") or None
    except Exception as exc:
        log.warning("Ollama vision extraction failed (%s): %s", OLLAMA_VISION_MODEL, exc)
        return None
