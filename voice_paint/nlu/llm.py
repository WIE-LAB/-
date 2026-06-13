"""LLM 主脑：理解任意自然语言，拆解为可执行的绘图指令序列。"""
from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from typing import Any

import requests
from requests.adapters import HTTPAdapter

try:
    from urllib3.util.retry import Retry
except Exception:  # pragma: no cover
    Retry = None  # type: ignore

from ..config import AppConfig
from ..image_gen import image_gen_enabled

SYSTEM_PROMPT = """你是语音绘图 AI。画布 {width}x{height}px，原点左上，图形用中心点(x,y)。

## 画布现状（含颜色分组，便于移动整组）
{canvas_state}

## 对话上下文
{chat_history}

## 输出 JSON（必须含 commands 数组，不能为空）
{"commands":[...],"summary":"一句中文"}

## 画画（核心方式：AI 生成真实画作）
画具体物体（猫、狗、树、房子、人、花、风景…）时，用 generate_image 让 AI 画出真正好看的图，画布会把它「一笔一笔」揭示出来。详见下方「文生图」。

只有以下简单情况才用 stroke 矢量线条（不要拿 stroke 去画复杂物体，会很丑）：
- 用户明确说「画一条线 / 画个圈 / 随手画 / 涂鸦 / 签名」等纯线条需求。
- stroke: {"action":"stroke","points":[[x,y],...],"color":"black","width":5,"closed":false,"fill":null}

## 其他指令
- place: {"action":"place","shape":"circle|rect|triangle|line|star|heart","x":int,"y":int,"size":int,"color":"red"} 单个几何图形
- move: {"action":"move","dx":150,"dy":0} 平移；也可用 position（left/right/top/bottom/center/top-left…）
- move_group: {"action":"move_group","color":"red","dx":150,"dy":0} 按颜色移动整组（仅用于彩色几何图形）
- delete: {"action":"delete"} 删除目标
- resize: {"action":"resize","factor":1.5} 放大缩小；factor>1 放大，<1 缩小
- clear/undo/redo/recolor/text 等同理
- export: {"action":"export"} 保存/导出当前画布为 PNG（「保存图片」「导出画布」「下载作品」等）
- reply: 仅纯聊天时用

## 操作画布上的「图片」（重点！）
AI 生成的画是「图片」对象，**没有颜色**。当用户要移动/缩放/删除画布上那张画（说"它/这张/这幅/图/小猫/把画…"）时：
- 必须加 `"target":"image"`，**绝对不要写 color 字段**（图片没有颜色，写 color 会找不到目标）。
- 移动：{"action":"move","target":"image","dx":200,"dy":0} 或 {"action":"move","target":"image","position":"right"}
- 缩放：{"action":"resize","target":"image","factor":1.4}
- 删除：{"action":"delete","target":"image"}
- 注意：移动图片用 move（不是 move_group）。

{image_instructions}

## 关键规则
1. commands 不能为空！必须给出可执行指令。
2. 「画一只猫/树/房子/风景…」等创作 → 默认用 generate_image 生成真实画作，不要用 stroke 或 place 拼几何（那样很丑）。
2b. 画布已有图片、用户想在这张画上改内容（戴帽子/换背景/换颜色/换姿势/加东西…）→ 用 edit_image，不要重新 generate_image。
3. 移动/缩放/删除画布上的「图片」→ 用 target:image，不要写 color！只有彩色几何图形才用 color 定位。
4. 所有 x,y,size,width 必须是整数，不能 null。"""

IMAGE_INSTRUCTIONS = """
## 文生图（从无到有画一幅新画）
画任何具体物体/场景（猫、狗、树、房子、人、花、风景、卡通形象…）都用这个：
- generate_image: {"action":"generate_image","prompt":"详细中文画面描述","x":{center_x},"y":{center_y},"w":{width},"h":{height}}

**背景规则（重要）**：
- 用户只说一个主体（如「画一只小猫」「画一辆汽车」「画一朵花」），没提场景/环境 → prompt 必须写「纯白色背景，无背景，主体居中，干净简洁」，只画主体，不要自己加草地/天空等背景。
- 用户描述了场景/环境（如「小猫在草地上玩耍」「夕阳下的海边」「夜空中的城堡」）→ 才把对应背景写进 prompt。

示例：
  「画一只小猫」→ "一只可爱的橘色小猫，圆圆的大眼睛，坐着，卡通插画风格，纯白色背景，无背景装饰，主体居中"
  「画一只小猫在草地上玩耍」→ "一只橘色小猫在绿色草地上玩耍，蓝天白云，阳光明媚，卡通插画风格"
  「画春天的风景」→ "春天的田野风景，绿草地，盛开的花朵，蓝天白云，远处青山，水彩插画风格"
要点：prompt 用中文，含主体+特征+风格(+背景仅在用户提到时)，w/h 必须铺满画布（见宽高），居中，一次通常 1 条。

## 改图（画布上已有图片时，按指令修改它）
当画布上已存在 AI 图片（看"画布现状"里有"图片"），且用户想在这幅画上修改/增删内容时，用 edit_image 而不是重新 generate_image：
- edit_image: {"action":"edit_image","prompt":"编辑指令(中文)"}
适用："给猫戴顶帽子"、"把背景换成夜空"、"让它躺下来"、"把毛色改成黑色"、"加一只蝴蝶"、"变成水彩风格"等。
prompt 写法：明确写"添加/修改/把…换成"等操作词，只描述这次的改动，例如"给小猫头上添加一顶红色圣诞帽"。
区分：用户想要"另画一张/重新画/换一只别的"→用 generate_image；想在当前这张上改→用 edit_image。
"""

