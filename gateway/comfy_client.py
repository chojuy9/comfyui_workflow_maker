from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any

import httpx


class ComfyError(RuntimeError):
    pass


class ComfyClient:
    def __init__(self, base_url: str, timeout_seconds: int = 600) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    async def upload_image(self, path: Path, remote_name: str) -> str:
        async with httpx.AsyncClient(timeout=60) as client:
            with path.open("rb") as source:
                response = await client.post(
                    f"{self.base_url}/upload/image",
                    data={"type": "input", "overwrite": "true"},
                    files={"image": (remote_name, source, "image/png")},
                )
            response.raise_for_status()
            payload = response.json()
            return payload.get("name", remote_name)

    async def run(self, prompt: dict[str, Any], client_id: str | None = None) -> bytes:
        client_id = client_id or str(uuid.uuid4())
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{self.base_url}/prompt",
                json={"prompt": prompt, "client_id": client_id},
            )
            if response.status_code >= 400:
                raise ComfyError(f"ComfyUI rejected workflow ({response.status_code})")
            prompt_id = response.json().get("prompt_id")
            if not prompt_id:
                raise ComfyError("ComfyUI did not return a prompt_id")

        history = await self._wait_for_history(prompt_id)
        image = self._last_output_image(history)
        params = {
            "filename": image["filename"],
            "subfolder": image.get("subfolder", ""),
            "type": image.get("type", "output"),
        }
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(f"{self.base_url}/view", params=params)
            response.raise_for_status()
            return response.content

    async def _wait_for_history(self, prompt_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout_seconds
        delay = 0.35
        async with httpx.AsyncClient(timeout=30) as client:
            while time.monotonic() < deadline:
                response = await client.get(f"{self.base_url}/history/{prompt_id}")
                response.raise_for_status()
                data = response.json()
                if prompt_id in data:
                    entry = data[prompt_id]
                    status = entry.get("status", {})
                    if status.get("status_str") == "error":
                        raise ComfyError("ComfyUI execution failed")
                    if entry.get("outputs"):
                        return entry
                await asyncio.sleep(delay)
                delay = min(delay * 1.35, 2.0)
        raise ComfyError("ComfyUI generation timed out")

    @staticmethod
    def _last_output_image(history: dict[str, Any]) -> dict[str, Any]:
        candidates: list[dict[str, Any]] = []
        for output in history.get("outputs", {}).values():
            candidates.extend(output.get("images", []))
        if not candidates:
            raise ComfyError("ComfyUI completed without an image")
        return candidates[-1]
