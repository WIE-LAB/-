// 浏览器 Web Speech API：连续识别 + 临时结果，低延迟。
export class ASR {
  constructor({ lang = 'zh-CN', onInterim, onFinal, onState, onError } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.listening = false;
    this.manualStop = false;
    this._restartTimer = null;

    if (!this.supported) return;

    const rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.listening = true;
      this.onState(true);
    };

    rec.onend = () => {
      this.listening = false;
      if (this.manualStop) {
        this.onState(false);
        return;
      }
      // 连续聆听：后台自动重启，不把按钮闪成「已停止」
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        if (!this.manualStop) this._doStart();
      }, 200);
    };

    rec.onerror = (e) => {
      const err = e.error || 'unknown';
      this.onError(err);
      if (err === 'no-speech' || err === 'aborted') return;
    };

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const txt = r[0].transcript.trim();
        if (r.isFinal) {
          if (txt) this.onFinal(txt);
        } else {
          interim += txt;
        }
      }
      if (interim) this.onInterim(interim);
    };

    this.rec = rec;
  }

  _clearRestart() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }

  _doStart() {
    try {
      this.rec.start();
    } catch (e) {
      // Chrome 已在后台运行但 onstart 未同步时，start() 会抛 InvalidStateError
      const msg = (e && e.message) || '';
      if (e?.name === 'InvalidStateError' || /already started|recognition has already started/i.test(msg)) {
        this.listening = true;
        this.onState(true);
      }
    }
  }

  start() {
    if (!this.supported) return;
    this.manualStop = false;
    this._clearRestart();
    if (this.listening) return;
    this._doStart();
  }

  stop() {
    if (!this.supported) return;
    this.manualStop = true;
    this._clearRestart();
    try {
      if (typeof this.rec.abort === 'function') this.rec.abort();
      else this.rec.stop();
    } catch (_) {}
    this.listening = false;
    this.onState(false);
  }

  toggle() {
    this.listening ? this.stop() : this.start();
  }
}

/**
 * 混合 ASR：优先浏览器原生（快、边说边出字），失败时自动切云端录音识别。
 */
export class HybridASR {
  constructor({ onFinal, onInterim, onState, onError, onLevel, onStatus } = {}) {
    this.onFinal = onFinal || (() => {});
    this.onInterim = onInterim || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onStatus = onStatus || (() => {});
    this.listening = false;
    this.mode = 'browser';
    this.asrReady = false;
    this.whisperReady = false;
    this._browserFails = 0;
    this._userWantsListen = false;
    this._playbackPaused = false;
    this._dropResults = false;

    this._browser = new ASR({
      onInterim: (t) => {
        if (this._dropResults) return;
        this.onInterim(t);
      },
      onFinal: (t) => {
        if (this._dropResults || this.mode !== 'browser') return;
        this.onFinal(t);
      },
      onState: (on) => {
        if (this.mode !== 'browser') return;
        if (this._playbackPaused && !on) return;
        this.listening = on || this._userWantsListen;
        this.onState(this.listening);
      },
      onError: (code) => this._onBrowserError(code),
    });

    this._server = null;
    this.supported = this._browser.supported;
  }

  attachServer(ServerASRClass) {
    this._server = new ServerASRClass({
      onFinal: (t) => {
        if (this._dropResults || this.mode !== 'server') return;
        this.onFinal(t);
      },
      onState: (on) => {
        if (this.mode !== 'server') return;
        if (this._playbackPaused && !on) return;
        this.listening = on || this._userWantsListen;
        this.onState(this.listening);
      },
      onLevel: (lv) => this.onLevel(lv),
      onStatus: (msg) => this.onStatus(msg),
      onError: (code, msg) => this.onError(code, msg),
    });
    this.supported = this._browser.supported || this._server.supported;
    if (!this._browser.supported) this._useServer('浏览器不支持原生识别，已切换云端');
  }

  get engineName() {
    return this.mode === 'browser' ? '浏览器' : '云端';
  }

  _useServer(reason) {
    if (!this._server) return;
    if (this._browser.listening) this._browser.stop();
    this.mode = 'server';
    this.asrReady = this._server.asrReady;
    this.whisperReady = this._server.whisperReady;
    this.listening = false;
    this.onState(false);
    if (reason) this.onStatus(reason);
  }

