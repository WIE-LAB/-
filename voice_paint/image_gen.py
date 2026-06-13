"""通义万相文生图 / 图像编辑（阿里云百炼 DashScope）。"""
from __future__ import annotations

import base64
import hashlib
import time
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter

try:
    from urllib3.util.retry import Retry
except Exception:  # pragma: no cover
    Retry = None  # type: ignore

from .config import AppConfig

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "images"
WANX_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"

_session = requests.Session()
if Retry is not None:
    _adapter = HTTPAdapter(max_retries=Retry(
        total=3, connect=3, read=2, backoff_factor=0.8,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset(["GET", "POST"]),
    ))
    _session.mount("https://", _adapter)
    _session.mount("http://", _adapter)


def _post_wanx(payload: dict, api_key: str, timeout: float) -> tuple[dict | None, str | None]:
    """调用万相接口，连接被重置（10053/10054）时自动重试。"""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Connection": "close",
    }
    last_err: str | None = None
    for i in range(3):
        try:
            res = _session.post(WANX_URL, headers=headers, json=payload, timeout=timeout)
            data = res.json()
            if res.status_code != 200:
                return None, str(data.get("message") or data.get("code") or f"HTTP {res.status_code}")
            return data, None
        except requests.Timeout:
            return None, "timeout"
        except (requests.ConnectionError, requests.exceptions.ChunkedEncodingError) as e:
            last_err = f"网络连接中断: {e}"
            if i < 2:
                time.sleep(1.0 * (i + 1))
                continue
    return None, last_err or "网络错误"


def _download_image(url: str, attempts: int = 4) -> bytes:
    """下载图片，校验完整性并在中断时重试（应对 IncompleteRead）。"""
    last_err: Exception | None = None
    for i in range(attempts):
        try:
            with _session.get(url, timeout=90, stream=True) as r:
                r.raise_for_status()
                expected = int(r.headers.get("Content-Length") or 0)
                buf = bytearray()
                for chunk in r.iter_content(chunk_size=65536):
                    if chunk:
                        buf.extend(chunk)
                if expected and len(buf) < expected:
                    raise OSError(f"下载不完整：{len(buf)}/{expected}")
                if not buf:
                    raise OSError("下载内容为空")
                return bytes(buf)
        except Exception as e:  # 包含 ChunkedEncodingError / IncompleteRead / 超时
            last_err = e
            if i < attempts - 1:
                time.sleep(0.8 * (i + 1))
    raise last_err or OSError("下载失败")


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
    payload = {
        "model": cfg.image_model,
        "input": {"messages": [{"role": "user", "content": [{"text": prompt}]}]},
        "parameters": {
            "prompt_extend": True,
            "watermark": False,
            "n": 1,
            "size": cfg.image_size,
        },
    }
    try:
        data, err = _post_wanx(payload, cfg.image_api_key, timeout=120)
        if err == "timeout":
            return None, "文生图超时（约 120 秒），请稍后重试"
        if err or not data:
            return None, err or "生成失败"

        img_url = _extract_image_url(data)
        if not img_url:
            return None, "API 响应中没有图片地址"

        content = _download_image(img_url)
        slug = hashlib.md5(f"{prompt}{time.time()}".encode()).hexdigest()[:12]
        path = CACHE_DIR / f"wanx_{slug}.png"
        path.write_bytes(content)
        return path, None
    except Exception as e:
        return None, f"网络错误: {e}"


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
    payload = {
        "model": cfg.image_edit_model,
        "input": {
            "messages": [
                {"role": "user", "content": [{"text": prompt}, {"image": data_uri}]},
            ],
        },
        "parameters": {
            "prompt_extend": True,
            "watermark": False,
            "n": 1,
            "enable_interleave": False,
        },
    }
    try:
        data, err = _post_wanx(payload, cfg.image_api_key, timeout=180)
        if err == "timeout":
            return None, "改图超时（约 180 秒），请稍后重试"
        if err or not data:
            return None, err or "改图失败"

        img_url = _extract_image_url(data)
        if not img_url:
            return None, "API 响应中没有图片地址"

        content = _download_image(img_url)
        slug = hashlib.md5(f"edit{prompt}{time.time()}".encode()).hexdigest()[:12]
        path = CACHE_DIR / f"wanx_{slug}.png"
        path.write_bytes(content)
        return path, None
    except Exception as e:
        return None, f"网络错误: {e}"


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
