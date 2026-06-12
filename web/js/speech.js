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
      this.onState(false);
      if (!this.manualStop) {
        setTimeout(() => {
          try { rec.start(); } catch (_) {}
        }, 120);
      }
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

  start() {
    if (!this.supported || this.listening) return;
    this.manualStop = false;
    try { this.rec.start(); } catch (_) {}
  }

  stop() {
    if (!this.supported) return;
    this.manualStop = true;
    try { this.rec.stop(); } catch (_) {}
  }

  toggle() {
    this.listening ? this.stop() : this.start();
  }
}

export class TTS {
  constructor() {
    this.synth = window.speechSynthesis;
    this.enabled = true;
    this.voice = null;
    if (this.synth) {
      const pick = () => {
        const voices = this.synth.getVoices();
        this.voice = voices.find(v => /zh|Chinese/i.test(v.lang)) || voices[0] || null;
      };
      pick();
      this.synth.onvoiceschanged = pick;
    }
  }

  speak(text) {
    if (!this.enabled || !this.synth || !text) return;
    this.synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.1;
    this.synth.speak(u);
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v && this.synth) this.synth.cancel();
  }
}
