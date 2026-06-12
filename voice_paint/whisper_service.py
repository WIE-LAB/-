"""Web 端上传音频的 Whisper 识别（单例模型）。"""
from __future__ import annotations

import io
import threading
import tempfile
import wave
from pathlib import Path

import numpy as np

from .config import AppConfig

try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None  # type: ignore

_model: WhisperModel | None = None
_model_lock = threading.Lock()
_ready = threading.Event()
_loading = False
_status = "未加载"


def whisper_status() -> str:
    return _status


def is_whisper_ready() -> bool:
    return _ready.is_set() and _model is not None


def preload_whisper(cfg: AppConfig) -> None:
    global _loading
    if _model or _loading:
        return
    _loading = True
    threading.Thread(target=_load_sync, args=(cfg,), daemon=True).start()


def _load_sync(cfg: AppConfig) -> None:
    global _model, _loading, _status
    try:
        if WhisperModel is None:
            raise RuntimeError("未安装 faster-whisper")
        _status = "加载中"
        with _model_lock:
            if _model is None:
                _model = WhisperModel(
                    cfg.whisper_model,
                    device=cfg.whisper_device,
                    compute_type=cfg.whisper_compute,
                )
        _status = "就绪"
        _ready.set()
    except Exception as e:
        _status = f"失败: {e}"
    finally:
        _loading = False


def _wait_ready(timeout: float = 300) -> WhisperModel:
    global _model
    if not _ready.wait(timeout):
        raise RuntimeError("Whisper 模型加载超时")
    if _model is None:
        raise RuntimeError(_status)
    return _model


def _pcm_from_wav(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data), "rb") as wf:
        frames = wf.readframes(wf.getnframes())
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if wf.getnchannels() > 1:
            audio = audio.reshape(-1, wf.getnchannels()).mean(axis=1)
        return audio


def transcribe_upload(data: bytes, cfg: AppConfig, filename: str = "audio.webm") -> str:
    """识别浏览器上传的录音（webm / wav）。"""
    if not data:
        raise ValueError("音频为空")
    if not _model and not _loading:
        preload_whisper(cfg)
    model = _wait_ready()

    suffix = Path(filename).suffix.lower() or ".webm"
    if suffix == ".wav":
        audio = _pcm_from_wav(data)
        peak = float(np.max(np.abs(audio))) or 1.0
        audio = (audio / peak * 0.95).astype(np.float32)
        segments, _ = model.transcribe(
            audio,
            language="zh",
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            initial_prompt="画圆、画鸟、画猫、撤销、清空、画一只",
        )
    else:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(data)
            path = f.name
        try:
            segments, _ = model.transcribe(
                path,
                language="zh",
                beam_size=1,
                vad_filter=True,
                condition_on_previous_text=False,
                initial_prompt="画圆、画鸟、画猫、撤销、清空、画一只",
            )
        finally:
            Path(path).unlink(missing_ok=True)

    return "".join(seg.text for seg in segments).strip()