  _onBrowserError(code) {
    if (code === 'no-speech' || code === 'aborted') return;
    this._browserFails++;
    if (code === 'network' || code === 'service-not-available' || this._browserFails >= 2) {
      this._useServer('浏览器识别不可用，已切换云端识别');
      this.onError('browser-fallback', code);
      return;
    }
    this.onError(code, code);
  }

  setServerReady({ asr_ready, whisper_ready } = {}) {
    if (!this._server) return;
    this._server.asrReady = !!asr_ready;
    this._server.whisperReady = !!whisper_ready;
    if (this.mode === 'server') {
      this.asrReady = this._server.asrReady;
      this.whisperReady = this._server.whisperReady;
    }
  }

  async start() {
    if (this._playbackPaused || (this.listening && !this._dropResults)) return;
    this._userWantsListen = true;
    this._dropResults = false;
    if (this.mode === 'browser' && this._browser.supported) {
      this.asrReady = true;
      this.onStatus('浏览器语音识别 · 说完自动识别');
      this._browser.start();
      return;
    }
    if (this._server) {
      this._useServer();
      await this._server.start();
    }
  }

  stop() {
    this._userWantsListen = false;
    this._playbackPaused = false;
    this._dropResults = false;
    if (this._browser.listening || this.listening) this._browser.stop();
    if (this._server?.listening) this._server.stop();
    this.listening = false;
    this.onState(false);
    this.onStatus('已停止');
  }

  /** AI 处理 / 语音播报期间暂停收音，防止扬声器声音被当成指令。 */
  pauseForPlayback() {
    if (!this._userWantsListen) return;
    this._playbackPaused = true;
    this._dropResults = true;
    if (this._browser.listening) this._browser.stop();
    if (this._server?.listening) this._server.stop();
    this.listening = true;
    this.onStatus('播报中，暂不收音…');
  }

  resumeAfterPlayback() {
    if (!this._userWantsListen) return;
    this._playbackPaused = false;
    this._dropResults = false;
    if (this.mode === 'browser' && this._browser.supported) {
      if (!this._browser.listening) this._browser.start();
      return;
    }
    if (this._server && !this._server.listening) this._server.start();
  }

  get wantsListen() {
    return this._userWantsListen;
  }

  get micRunning() {
    return !!(this._browser.listening || this._server?.listening);
  }

  toggle() {
    if (this._userWantsListen) this.stop();
    else this.start();
  }
}

export class TTS {
  constructor() {
    this.synth = window.speechSynthesis;
    this.enabled = true;
    this.speaking = false;
    this.voice = null;
    this._lastSpoken = '';
    this._lastSpokenAt = 0;
    if (this.synth) {
      const pick = () => {
        const voices = this.synth.getVoices();
        this.voice = voices.find(v => /zh|Chinese/i.test(v.lang)) || voices[0] || null;
      };
      pick();
      this.synth.onvoiceschanged = pick;
    }
  }

  _norm(s) {
    return String(s).replace(/[，。！？、\s]/g, '').toLowerCase();
  }

  isEcho(text) {
    if (!this._lastSpoken || Date.now() - this._lastSpokenAt > 12000) return false;
    const a = this._norm(text);
    const b = this._norm(this._lastSpoken);
    if (!a || !b || a.length < 2) return false;
    if (b.includes(a) || a.includes(b)) return true;
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    let hit = 0;
    for (const ch of shorter) if (longer.includes(ch)) hit++;
    return hit / shorter.length >= 0.72;
  }

  speak(text) {
    return new Promise((resolve) => {
      if (!this.enabled || !this.synth || !text) {
        resolve();
        return;
      }
      this.synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      if (this.voice) u.voice = this.voice;
      u.rate = 1.1;
      this.speaking = true;
      this._lastSpoken = text;
      this._lastSpokenAt = Date.now();
      const done = () => {
        this.speaking = false;
        setTimeout(resolve, 700);
      };
      u.onend = done;
      u.onerror = done;
      this.synth.speak(u);
    });
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v && this.synth) this.synth.cancel();
  }
}
