from __future__ import annotations

import io
import json

from PIL import Image, PngImagePlugin

EXIF_USER_COMMENT = 0x9286


def generation_metadata(metadata: dict) -> dict:
    """파일에 넣어도 되는 재현 정보만 새 객체로 만듭니다.

    입력 이미지의 EXIF는 고의로 복사하지 않습니다. GPS·촬영자 정보가 결과물로
    새어 나오는 것을 막고, 이 서비스가 만든 생성 설정만 기록합니다.
    """
    keys = (
        "schemaVersion", "model", "preset", "width", "height", "positive",
        "negative", "seed", "steps", "cfg", "sampler", "scheduler", "loras",
        "upscale", "insertedTriggers", "outputFormat",
    )
    return {
        "generator": "chatos.page",
        **{key: metadata[key] for key in keys if key in metadata},
    }


def parameter_text(metadata: dict) -> str:
    positive = str(metadata.get("positive", ""))
    negative = str(metadata.get("negative", ""))
    settings = [
        f"Steps: {metadata.get('steps', '')}",
        f"Sampler: {metadata.get('sampler', '')}",
        f"Schedule type: {metadata.get('scheduler', '')}",
        f"CFG scale: {metadata.get('cfg', '')}",
        f"Seed: {metadata.get('seed', '')}",
        f"Size: {metadata.get('width', '')}x{metadata.get('height', '')}",
        f"Model: {metadata.get('model', '')}",
    ]
    loras = metadata.get("loras")
    if isinstance(loras, list) and loras:
        settings.append(
            "LoRAs: " + ", ".join(
                f"{item.get('id', '')}:{item.get('strength', '')}"
                for item in loras if isinstance(item, dict)
            )
        )
    return f"{positive}\nNegative prompt: {negative}\n{', '.join(settings)}"


def convert_output(data: bytes, output_format: str, metadata: dict) -> tuple[bytes, str]:
    embedded = generation_metadata(metadata)
    embedded_json = json.dumps(embedded, ensure_ascii=False, separators=(",", ":"))
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        output = io.BytesIO()
        if output_format == "png":
            pnginfo = PngImagePlugin.PngInfo()
            # ComfyUI의 prompt/workflow 청크가 있으면 함께 보존합니다.
            for key in ("prompt", "workflow"):
                value = image.text.get(key)
                if isinstance(value, str):
                    pnginfo.add_text(key, value)
            pnginfo.add_text("parameters", parameter_text(embedded))
            pnginfo.add_itxt("chatos", embedded_json)
            image.save(
                output,
                "PNG",
                optimize=True,
                pnginfo=pnginfo,
                icc_profile=image.info.get("icc_profile"),
            )
            return output.getvalue(), "image/png"
        if output_format == "webp":
            exif = Image.Exif()
            exif[EXIF_USER_COMMENT] = b"UNICODE\x00" + embedded_json.encode("utf-16-be")
            image.save(
                output,
                "WEBP",
                quality=95,
                method=6,
                exif=exif,
                icc_profile=image.info.get("icc_profile"),
            )
            return output.getvalue(), "image/webp"
        raise ValueError("unsupported output format")
