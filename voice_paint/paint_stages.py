"""把一张 AI 成图派生为「分阶段绘画」中间帧：底稿 → 色块 → 成品。

只需一次文生图调用，即可在前端模拟「先起稿、再铺色、后出细节」的作画过程，
避免对复杂图做边缘提取产生的乱线，也不额外消耗 API 额度。
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def _read(path: Path) -> np.ndarray | None:
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def _write(path: Path, img: np.ndarray) -> bool:
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        return False
    buf.tofile(str(path))
    return True


def _pencil_sketch(img: np.ndarray) -> np.ndarray:
    """柔和铅笔底稿：浅灰线条 + 白底。"""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    inv = 255 - gray
    blur = cv2.GaussianBlur(inv, (0, 0), sigmaX=11)
    sketch = cv2.divide(gray, 255 - blur, scale=256)
    # 提亮，弱化线条，像起稿的淡铅笔
    sketch = cv2.normalize(sketch, None, 60, 255, cv2.NORM_MINMAX)
    return cv2.cvtColor(sketch, cv2.COLOR_GRAY2BGR)


def _color_blocks(img: np.ndarray, k: int = 8) -> np.ndarray:
    """平涂色块：颜色量化 + 平滑，模拟铺底色（无细节）。"""
    smooth = cv2.bilateralFilter(img, 9, 90, 90)
    data = smooth.reshape((-1, 3)).astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
    _, labels, centers = cv2.kmeans(
        data, k, None, criteria, 2, cv2.KMEANS_PP_CENTERS
    )
    quant = centers.astype(np.uint8)[labels.flatten()].reshape(img.shape)
    return cv2.GaussianBlur(quant, (0, 0), sigmaX=2)


def make_stages(image_path: Path) -> list[str]:
    """返回中间帧文件名列表（底稿、色块），失败则返回空。"""
    img = _read(image_path)
    if img is None:
        return []
    stem = image_path.stem
    out: list[str] = []
    try:
        sketch_path = image_path.with_name(f"{stem}_s1.png")
        if _write(sketch_path, _pencil_sketch(img)):
            out.append(sketch_path.name)
    except Exception:
        pass
    try:
        color_path = image_path.with_name(f"{stem}_s2.png")
        if _write(color_path, _color_blocks(img)):
            out.append(color_path.name)
    except Exception:
        pass
    return out
