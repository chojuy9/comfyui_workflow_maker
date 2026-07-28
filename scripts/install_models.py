#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class StripAuthOnRedirect(urllib.request.HTTPRedirectHandler):
    """다른 호스트로 넘어갈 때 Authorization 헤더를 뗍니다.

    civitai 는 다운로드 요청을 서명이 붙은 CDN 주소로 넘깁니다. 그 주소에는
    이미 인증 정보가 들어 있어서, Authorization 헤더까지 같이 가면 인증 방식이
    둘이 된 셈이라 CDN 이 400 으로 거절합니다. 토큰이 틀린 게 아니라
    토큰을 두 번 보낸 게 문제라, 401 이 아니라 400 이 나와서 헷갈립니다.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        if urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            new.remove_header("Authorization")
        return new


OPENER = urllib.request.build_opener(StripAuthOnRedirect)


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
    # 환경변수에 공백이나 줄바꿈이 딸려 들어오는 일이 잦습니다.
    # 그대로 헤더에 넣으면 civitai 가 401 이 아니라 400 을 돌려줘서 원인을 찾기 어려워요.
    token = (os.environ.get("CIVITAI_TOKEN") or "").strip()
    if token and "civitai.com" in item["url"]:
        if not token.isascii() or any(c.isspace() for c in token):
            raise RuntimeError(
                "CIVITAI_TOKEN 에 공백이나 이상한 문자가 들어 있습니다. "
                "값을 다시 확인하세요 (앞뒤 공백, 따옴표, 줄바꿈)."
            )
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(item["url"], headers=headers)
    print(f"download {item['id']} -> {target}", flush=True)
    digest = hashlib.sha256()
    try:
        response = OPENER.open(request, timeout=120)
    except urllib.error.HTTPError as error:
        # 상태 코드만 보면 원인을 못 찾습니다. 본문 앞부분을 같이 보여줍니다.
        body = ""
        try:
            body = error.read(400).decode("utf-8", "replace").strip()
        except Exception:
            pass
        hint = ""
        if error.code in (401, 403):
            hint = " — CIVITAI_TOKEN 을 확인하세요."
        elif error.code == 400:
            hint = " — 주소나 인증 방식 문제입니다. 응답 본문을 보세요."
        raise RuntimeError(
            f"{item['id']}: HTTP {error.code} {error.reason}{hint}\n"
            f"  주소: {item['url']}\n"
            f"  응답: {body or '(본문 없음)'}"
        ) from None
    with response, temporary.open("wb") as output:
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
