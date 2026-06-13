import { Engine } from './engine.js?v=8';
import { Executor } from './executor.js?v=8';
import { ServerASR } from './recorder.js?v=8';
import { HybridASR, TTS } from './speech.js?v=8';

const $ = (id) => document.getElementById(id);

const dom = {
  board: $('board'),
  micBtn: $('mic-btn'),
  micIndicator: $('mic-indicator'),
  statusText: $('status-text'),
  interim: $('interim'),
  heard: $('heard'),
  parsed: $('parsed'),
  source: $('source'),
  log: $('log'),
  textInput: $('text-input'),
  sendBtn: $('send-btn'),
  loadingOverlay: $('loading-overlay'),
  loadingText: $('loading-text'),
  volumeFill: $('volume-fill'),
  micStatus: $('mic-status'),
};

const engine = new Engine(dom.board);
const tts = new TTS();
const executor = new Executor(engine, { onFeedback: handleFeedback });

let processing = false;
let chatHistory = [];
let serverStatus = { llm: false, image: false, asr_ready: false, asr_engine: 'whisper' };
let asrLoggedReady = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function addLog(text, who = 'bot') {
  const item = document.createElement('div');
  item.className = 'log-item ' + who;
  const label = { user: '你', bot: '助手', warn: '提示' }[who] || who;
  item.innerHTML = `<span class="who">${label}</span>${escapeHtml(text)}`;
  dom.log.appendChild(item);
  dom.log.scrollTop = dom.log.scrollHeight;
}

async function handleFeedback(fb) {
  addLog(fb.text, fb.level === 'warn' ? 'warn' : 'bot');
  asr.pauseForPlayback();
  await tts.speak(fb.text);
  if (asr.wantsListen) asr.resumeAfterPlayback();
}

function shouldIgnoreHeard(text) {
  if (!text) return true;
  if (processing || tts.speaking) return true;
  if (tts.isEcho(text)) return true;
  return false;
}

function setStatus(text) { dom.statusText.textContent = text; }

function setSource(src, label) {
  const map = {
    llm: ['AI 大脑', 'llm'],
    wanx: ['通义万相', 'wanx'],
    fail: ['失败', ''],
  };
  const [txt, cls] = map[src] || [label || '—', ''];
  dom.source.textContent = txt;
  dom.source.className = 'badge ' + cls;
}

function showLoading(text) {
  dom.loadingText.textContent = text;
  dom.loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  dom.loadingOverlay.classList.add('hidden');
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    serverStatus = await res.json();
    if (serverStatus.llm) addLog('AI 大脑已连接，可以说任意绘图指令。', 'bot');
    if (serverStatus.image) addLog('通义万相已启用：说「画一只猫」生成图片，再说「给猫戴顶帽子」可在原图上修改。', 'bot');
    addLog('语音识别：优先使用浏览器原生（快速），不可用时自动切云端。', 'bot');
    if (!serverStatus.asr_ready) {
      addLog('云端识别备用通道加载中…', 'bot');
    }
  } catch {
    addLog('无法连接后端，请运行 run_web.bat 启动服务。', 'warn');
  }
}

function updateAsrState() {
  asr.setServerReady({
    asr_ready: serverStatus.asr_ready,
    whisper_ready: serverStatus.whisper_ready,
  });
  if (!asrLoggedReady) {
    addLog('点击「开始聆听」，直接说「画一只猫」等指令。', 'bot');
    asrLoggedReady = true;
  }
  if (dom.micStatus && !asr.listening) {
    dom.micStatus.textContent = asr.mode === 'browser'
      ? '浏览器语音识别 · 点击「开始聆听」'
      : (serverStatus.asr_ready ? '云端识别已就绪' : '云端识别加载中…');
  }
}

async function pollAsrReady() {
  if (serverStatus.asr_ready) return;
  try {
    const res = await fetch('/api/status');
    serverStatus = await res.json();
    updateAsrState();
  } catch (_) {}
  if (!serverStatus.asr_ready) {
    setTimeout(pollAsrReady, 1500);
  }
}

