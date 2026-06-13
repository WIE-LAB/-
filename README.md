# 语音绘图工具 · VoicePaint

一款**纯语音控制**的 AI 绘图 Web 应用。用户通过麦克风说出指令完成创作，无需在画布上使用鼠标或键盘。

## 功能概览

- **AI 文生图**：说「画一只可爱的小猫」→ 通义万相生成插画，**分阶段作画**（底稿 → 色块 → 成品）
- **对话式改图**：说「给猫戴顶帽子」「把背景换成星空」→ 在原图基础上修改
- **矢量编辑**：移动、缩放、改色、撤销、清空等均可语音完成
- **复合指令**：「先清空画布，然后画一棵树」→ AI 自动拆解为多步执行
- **导出画布**：说「保存图片」或点右上角「导出」→ 下载 PNG
- **语音反馈**：TTS 播报结果；播报期间自动暂停收音，避免回声循环
- **快速识别**：优先浏览器原生语音识别（边说边出字），不可用时自动切云端

## 快速启动

双击 **`run_web.bat`** → 自动打开浏览器 `http://127.0.0.1:8765`

1. 点击 **「开始聆听」**（首次需授权麦克风）
2. 直接说指令，例如「画一只猫」
3. 等待 AI 理解并执行，结果以语音 + 日志反馈

> 请用 **Chrome 或 Edge**，允许麦克风权限。  
> 若启动报端口占用，脚本会自动关闭旧进程；也可手动关掉之前的黑窗口后重试。

或手动运行：

```bash
git clone https://github.com/WIE-LAB/-.git
cd -
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python -m voice_paint.web_server
```

浏览器访问 `http://127.0.0.1:8765`。

## 示例指令

| 类别 | 示例 |
|---|---|
| AI 创作 | 画一只橘猫 / 画春天的风景 |
| 对话改图 | 给猫戴顶帽子 / 把背景换成夜空 |
| 编辑 | 移到右边 / 放大一点 / 撤销 / 清空画布 |
| 导出 | 保存图片 / 导出画布 |
| 简单图形 | 画一个红色的圆 |
| 复合 | 先清空画布，然后画一棵大树 |
| 帮助 | 说「帮助」查看说明 |

## 配置

仓库内已包含 `config.json`（含演示用 API Key），克隆后可直接运行。

| 字段 | 用途 |
|---|---|
| `llm_key` | DeepSeek 等 LLM，用于理解自然语言 |
| `image_api_key` | 阿里云百炼 Key：语音识别 + 文生图 + 改图 |

也可参考 `config.example.json` 自行填写。

## 项目结构

```
voice_paint/              Python 后端
  web_server.py           Web 服务（FastAPI）
  cloud_asr.py            阿里云语音识别（云端备用）
  whisper_service.py      本地 Whisper 兜底
  image_gen.py            通义万相文生图 + 改图
  paint_stages.py         分阶段作画素材（底稿/色块）
  nlu/llm.py              AI 主脑（指令理解）
web/                      Web 前端
  js/app.js               主逻辑、语音管线
  js/speech.js            浏览器 ASR + 云端混合识别
  js/recorder.js          云端录音识别（备用）
  js/engine.js            Canvas 引擎 + 分阶段动画
  js/executor.js          指令执行
run_web.bat               一键启动（自动释放 8765 端口）
设计文档.md               设计说明（计划 vs 实现）
```

## 环境要求

- Windows 10/11
- Python 3.10+
- 麦克风
- Chrome / Edge 浏览器
- 网络连接（LLM + 万相 API；云端 ASR 为备用）

## 设计文档

详见 [`设计文档.md`](./设计文档.md)。

## GitHub 仓库

[https://github.com/WIE-LAB/-](https://github.com/WIE-LAB/-)
