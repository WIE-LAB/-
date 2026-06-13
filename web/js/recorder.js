/**
 * 浏览器麦克风录音 + VAD → 服务端 Whisper。
 * 抗环境噪音：需持续说话才触发，模型未就绪不上传。
 */
export class ServerASR {
  constructor({ onFinal, onState, onError, onLevel, onStatus }) {
    this.onFinal = onFinal || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onStatus = onStatus || (() => {});
    this.supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    this.whisperReady = false;
    this.asrReady = false;
    this.listening = false;
    this._stream = null;
    this._ctx = null;
    this._analyser = null;
    this._recorder = null;
    this._chunks = [];
    this._raf = null;
    this._recording = false;
    this._silenceMs = 0;
    this._speechMs = 0;
    this._pendingMs = 0;
    this._threshold = 0.03;
    this._calibrated = false;
    this._noiseSamples = [];
    this._uploading = false;
    this._cooldownUntil = 0;
    this._lastSpeechMs = 0;
  }

  async start() {
    if (!this.supported || this.listening) return;
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (e) {
      this.onError('not-allowed', '麦克风权限被拒绝，请在浏览器地址栏允许麦克风');
      return;
    }

    this._ctx = new AudioContext();
    const src = this._ctx.createMediaStreamSource(this._stream);
    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 1024;
    src.connect(this._analyser);

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    this._recorder = mime
      ? new MediaRecorder(this._stream, { mimeType: mime })
      : new MediaRecorder(this._stream);

    this._recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._chunks.push(e.data);
    };
    this._recorder.onstop = () => this._onRecorded();

    this._calibrated = false;
    this._noiseSamples = [];
    this._recording = false;
    this._silenceMs = 0;
    this._speechMs = 0;
    this._pendingMs = 0;
    this.listening = true;
    this.onState(true);
    if (this.asrReady) {
      this.onStatus('请大声说话，说完稍停 1 秒');
    } else {
      this.onStatus('语音识别准备中，请稍候…');
    }
    this._loop();
  }

  stop() {
    this.listening = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._recorder && this._recorder.state !== 'inactive') {
      try { this._recorder.stop(); } catch (_) {}
    }
    this._stopStream();
    this.onState(false);
    this.onStatus('已停止');
  }

  toggle() {
    this.listening ? this.stop() : this.start();
  }

  _stopStream() {
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
    if (this._ctx) {
      this._ctx.close().catch(() => {});
      this._ctx = null;
    }
  }

  _rms() {
    const buf = new Float32Array(this._analyser.fftSize);
    this._analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  _loop() {
    if (!this.listening) return;
    const rms = this._rms();
    // 音量条仅作参考，不用于触发
    this.onLevel(Math.min(1, rms * 20));

    if (!this.asrReady && !this.whisperReady) {
      this.onStatus('语音识别加载中，请稍候…');
      this._raf = requestAnimationFrame(() => this._loop());
      return;
    }

    if (Date.now() < this._cooldownUntil) {
      this._raf = requestAnimationFrame(() => this._loop());
      return;
    }

    if (!this._calibrated) {
      this._noiseSamples.push(rms);
      if (this._noiseSamples.length >= 10) {
        const sorted = [...this._noiseSamples].sort((a, b) => a - b);
        const floor = sorted[Math.floor(sorted.length * 0.7)];
        this._threshold = Math.max(0.028, floor * 5.0);
        this._calibrated = true;
        this.onStatus(`已就绪，请大声说话（阈值已过滤环境音）`);
      } else {
        this.onStatus('正在校准环境噪音…请保持安静');
      }
      this._raf = requestAnimationFrame(() => this._loop());
      return;
    }

    const isLoud = rms > this._threshold;

    if (isLoud) {
      this._pendingMs += 16;
      this._silenceMs = 0;
      // 需连续 350ms 超阈值才开始录音，过滤风吹草动
      if (!this._recording && this._pendingMs >= 200) {
        this._recording = true;
        this._chunks = [];
        this._speechMs = 0;
        if (this._recorder.state === 'inactive') {
          this._recorder.start(250);
        }
        this.onStatus('正在听…');
      }
      if (this._recording) {
        this._speechMs += 16;
        this._lastSpeechMs = this._speechMs;
      }
    } else {
      this._pendingMs = 0;
      if (this._recording) {
        this._silenceMs += 16;
        if (this._silenceMs >= 400) {
          this._finishRecording();
        }
      }
    }

    // 最长录 8 秒自动结束
    if (this._recording && this._speechMs >= 8000) {
      this._finishRecording();
    }

    this._raf = requestAnimationFrame(() => this._loop());
  }

  _finishRecording() {
    this._recording = false;
    this._pendingMs = 0;
    this._silenceMs = 0;
    if (this._recorder.state === 'recording') {
      this._recorder.stop();
    } else {
      this._chunks = [];
      if (this.listening) this.onStatus('声音太短，请大声完整说一句话');
    }
  }

  async _onRecorded() {
    const spokeMs = this._lastSpeechMs;
    this._lastSpeechMs = 0;
    this._cooldownUntil = Date.now() + 350;

    if (this._uploading) return;
    if (spokeMs < 450) {
      this._chunks = [];
      if (this.listening) this.onStatus('没听清（太短），请大声说一句完整的话');
      return;
    }
    if (!this._chunks.length) return;

    const blob = new Blob(this._chunks, { type: this._recorder.mimeType || 'audio/webm' });
    this._chunks = [];
    if (blob.size < 2000) {
      if (this.listening) this.onStatus('录音太短，请再试一次');
      return;
    }

    if (!this.asrReady && !this.whisperReady) {
      this.onStatus('语音识别未就绪');
      return;
    }

    this._uploading = true;
    this.onStatus('识别中…');

    try {
      const fd = new FormData();
      const isWebm = (blob.type || '').includes('webm');
      fd.append('file', blob, isWebm ? 'speech.webm' : 'speech.wav');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      const res = await fetch('/api/transcribe', { method: 'POST', body: fd, signal: ctrl.signal });
      clearTimeout(timer);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '识别失败');
      const text = (data.text || '').trim();
      if (text) {
        this.onFinal(text);
        if (this.listening) this.onStatus('识别成功，请继续说话');
      } else if (this.listening) {
        this.onStatus('没识别到文字，请大声再说一次');
      }
    } catch (e) {
      const msg = e.name === 'AbortError' ? '识别超时，请重试' : e.message;
      this.onError('transcribe', msg);
      if (this.listening) this.onStatus(msg);
    } finally {
      this._uploading = false;
    }
  }

  async _toWav(blob) {
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      const ab = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(ab);
      await ctx.close();
      return this._encodeWav(decoded, 16000);
    } catch {
      return blob;
    }
  }

  _encodeWav(audioBuffer, targetRate) {
    const numCh = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const srcRate = audioBuffer.sampleRate;
    const outLen = Math.round(len * targetRate / srcRate);
    const samples = new Float32Array(outLen);
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = numCh > 1 ? audioBuffer.getChannelData(1) : null;
    for (let i = 0; i < outLen; i++) {
      const srcIdx = (i * srcRate) / targetRate;
      const idx = Math.min(len - 1, Math.floor(srcIdx));
      const a = ch0[idx];
      const b = ch1 ? ch1[idx] : a;
      samples[i] = (a + b) / 2;
    }
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buf);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, pcm.length * 2, true);
    let off = 44;
    for (let i = 0; i < pcm.length; i++, off += 2) view.setInt16(off, pcm[i], true);
    return new Blob([buf], { type: 'audio/wav' });
  }
}
