"""阿里云 Paraformer 语音识别（百炼 DashScope，无需本地 Whisper）。"""
from __future__ import annotations

import tempfile
from pathlib import Path

from .config import AppConfig

try:
    import dashscope
    from dashscope.audio.asr import Recognition
except ImportError:
    dashscope = None  # type: ignore
    Recognition = None  # type: ignore


def cloud_asr_enabled(cfg: AppConfig) -> bool:
    return bool(cfg.image_api_key and Recognition is not None)


def transcribe_cloud(data: bytes, cfg: AppConfig, filename: str = "speech.wav") -> str:
    if not cloud_asr_enabled(cfg):
        raise RuntimeError("未配置阿里云 API Key 或未安装 dashscope")
    assert dashscope is not None and Recognition is not None

    dashscope.api_key = cfg.image_api_key
    suffix = Path(filename).suffix.lower() or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        path = f.name

    fmt = "wav" if suffix == ".wav" else "opus" if "webm" in suffix or suffix == ".opus" else "wav"
    try:
        recognition = Recognition(
            model="paraformer-realtime-v2",
            format=fmt,
            sample_rate=16000,
            language_hints=["zh", "en"],
            callback=None,
        )
        result = recognition.call(path)
        if result.status_code != 200:
            raise RuntimeError(getattr(result, "message", None) or f"ASR HTTP {result.status_code}")
        sentence = result.get_sentence()
        if isinstance(sentence, dict):
            text = (sentence.get("text") or "").strip()
        elif isinstance(sentence, list):
            text = "".join(
                (s.get("text") or "") if isinstance(s, dict) else str(s) for s in sentence
            ).strip()
        else:
            text = str(sentence or "").strip()
        return text
    finally:
        Path(path).unlink(missing_ok=True)