IMAGE_INSTRUCTIONS_OFF = ""

RETRY_PROMPT = """上次返回的 commands 为空，这是错误的！
用户要求：{user_text}
你必须返回至少一条可执行指令（move_group/move/delete/place 等）来完成用户意图。
不要只给 summary，commands 数组不能为空。"""

_session = requests.Session()
if Retry is not None:
    _retry = Retry(
        total=3,
        connect=3,
        read=2,
        backoff_factor=0.6,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset(["POST"]),
    )
    _adapter = HTTPAdapter(max_retries=_retry)
    _session.mount("https://", _adapter)
    _session.mount("http://", _adapter)


def llm_enabled(cfg: AppConfig) -> bool:
    return bool(cfg.llm_base and cfg.llm_key and cfg.llm_model)


def _normalize_commands(commands: list[dict[str, Any]], cw: int, ch: int) -> list[dict[str, Any]]:
    out = []
    for c in commands:
        cmd = dict(c)
        a = cmd.get("action")
        # 目标为图片：转 target_shape=image，清掉颜色（图片无颜色）
        if cmd.get("target") == "image" or cmd.get("target_shape") == "image":
            cmd["target_shape"] = "image"
            cmd.pop("target", None)
            cmd.pop("color", None)
            cmd.pop("target_color", None)
            if a == "move_group":
                cmd["action"] = a = "move"
        # 统一 color / target_color
        if cmd.get("color") and not cmd.get("target_color"):
            cmd["target_color"] = cmd["color"]
        if a in ("move", "move_group", "delete") and cmd.get("target_color") and not cmd.get("color"):
            cmd["color"] = cmd["target_color"]
        if a == "place":
            cmd.setdefault("shape", "circle")
            if cmd.get("x") is None:
                cmd["x"] = cw // 2
            if cmd.get("y") is None:
                cmd["y"] = ch // 2
            if cmd.get("size") is None:
                cmd["size"] = 100
            if cmd.get("rotation") is None:
                cmd["rotation"] = 0
        elif a == "draw":
            if cmd.get("size") is None:
                cmd["size"] = 100
            if cmd.get("count") is None:
                cmd["count"] = 1
        elif a == "text":
            if cmd.get("x") is None:
                cmd["x"] = cw // 2
            if cmd.get("y") is None:
                cmd["y"] = ch // 2
            if cmd.get("size") is None:
                cmd["size"] = 48
        elif a == "move":
            # 图片移动保持 move（不转 move_group）；只有彩色几何才转整组
            if cmd.get("color") and not cmd.get("target") and cmd.get("target_shape") != "image":
                cmd["action"] = "move_group"
        elif a == "resize":
            if cmd.get("factor") is None and cmd.get("size") is None:
                cmd["factor"] = 1.3
        elif a == "rotate" and cmd.get("degrees") is None:
            cmd["degrees"] = 45
        elif a == "generate_image":
            if not cmd.get("prompt"):
                cmd["prompt"] = "一幅美丽的插画"
            if cmd.get("x") is None:
                cmd["x"] = cw // 2
            if cmd.get("y") is None:
                cmd["y"] = ch // 2
            # 铺满画布，只留极小边距
            margin = 8
            full_w, full_h = cw - margin, ch - margin
            if cmd.get("w") is None:
                cmd["w"] = full_w
            if cmd.get("h") is None:
                cmd["h"] = full_h
            # LLM 若给了正方形小尺寸，强制铺满画布
            if cmd["w"] < cw * 0.85 or cmd["h"] < ch * 0.85:
                cmd["w"], cmd["h"] = full_w, full_h
        elif a == "edit_image":
            if not cmd.get("prompt"):
                cmd["prompt"] = (cmd.get("text") or "").strip()
            if not cmd.get("prompt"):
                continue  # 没有编辑指令，跳过
        elif a == "stroke":
            pts = cmd.get("points") or cmd.get("path") or []
            clean: list[list[int]] = []
            for p in pts:
                if isinstance(p, dict):
                    px, py = p.get("x"), p.get("y")
                elif isinstance(p, (list, tuple)) and len(p) >= 2:
                    px, py = p[0], p[1]
                else:
                    continue
                try:
                    clean.append([int(round(float(px))), int(round(float(py)))])
                except (TypeError, ValueError):
                    continue
            cmd["points"] = clean
            if not cmd.get("width"):
                cmd["width"] = 5
            cmd.setdefault("closed", False)
            if "fill" not in cmd:
                cmd["fill"] = None
            # 去掉 stroke 误带的 target_color，避免被当成移动目标
            cmd.pop("target_color", None)
        if a == "stroke" and len(cmd.get("points", [])) < 2:
            continue  # 无效笔画，跳过
        out.append(cmd)
    return out


