from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from tokenizers import Tokenizer


class PromptTokenGuard:
    def __init__(self) -> None:
        root = Path(os.environ.get("TOKENIZER_PATH", "/opt/ComfyUI/models/tokenizers"))
        self.tokenizers = {
            "wai_v17": Tokenizer.from_file(str(root / "clip_tokenizer.json")),
            "anima_base_10": Tokenizer.from_file(str(root / "qwen3_tokenizer.json")),
        }

    def validate(self, prompt: dict[str, Any], model_key: str) -> None:
        tokenizer = self.tokenizers.get(model_key)
        if tokenizer is None:
            raise ValueError("unsupported model tokenizer")
        for node in prompt.values():
            if node.get("class_type") != "CLIPTextEncode":
                continue
            text = str(node.get("inputs", {}).get("text", ""))
            title = str(node.get("_meta", {}).get("title", ""))
            limit = 2048 if title == "Negative prompt" else 1024
            if len(tokenizer.encode(text).ids) > limit:
                raise ValueError("prompt token limit exceeded")
