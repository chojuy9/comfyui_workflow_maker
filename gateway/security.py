from __future__ import annotations

import hmac
from pathlib import PurePosixPath
from typing import Any


ALLOWED_NODE_TYPES = {
    "CheckpointLoaderSimple",
    "UNETLoader",
    "CLIPLoader",
    "VAELoader",
    "LoraLoader",
    "LoraLoaderModelOnly",
    "CLIPTextEncode",
    "EmptyLatentImage",
    "LoadImage",
    "ImageScale",
    "VAEEncode",
    "KSampler",
    "VAEDecode",
    "UpscaleModelLoader",
    "ImageUpscaleWithModel",
    "SaveImage",
}

ALLOWED_MODEL_FILES = {
    "waiIllustriousSDXL_v170.safetensors",
    "anima-base-v1.0.safetensors",
    "qwen_3_06b_base.safetensors",
    "qwen_image_vae.safetensors",
    "RealESRGAN_x2plus.pth",
    "atomsphere_style_v1.2-anima-e20.safetensors",
    "anima_context_detailer_base10.safetensors",
    "anima_base_slider_step800.safetensors",
    "748cmSDXL.safetensors",
    "teddy-lingerie-illustriousxl-lora-nochekaiser.safetensors",
}

FILE_INPUTS = {"ckpt_name", "unet_name", "clip_name", "vae_name", "model_name", "lora_name"}


class UnsafeWorkflow(ValueError):
    pass


def authenticate(provided: str | None, expected: str) -> None:
    if not provided or not hmac.compare_digest(provided, f"Bearer {expected}"):
        raise PermissionError("unauthorized")


def validate_prompt(prompt: dict[str, Any]) -> None:
    if not isinstance(prompt, dict) or not 5 <= len(prompt) <= 32:
        raise UnsafeWorkflow("invalid node count")
    save_count = 0
    for node_id, node in prompt.items():
        if not str(node_id).isdigit() or not isinstance(node, dict):
            raise UnsafeWorkflow("invalid node identifier")
        class_type = node.get("class_type")
        if class_type not in ALLOWED_NODE_TYPES:
            raise UnsafeWorkflow("node type is not allowed")
        if class_type == "SaveImage":
            save_count += 1
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            raise UnsafeWorkflow("node inputs are missing")
        for name in FILE_INPUTS:
            if name not in inputs:
                continue
            filename = inputs[name]
            if not isinstance(filename, str) or filename not in ALLOWED_MODEL_FILES:
                raise UnsafeWorkflow("model file is not allowed")
            if PurePosixPath(filename).name != filename:
                raise UnsafeWorkflow("model path traversal")
        if class_type == "LoadImage" and inputs.get("image") != "__INPUT_IMAGE__":
            raise UnsafeWorkflow("untrusted input image reference")
        if class_type == "SaveImage":
            prefix = str(inputs.get("filename_prefix", ""))
            if not prefix.startswith("chatos/") or ".." in prefix:
                raise UnsafeWorkflow("invalid output prefix")
    if save_count != 1:
        raise UnsafeWorkflow("workflow must have exactly one SaveImage node")