async function callLLM(text) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      canvas_context: engine.getContext(),
      chat_history: chatHistory.map(([user, bot]) => ({ user, bot })),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function callGenerateImage(prompt) {
  const res = await fetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, staged: true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function callEditImage(prompt, imageName) {
  const res = await fetch('/api/edit-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_name: imageName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function drawStrokeSequence(strokeCmds) {
  for (const c of strokeCmds) {
    const shape = engine.addStroke({ ...c, animate: true });
    const len = engine.strokeLen(shape.points, shape.closed) || 60;
    const dur = Math.max(120, Math.min(550, len * 1.3));
    await engine.animateStroke(shape, dur);
  }
  engine.pushHistory();
}

async function handleUtterance(text) {
  text = text.trim();
  if (shouldIgnoreHeard(text)) return;

  dom.heard.textContent = text;
  addLog(text, 'user');

  const norm = text.replace(/[，。\s]/g, '');
  if (/^(保存|导出|下载)(图片|画布|作品|这幅画)?$/.test(norm)) {
    const ok = engine.exportCanvas();
    await handleFeedback({
      text: ok
        ? (engine.shapes.length ? '画布已导出，请到下载文件夹查看。' : '画布是空的。')
        : '导出失败，请重试。',
      level: ok && engine.shapes.length ? 'bot' : 'warn',
    });
    return;
  }
  if (/^(帮助|帮助一下|有什么指令|能做什么)$/.test(norm)) {
    openHelp();
    await handleFeedback({ text: '已打开帮助。', level: 'bot' });
    return;
  }

  if (executor.pendingConfirm && executor.handleConfirmation(text)) {
    dom.parsed.textContent = '确认响应';
    return;
  }

  if (!serverStatus.llm) {
    addLog('LLM 未配置，请检查 config.json 后重启 run_web.bat。', 'warn');
    return;
  }

  processing = true;
  asr.pauseForPlayback();
  showLoading('AI 理解中…');
  setStatus('AI 思考中…');
  setSource('llm');

  try {
    let { commands, summary, error } = await callLLM(text);

    if (error === 'timeout') {
      showLoading('AI 重试中…');
      ({ commands, summary, error } = await callLLM(text));
    }

    hideLoading();

    if (error && !commands?.length) {
      let msg;
      if (error === 'empty') msg = 'AI 没能理解，请说具体一点，例如「画一只橘猫」';
      else if (error === 'conn') msg = '网络连接被中断，请检查网络或代理后重试';
      else if (error === 'timeout') msg = 'AI 响应超时，请重试';
      else msg = `AI 出错：${error}`;
      addLog(msg, 'warn');
      await handleFeedback({ text: msg, level: 'warn' });
      setSource('fail');
      return;
    }

    if (!commands?.length) {
      addLog('AI 没能理解，请换个说法。', 'warn');
      return;
    }

    const strokeCmds = commands.filter(c => c.action === 'stroke');
    const imgCmds = commands.filter(c => c.action === 'generate_image');
    const editCmds = commands.filter(c => c.action === 'edit_image');
    const skip = ['generate_image', 'stroke', 'edit_image'];
    const rest = commands.filter(c => !skip.includes(c.action));
    const onlyReply = commands.length === 1 && commands[0].action === 'reply';

    if (onlyReply) {
      dom.parsed.textContent = commands[0].text || '';
      await handleFeedback({ text: commands[0].text || '', level: 'bot' });
      chatHistory.push([text, commands[0].text || '']);
      return;
    }

    dom.parsed.textContent = summary
      || (editCmds.length ? (editCmds[0].prompt?.slice(0, 40) || '修改画面')
        : strokeCmds.length ? '逐笔绘制中…'
        : (imgCmds[0]?.prompt?.slice(0, 40) || '执行指令'));

    // 1) 先执行非绘制类指令（清空 / 撤销 / 移动 / 删除等），直接执行不确认
    if (rest.length) {
      const hasDrawing = strokeCmds.length || imgCmds.length || editCmds.length;
      await executor.enqueue(rest, { summary: '', silent: hasDrawing });
    }

    // 2) 一笔一笔画
    if (strokeCmds.length) {
      setSource('llm');
      setStatus('正在画…');
      await drawStrokeSequence(strokeCmds);
    }

    // 3) 文生图：AI 成图 → 分阶段（底稿→色块→成品）逐层画出来
    for (const ic of imgCmds) {
      const prompt = ic.prompt || text;
      showLoading('AI 构思画面中…（约 10~20 秒）');
      setStatus('AI 作画中…');
      setSource('wanx');
      try {
        const { url, stages } = await callGenerateImage(prompt);
        hideLoading();
        if (stages?.length) {
          setStatus('起稿 → 铺色 → 细节…');
          addLog('分阶段作画：先起底稿，再铺色，最后出细节。', 'bot');
          await engine.paintStages({ url, stages, x: ic.x, y: ic.y, w: ic.w, h: ic.h, prompt });
        } else {
          setStatus('正在展示画面…');
          await engine.placeImage({ url, x: ic.x, y: ic.y, w: ic.w, h: ic.h, prompt, animate: true });
        }
      } catch (e) {
        hideLoading();
        addLog('图片生成失败：' + e.message, 'warn');
        await handleFeedback({ text: '图片生成失败：' + e.message, level: 'warn' });
      }
    }

    // 3b) 对话式改图：在当前图片上按指令修改，替换后重新揭示
    let edited = false;
    for (const ec of editCmds) {
      const target = engine.lastImage();
      if (!target || !target.url) {
        addLog('画布上还没有图片，先说「画一只猫」再修改。', 'warn');
        await handleFeedback({ text: '画布上还没有图片，先画一张再修改。', level: 'warn' });
        break;
      }
      const name = target.url.split('/').pop();
      showLoading('AI 修改画面中…（约 15~30 秒）');
      setStatus('AI 改图中…');
      setSource('wanx');
      try {
        const { url } = await callEditImage(ec.prompt || text, name);
        hideLoading();
        setStatus('正在重画…');
        const { x, y, w, h } = target;
        const newPrompt = (target.prompt ? target.prompt + '；' : '') + (ec.prompt || text);
        engine.removeShapeSilent(target.id);
        await engine.placeImage({ url, x, y, w, h, prompt: newPrompt, animate: true });
        edited = true;
      } catch (e) {
        hideLoading();
        addLog('改图失败：' + e.message, 'warn');
        await handleFeedback({ text: '改图失败：' + e.message, level: 'warn' });
      }
    }

    // 4) 统一反馈（纯清空/移动等已在 executor 里播报，不重复说「已完成」）
    const onlyOps = rest.length && !strokeCmds.length && !imgCmds.length && !editCmds.length;
    if (!onlyOps) {
      const doneMsg = summary || (edited ? '改好了。' : strokeCmds.length ? '画好了。' : (imgCmds.length ? '生成好了。' : ''));
      if (doneMsg) {
        await handleFeedback({ text: doneMsg, level: 'bot' });
        chatHistory.push([text, doneMsg]);
      }
    } else if (summary && !/已完成|完成/.test(summary)) {
      await handleFeedback({ text: summary, level: 'bot' });
      chatHistory.push([text, summary]);
    }
    if (chatHistory.length > 10) chatHistory.shift();

  } catch (e) {
    hideLoading();
    addLog('请求失败：' + e.message, 'warn');
    await handleFeedback({ text: '网络错误，请确认 run_web.bat 正在运行。', level: 'warn' });
  } finally {
    processing = false;
    hideLoading();
    if (asr.wantsListen) asr.resumeAfterPlayback();
    setStatus(asr.listening ? '聆听中…' : '就绪');
  }
}

// ---------- 语音：浏览器原生识别（快） + 云端备用 ----------
const asr = new HybridASR({
  onInterim: (t) => {
    dom.interim.textContent = t;
    dom.interim.classList.remove('hidden');
  },
  onFinal: (t) => {
    dom.interim.classList.add('hidden');
    if (shouldIgnoreHeard(t)) return;
    handleUtterance(t);
  },
  onState: (listening) => {
    dom.micIndicator.classList.toggle('on', listening);
    dom.micIndicator.classList.toggle('off', !listening);
    dom.micBtn.classList.toggle('listening', listening);
    dom.micBtn.querySelector('.mic-label').textContent = listening ? '停止聆听' : '开始聆听';
    if (!processing) setStatus(listening ? '聆听中…' : '就绪');
    if (!listening) {
      dom.interim.classList.add('hidden');
      dom.volumeFill.style.width = '0%';
      if (dom.micStatus) dom.micStatus.textContent = '点击「开始聆听」后说话';
    } else if (dom.micStatus) {
      dom.micStatus.textContent = '正在聆听，说完自动识别';
    }
  },
  onLevel: (level) => {
    dom.volumeFill.style.width = Math.round(level * 100) + '%';
    if (level > 0.12) dom.volumeFill.style.background = '#34d399';
    else if (level > 0.04) dom.volumeFill.style.background = '#6d9eff';
    else dom.volumeFill.style.background = '#444';
  },
  onStatus: (msg) => {
    if (dom.micStatus) dom.micStatus.textContent = msg;
    if (msg.includes('识别中')) {
      dom.interim.textContent = '云端识别中…';
      dom.interim.classList.remove('hidden');
    }
  },
  onError: (code, msg) => {
    if (code === 'not-allowed') {
      setStatus('麦克风被拒绝');
      addLog(msg || '请在浏览器地址栏允许麦克风。', 'warn');
    } else if (code !== 'browser-fallback') {
      addLog('语音识别：' + (msg || code), 'warn');
    }
  },
});
asr.attachServer(ServerASR);

if (!asr.supported) {
  setStatus('浏览器不支持麦克风');
  addLog('当前浏览器无法访问麦克风，请用 Chrome 或 Edge。', 'warn');
  dom.micBtn.disabled = true;
}

dom.micBtn.addEventListener('click', () => asr.toggle());

dom.sendBtn.addEventListener('click', () => {
  const t = dom.textInput.value.trim();
  if (t) { dom.textInput.value = ''; handleUtterance(t); }
});
dom.textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dom.sendBtn.click();
});

async function exportCanvas() {
  const ok = engine.exportCanvas();
  const msg = ok
    ? (engine.shapes.length ? '画布已导出，请到下载文件夹查看。' : '画布是空的，没有可导出的内容。')
    : '导出失败，请重试。';
  await handleFeedback({ text: msg, level: ok && engine.shapes.length ? 'bot' : 'warn' });
}

function openHelp() { $('help-modal').classList.remove('hidden'); }
$('help-btn').addEventListener('click', openHelp);
$('export-btn').addEventListener('click', exportCanvas);
$('help-close').addEventListener('click', () => $('help-modal').classList.add('hidden'));

async function boot() {
  setStatus('就绪');
  try {
    await fetchStatus();
    updateAsrState();
    if (!serverStatus.asr_ready) pollAsrReady();
  } catch (e) {
    addLog('无法连接后端，请运行 run_web.bat 后刷新页面。', 'warn');
    setStatus('未连接服务');
  }
}
boot();
