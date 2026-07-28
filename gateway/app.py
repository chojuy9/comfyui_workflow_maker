from __future__ import annotations

import asyncio
import io
import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image, ImageOps

from comfy_client import ComfyClient, ComfyError
from security import UnsafeWorkflow, authenticate, validate_prompt
from token_guard import PromptTokenGuard

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
GATEWAY_TOKEN = os.environ.get("GATEWAY_TOKEN", "")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 4096 * 4096
ALLOWED_INPUTS = {"PNG", "JPEG", "WEBP", "AVIF"}
generation_lock = asyncio.Lock()
app = FastAPI(title="chatos image GPU gateway", docs_url=None, redoc_url=None)
comfy = ComfyClient(COMFY_URL)
token_guard: PromptTokenGuard | None = None


def require_auth(value: str | None) -> None:
    if not GATEWAY_TOKEN:
        raise HTTPException(503, "gateway is not configured")
    try:
        authenticate(value, GATEWAY_TOKEN)
    except PermissionError as exc:
        raise HTTPException(401, "unauthorized") from exc


def normalize_input(data: bytes, width: int, height: int, fit: str) -> bytes:
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("input image exceeds 10 MiB")
    with Image.open(io.BytesIO(data)) as image:
        if image.format not in ALLOWED_INPUTS:
            raise ValueError("unsupported input image format")
        if image.width > 4096 or image.height > 4096 or image.width * image.height > MAX_PIXELS:
            raise ValueError("input image exceeds the 4K limit")
        image = ImageOps.exif_transpose(image).convert("RGB")
        if fit == "center_crop":
            image = ImageOps.fit(image, (width, height), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        elif fit == "contain":
            contained = ImageOps.contain(image, (width, height), method=Image.Resampling.LANCZOS)
            canvas = Image.new("RGB", (width, height), (0, 0, 0))
            canvas.paste(contained, ((width - contained.width) // 2, (height - contained.height) // 2))
            image = canvas
        else:
            raise ValueError("unsupported fit mode")
        output = io.BytesIO()
        image.save(output, "PNG", optimize=True)
        return output.getvalue()


def convert_output(data: bytes, output_format: str) -> tuple[bytes, str]:
    if output_format == "png":
        return data, "image/png"
    if output_format != "webp":
        raise ValueError("unsupported output format")
    with Image.open(io.BytesIO(data)) as image:
        output = io.BytesIO()
        image.save(output, "WEBP", quality=95, method=6)
        return output.getvalue(), "image/webp"


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/generate")
async def generate(
    spec_json: Annotated[str, Form()],
    authorization: Annotated[str | None, Header()] = None,
    image: Annotated[UploadFile | None, File()] = None,
) -> Response:
    require_auth(authorization)
    try:
        spec = json.loads(spec_json)
        prompt = spec["prompt"]
        metadata = spec["metadata"]
        validate_prompt(prompt)
        global token_guard
        token_guard = token_guard or PromptTokenGuard()
        token_guard.validate(prompt, metadata["model"])
        width = int(metadata["baseWidth"])
        height = int(metadata["baseHeight"])
        if (width, height) not in {(832, 1216), (1216, 832), (1024, 1024)}:
            raise ValueError("unsupported base dimensions")
        load_nodes = [node for node in prompt.values() if node["class_type"] == "LoadImage"]
        if bool(load_nodes) != bool(image):
            raise ValueError("I2I image and workflow do not match")
        with tempfile.TemporaryDirectory(prefix="chatos-") as directory:
            if image:
                raw = await image.read(MAX_UPLOAD_BYTES + 1)
                normalized = normalize_input(raw, width, height, metadata.get("fitMode", "center_crop"))
                local_path = Path(directory) / "input.png"
                local_path.write_bytes(normalized)
                remote_name = f"chatos-{uuid.uuid4()}.png"
                uploaded_name = await comfy.upload_image(local_path, remote_name)
                load_nodes[0]["inputs"]["image"] = uploaded_name
            async with generation_lock:
                result = await comfy.run(prompt)
        converted, content_type = convert_output(result, metadata.get("outputFormat", "png"))
        return Response(
            converted,
            media_type=content_type,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )
    except (KeyError, TypeError, json.JSONDecodeError, ValueError, UnsafeWorkflow) as exc:
        raise HTTPException(400, "invalid generation request") from exc
    except ComfyError as exc:
        raise HTTPException(502, str(exc)) from exc