def _format_canvas_state(ctx: dict[str, Any] | None) -> str:
    if not ctx or not ctx.get("shapes"):
        return "画布为空"
    shapes = ctx["shapes"]
    lines = []
    images = [s for s in shapes if s.get("type") == "image"]
    if images:
        for im in images:
            desc = (im.get("prompt") or "").strip() or "一幅图片"
            lines.append(f"【图片】id{im['id']} 内容：{desc}")
    groups: dict[str, list] = defaultdict(list)
    for s in shapes:
        if s.get("type") == "image":
            continue
        groups[s.get("color_name", s["color"])].append(s)
    for cn, items in groups.items():
        cx = sum(s["x"] for s in items) // len(items)
        cy = sum(s["y"] for s in items) // len(items)
        types = ", ".join(sorted({s["type"] for s in items}))
        lines.append(f"【{cn}色组】{len(items)}个({types}) 群组中心({cx},{cy})")
    non_images = [s for s in shapes if s.get("type") != "image"]
    if non_images:
        lines.append("---每个图形---")
        for s in non_images:
            cn = s.get("color_name", "?")
            lines.append(f"  id{s['id']} {s['type']} ({s['x']},{s['y']}) {cn} sz{s['size']}")
    return "\n".join(lines)


def _format_history(history: list[tuple[str, str]] | None) -> str:
    if not history:
        return "（无）"
    lines = []
    for user, bot in history[-4:]:
        lines.append(f"用户: {user}")
        lines.append(f"助手: {bot}")
    return "\n".join(lines)


def _call_api(
    cfg: AppConfig,
    system: str,
    user: str,
    timeout: float,
) -> tuple[dict[str, Any] | None, str | None]:
    url = cfg.llm_base.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {cfg.llm_key}",
        "Content-Type": "application/json",
        # 不复用长连接，避免被中间防火墙掐断的旧 socket 触发 10053
        "Connection": "close",
    }
    payload = {
        "model": cfg.llm_model,
        "temperature": 0.2,
        "max_tokens": 4096,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }

    # 针对连接被中断（10053 等）做指数退避重试
    for attempt in range(3):
        try:
            res = _session.post(url, headers=headers, json=payload, timeout=timeout)
            res.raise_for_status()
            content = res.json()["choices"][0]["message"]["content"]
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip())
            return json.loads(content), None
        except requests.Timeout:
            return None, "timeout"
        except requests.HTTPError as e:
            code = e.response.status_code if e.response is not None else "?"
            return None, f"HTTP {code}"
        except (requests.ConnectionError, requests.exceptions.ChunkedEncodingError):
            if attempt < 2:
                time.sleep(0.8 * (attempt + 1))
                continue
            return None, "conn"
        except Exception as e:
            return None, str(e)
    return None, "conn"


def _parse_response(parsed: dict[str, Any] | list, w: int, h: int) -> tuple[list[dict[str, Any]], str]:
    if isinstance(parsed, list):
        return _normalize_commands(parsed, w, h), ""
    commands = parsed.get("commands") or parsed.get("actions") or []
    summary = parsed.get("summary") or parsed.get("message") or ""
    return _normalize_commands(commands, w, h), summary


def parse_with_llm(
    text: str,
    cfg: AppConfig,
    canvas_context: dict[str, Any] | None = None,
    chat_history: list[tuple[str, str]] | None = None,
    timeout: float = 45.0,
) -> tuple[list[dict[str, Any]], str, str | None]:
    if not llm_enabled(cfg):
        return [], "", "未配置 AI 接口"

    w = canvas_context.get("width", 960) if canvas_context else 960
    h = canvas_context.get("height", 540) if canvas_context else 540
    if image_gen_enabled(cfg):
        img_block = (
            IMAGE_INSTRUCTIONS
            .replace("{center_x}", str(w // 2))
            .replace("{center_y}", str(h // 2))
            .replace("{width}", str(w - 8))
            .replace("{height}", str(h - 8))
        )
    else:
        img_block = IMAGE_INSTRUCTIONS_OFF
    prompt = (
        SYSTEM_PROMPT
        .replace("{width}", str(w))
        .replace("{height}", str(h))
        .replace("{canvas_state}", _format_canvas_state(canvas_context))
        .replace("{chat_history}", _format_history(chat_history))
        .replace("{image_instructions}", img_block)
    )

    parsed, err = _call_api(cfg, prompt, text, timeout)
    if err:
        return [], "", err
    assert parsed is not None
    commands, summary = _parse_response(parsed, w, h)

    # 空 commands 时强制重试
    if not commands:
        retry_user = RETRY_PROMPT.replace("{user_text}", text)
        parsed2, err2 = _call_api(cfg, prompt, retry_user, timeout)
        if err2:
            return [], summary, "empty"
        if parsed2:
            commands, summary2 = _parse_response(parsed2, w, h)
            if summary2:
                summary = summary2

    if not commands:
        return [], summary, "empty"

    return [{**c, "confidence": 0.95, "source": "llm"} for c in commands], summary, None
