"""通义万相文生图 / 图像编辑（阿里云百炼 DashScope）。"""
from __future__ import annotations

import base64
import hashlib
import time
from pathlib import Path

import requests

from .config import AppConfig

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "images"
WANX_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"


def image_gen_enabled(cfg: AppConfig) -> bool:
    return bool(cfg.image_api_key and cfg.image_model)


def image_edit_enabled(cfg: AppConfig) -> bool:
    return bool(cfg.image_api_key and getattr(cfg, "image_edit_model", ""))


def generate_image(prompt: str, cfg: AppConfig) -> tuple[Path | None, str | None]:
    """调用万相生成图片，返回本地缓存路径。"""
    prompt = (prompt or "").strip()
    if not prompt:
        return None, "缺少图片描述"
    if not image_gen_enabled(cfg):
        return None, "未配置文生图 API Key"

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        res = requests.post(
            WANX_URL,
            headers={
                "Authorization": f"Bearer {cfg.image_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": cfg.image_model,
                "input": {
                    "messages": [
                        {"role": "user", "content": [{"text": prompt}]},
                    ],
                },
                "parameters": {
                    "prompt_extend": True,
                    "watermark": False,
                    "n": 1,
                    "size": cfg.image_size,
                },
            },
            timeout=120,
        )
        data = res.json()
        if res.status_code != 200:
            err = data.get("message") or data.get("code") or f"HTTP {res.status_code}"
            return None, str(err)

        img_url = _extract_image_url(data)
        if not img_url:
            return None, "API 响应中没有图片地址"

        img_res = requests.get(img_url, timeout=60)
        img_res.raise_for_status()
        slug = hashlib.md5(f"{prompt}{time.time()}".encode()).hexdigest()[:12]
        path = CACHE_DIR / f"wanx_{slug}.png"
        path.write_bytes(img_res.content)
        return path, None
    except requests.Timeout:
        return None, "文生图超时（约 120 秒），请稍后重试"
    except requests.RequestException as e:
        return None, f"网络错误: {e}"
    except Exception as e:
        return None, str(e)


def edit_image(image_bytes: bytes, prompt: str, cfg: AppConfig) -> tuple[Path | None, str | None]:
    """对话式改图：在原图基础上按指令编辑，返回新图本地缓存路径。"""
    prompt = (prompt or "").strip()
    if not prompt:
        return None, "缺少编辑指令"
    if not image_edit_enabled(cfg):
        return None, "未配置图像编辑 API Key"
    if not image_bytes:
        return None, "缺少原图"

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    b64 = base64.b64encode(image_bytes).decode("ascii")
    data_uri = f"data:image/png;base64,{b64}"
    try:
        res = requests.post(
            WANX_URL,
            headers={
                "Authorization": f"Bearer {cfg.image_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": cfg.image_edit_model,
                "input": {
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"text": prompt},
                                {"image": data_uri},
                            ],
                        },
                    ],
                },
                "parameters": {
                    "prompt_extend": True,
                    "watermark": False,
                    "n": 1,
                    "enable_interleave": False,
                },
            },
            timeout=180,
        )
        data = res.json()
        if res.status_code != 200:
            err = data.get("message") or data.get("code") or f"HTTP {res.status_code}"
            return None, str(err)

        img_url = _extract_image_url(data)
        if not img_url:
            return None, "API 响应中没有图片地址"

        img_res = requests.get(img_url, timeout=60)
        img_res.raise_for_status()
        slug = hashlib.md5(f"edit{prompt}{time.time()}".encode()).hexdigest()[:12]
        path = CACHE_DIR / f"wanx_{slug}.png"
        path.write_bytes(img_res.content)
        return path, None
    except requests.Timeout:
        return None, "改图超时（约 180 秒），请稍后重试"
    except requests.RequestException as e:
        return None, f"网络错误: {e}"
    except Exception as e:
        return None, str(e)


def _extract_image_url(data: dict) -> str | None:
    output = data.get("output") or {}
    for choice in output.get("choices") or []:
        for item in choice.get("message", {}).get("content") or []:
            if item.get("image"):
                return item["image"]
            if item.get("url"):
                return item["url"]
    for item in output.get("results") or []:
        if item.get("url"):
            return item["url"]
    return None
