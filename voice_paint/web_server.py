"""VoicePaint Web 服务：静态页面 + LLM/万相 API。"""
from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import AppConfig
from .cloud_asr import cloud_asr_enabled, transcribe_cloud
from .image_gen import (
    CACHE_DIR,
    edit_image,
    generate_image,
    image_edit_enabled,
    image_gen_enabled,
)
from .paint_stages import make_stages
from .whisper_service import is_whisper_ready, preload_whisper, transcribe_upload, whisper_status

from .nlu.llm import llm_enabled, parse_with_llm

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"

app = FastAPI(title="VoicePaint Web")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_cfg: AppConfig | None = None


def get_cfg() -> AppConfig:
    global _cfg
    if _cfg is None:
        _cfg = AppConfig.load()
    return _cfg


class HistoryItem(BaseModel):
    user: str
    bot: str


class ChatRequest(BaseModel):
    text: str
    canvas_context: dict | None = None
    chat_history: list[HistoryItem] = Field(default_factory=list)


class ImageRequest(BaseModel):
    prompt: str
    staged: bool = True


class EditRequest(BaseModel):
    prompt: str
    image_name: str


@app.get("/api/status")
def api_status() -> dict:
    cfg = get_cfg()
    use_cloud = cloud_asr_enabled(cfg)
    return {
        "llm": llm_enabled(cfg),
        "image": image_gen_enabled(cfg),
        "image_edit": image_edit_enabled(cfg),
        "asr_engine": "cloud" if use_cloud else "whisper",
        "asr_ready": use_cloud or is_whisper_ready(),
        "whisper": whisper_status(),
        "whisper_ready": is_whisper_ready(),
        "canvas_width": cfg.canvas_width,
        "canvas_height": cfg.canvas_height,
    }


@app.post("/api/transcribe")
async def api_transcribe(file: UploadFile = File(...)) -> dict:
    cfg = get_cfg()
    data = await file.read()
    if len(data) < 100:
        raise HTTPException(400, "录音太短，请大声说话后再试")

    filename = file.filename or "speech.webm"
    text = ""
    errors: list[str] = []
    if cloud_asr_enabled(cfg):
        try:
            text = transcribe_cloud(data, cfg, filename=filename)
        except Exception as e:
            errors.append(f"云端: {e}")
    if not text and is_whisper_ready():
        try:
            text = transcribe_upload(data, cfg, filename=filename)
        except Exception as e:
            errors.append(f"Whisper: {e}")
    elif not text and not cloud_asr_enabled(cfg) and not is_whisper_ready():
        raise HTTPException(503, "语音识别未就绪，请稍候或先用文字输入")
    if not text and errors:
        raise HTTPException(502, "；".join(errors))

    if not text:
        return {"text": "", "detail": "未识别到文字"}
    return {"text": text}


@app.post("/api/chat")
def api_chat(req: ChatRequest) -> dict:
    cfg = get_cfg()
    if not llm_enabled(cfg):
        raise HTTPException(400, "未配置 LLM API")
    history = [(h.user, h.bot) for h in req.chat_history]
    commands, summary, err = parse_with_llm(
        req.text.strip(),
        cfg,
        canvas_context=req.canvas_context,
        chat_history=history,
        timeout=45,
    )
    if err in ("timeout", "conn"):
        commands, summary, err = parse_with_llm(
            req.text.strip(), cfg,
            canvas_context=req.canvas_context,
            chat_history=history,
            timeout=90,
        )
    return {"commands": commands, "summary": summary, "error": err}


@app.post("/api/generate-image")
def api_generate_image(req: ImageRequest) -> dict:
    cfg = get_cfg()
    if not image_gen_enabled(cfg):
        raise HTTPException(400, "未配置文生图 API")
    path, err = generate_image(req.prompt.strip(), cfg)
    if err or not path:
        raise HTTPException(502, err or "生成失败")
    url = f"/api/images/{path.name}"
    stages: list[str] = []
    if req.staged:
        try:
            stages = [f"/api/images/{n}" for n in make_stages(path)]
        except Exception:
            stages = []
    return {"url": url, "stages": stages}


@app.post("/api/edit-image")
def api_edit_image(req: EditRequest) -> dict:
    cfg = get_cfg()
    if not image_edit_enabled(cfg):
        raise HTTPException(400, "未配置图像编辑 API")
    name = req.image_name
    if not name or ".." in name or "/" in name or "\\" in name:
        raise HTTPException(400, "非法文件名")
    src = CACHE_DIR / name
    if not src.exists():
        raise HTTPException(404, "原图不存在，请重新生成后再编辑")
    path, err = edit_image(src.read_bytes(), req.prompt.strip(), cfg)
    if err or not path:
        raise HTTPException(502, err or "改图失败")
    return {"url": f"/api/images/{path.name}"}


@app.get("/api/images/{name}")
def api_serve_image(name: str) -> FileResponse:
    if ".." in name or "/" in name or "\\" in name:
        raise HTTPException(400, "非法文件名")
    path = CACHE_DIR / name
    if not path.exists():
        raise HTTPException(404, "图片不存在")
    mime, _ = mimetypes.guess_type(path.name)
    return FileResponse(path, media_type=mime or "image/png")


_NOCACHE = "no-cache, no-store, must-revalidate"


class DevStaticFiles(StaticFiles):
    """开发期禁用 JS/CSS/HTML 强缓存，避免模块版本不一致。"""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if path.endswith((".js", ".html", ".css")):
            response.headers["Cache-Control"] = _NOCACHE
            response.headers["Pragma"] = "no-cache"
        return response


@app.get("/")
def index() -> FileResponse:
    r = FileResponse(WEB_DIR / "index.html")
    r.headers["Cache-Control"] = _NOCACHE
    return r


app.mount("/static", DevStaticFiles(directory=WEB_DIR), name="static")


def main() -> None:
    import uvicorn

    cfg = get_cfg()
    print("=" * 48)
    print("  VoicePaint Web · 语音绘图")
    print("=" * 48)
    print(f"  打开: http://127.0.0.1:8765")
    print(f"  LLM: {'已连接' if llm_enabled(cfg) else '未配置'}")
    print(f"  万相: {'已启用' if image_gen_enabled(cfg) else '未配置'}")
    if cloud_asr_enabled(cfg):
        print("  语音识别: 阿里云 Paraformer（即时可用，无需等待）")
    else:
        preload_whisper(cfg)
        print(f"  语音识别: 本地 Whisper ({cfg.whisper_model})，后台加载中…")
    print("  请用 Edge/Chrome，允许麦克风，大声说完停 1 秒")
    print("=" * 48)
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")


if __name__ == "__main__":
    main()
