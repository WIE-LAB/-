"""应用配置：LLM、万相、Whisper 兜底、画布参数。"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"


@dataclass
class AppConfig:
    # Whisper ASR 兜底（云端不可用时）
    whisper_model: str = "tiny"
    whisper_device: str = "cpu"
    whisper_compute: str = "int8"
    # LLM 指令理解（OpenAI 兼容）
    llm_base: str = ""
    llm_key: str = ""
    llm_model: str = "gpt-4o-mini"
    # 通义万相文生图 / 改图（阿里云百炼，兼作云端 ASR Key）
    image_api_key: str = ""
    image_model: str = "wan2.6-t2i"
    image_edit_model: str = "wan2.6-image"
    image_size: str = "1280*1280"
    # 画布
    canvas_width: int = 960
    canvas_height: int = 540

    @classmethod
    def load(cls) -> "AppConfig":
        if CONFIG_PATH.exists():
            try:
                data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
            except Exception:
                pass
        return cls()

    def save(self) -> None:
        CONFIG_PATH.write_text(
            json.dumps(asdict(self), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
