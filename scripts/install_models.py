#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(item: dict, root: Path, allow_unverified: bool) -> None:
    target = root / item["path"]
    expected = item.get("sha256")
    if not expected and not allow_unverified:
        raise RuntimeError(
            f"{item['id']}: expected SHA-256 is not registered; "
            "review the upstream file and rerun with --allow-unverified only for a controlled first install"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        actual = sha256(target)
        if expected and actual != expected:
            raise RuntimeError(f"{item['id']}: existing file hash mismatch")
        print(f"ok       {item['id']} {actual}")
        return
    temporary = target.with_suffix(target.suffix + ".part")
    headers = {"User-Agent": "chatos-image-installer/0.1"}
    token = os.environ.get("CIVITAI_TOKEN")
    if token and "civitai.com" in item["url"]:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(item["url"], headers=headers)
    print(f"download {item['id']} -> {target}", flush=True)
    digest = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
        while chunk := response.read(8 * 1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
    actual = digest.hexdigest()
    if expected and actual != expected:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"{item['id']}: downloaded file hash mismatch ({actual})")
    temporary.replace(target)
    print(f"installed {item['id']} {actual}")
    if not expected:
        print(f"REGISTER_SHA256 {item['id']} {actual}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--registry", type=Path, default=Path(__file__).parents[1] / "config/model-registry.json")
    parser.add_argument("--allow-unverified", action="store_true")
    parser.add_argument("--only", action="append", default=[])
    args = parser.parse_args()
    registry = json.loads(args.registry.read_text(encoding="utf-8"))
    selected = [item for item in registry["files"] if not args.only or item["id"] in args.only]
    unknown = set(args.only) - {item["id"] for item in selected}
    if unknown:
        raise RuntimeError(f"unknown model ids: {', '.join(sorted(unknown))}")
    for item in selected:
        download(item, args.model_root, args.allow_unverified)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
