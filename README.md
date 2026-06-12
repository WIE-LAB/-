# 语音绘图工具 · VoicePaint

一款**纯语音控制**的 AI 绘图 Web 应用。用户通过麦克风说出指令完成创作，无需在画布上使用鼠标或键盘。

## 功能概览

- **AI 文生图**：说「画一只可爱的小猫」→ 通义万相生成高质量插画，以笔刷动画逐步显现
- **对话式改图**：说「给猫戴顶帽子」「把背景换成星空」→ 在原图基础上修改，而非重新生成
- **矢量编辑**：移动、缩放、改色、撤销、清空等操作均可语音完成
- **复合指令**：「先清空画布，然后画一棵树」→ AI 自动拆解为多步执行
- **语音反馈**：TTS 播报执行结果，对话日志实时显示

## 快速启动

双击 **`run_web.bat`** → 自动打开浏览器 `http://127.0.0.1:8765`

1. 点击 **「开始聆听」**（首次需授权麦克风，浏览器安全策略要求）
2. 对着麦克风说话，**说完稍停约 1 秒**
3. 等待 AI 理解并执行，结果以语音 + 日志反馈

> 请用 **Chrome 或 Edge**，允许麦克风权限。

或手动运行：

```bash
cd "C:\Users\ASUS\Desktop\语言绘画工具"
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python -m voice_paint.web_server
```

浏览器访问 `http://127.0.0.1:8765`。

## 示例指令

| 类别 | 示例 |
|---|---|
| AI 创作 | 画一只橘猫 / 画春天的风景 / 画一辆红色小汽车 |
| 对话改图 | 给猫戴顶帽子 / 把背景换成夜空 / 让它躺下来 |
| 编辑 | 移到右边 / 放大一点 / 撤销 / 清空画布 |
| 简单图形 | 画一个红色的圆 / 画三个蓝色方块排成一行 |
| 复合 | 先清空画布，然后画一棵大树和太阳 |
| 帮助 | 说「帮助」查看指令说明 |

## 配置

仓库内已包含 `config.json`（含演示用 API Key），克隆后可直接运行。

| 字段 | 用途 |
|---|---|
| `llm_key` | DeepSeek 等 LLM，用于理解自然语言 |
| `image_api_key` | 阿里云百炼 Key，用于语音识别 + 文生图 + 改图 |

也可参考 `config.example.json` 自行填写。

## 项目结构

```
voice_paint/              Python 后端
  web_server.py           Web 服务（FastAPI）
  cloud_asr.py            阿里云语音识别
  whisper_service.py      本地 Whisper 兜底
  image_gen.py            通义万相文生图 + 改图
  nlu/llm.py              AI 主脑（指令理解）
  config.py               配置读写
web/                      Web 前端
  index.html              页面
  js/app.js               主逻辑
  js/recorder.js          麦克风 + VAD
  js/engine.js            Canvas 引擎 + 笔刷动画
  js/executor.js          指令执行
run_web.bat               一键启动
设计文档.md               设计说明（计划 vs 实现）
config.json               运行配置
```

## 环境要求

- Windows 10/11
- Python 3.10+
- 麦克风
- Chrome / Edge 浏览器
- 网络连接（LLM + 万相 + 云端 ASR）

## 设计文档

详见 [`设计文档.md`](./设计文档.md)，包含：

- 指令能力计划 vs 实现对照表
- 未完成部分及原因说明
- 准确性、延迟、复杂指令拆解的技术方案

## GitHub 仓库

[https://github.com/WIE-LAB/-](https://github.com/WIE-LAB/-)

### 克隆使用

```bash
git clone https://github.com/WIE-LAB/-.git
cd -
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

Windows 下双击 `run_web.bat` 一键启动。
