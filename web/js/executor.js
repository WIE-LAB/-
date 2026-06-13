// 指令执行器
const COLOR_CN = {
  red: '红色', blue: '蓝色', green: '绿色', yellow: '黄色',
  orange: '橙色', purple: '紫色', pink: '粉色', black: '黑色',
};
const SHAPE_CN = {
  circle: '圆形', square: '正方形', rect: '长方形', triangle: '三角形',
  line: '直线', star: '星星', text: '文字', image: '图片',
};

export class Executor {
  constructor(engine, { onFeedback, confirmDestructive = true, silent = false } = {}) {
    this.engine = engine;
    this.onFeedback = onFeedback || (() => {});
    this.confirmDestructive = confirmDestructive;
    this.queue = [];
    this.running = false;
    this.pendingConfirm = null;
    this._silent = silent;
    this._batchSummary = '';
  }

  enqueue(commands, { summary = '', silent = false, confirm = true } = {}) {
    this._batchSummary = summary;
    this._silent = silent;
    this._noConfirm = !confirm;
    const merged = [];
    let buf = [];
    for (const cmd of commands) {
      if (cmd.action === 'place') buf.push(cmd);
      else {
        if (buf.length) { merged.push({ action: '_place_batch', items: buf }); buf = []; }
        merged.push(cmd);
      }
    }
    if (buf.length) merged.push({ action: '_place_batch', items: buf });
    this.queue.push(...merged);
    return this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const cmd = this.queue.shift();
      try { this.execute(cmd); } catch (e) {
        this.onFeedback({ ok: false, text: '执行出错：' + e.message, level: 'warn' });
      }
      await new Promise(r => setTimeout(r, 40));
    }
    if (this._batchSummary && !this._silent) {
      this.onFeedback({ ok: true, text: this._batchSummary, level: 'bot' });
    }
    this._batchSummary = '';
    this._silent = false;
    this.running = false;
  }

  handleConfirmation(text) {
    if (!this.pendingConfirm) return false;
    if (/确认|确定|是的|对|好的|可以|继续|嗯/.test(text)) {
      const fn = this.pendingConfirm.run;
      this.pendingConfirm = null;
      fn();
      return true;
    }
    if (/取消|不要|算了|别|不用|否/.test(text)) {
      this.pendingConfirm = null;
      this.onFeedback({ ok: true, text: '已取消。', level: 'bot' });
      return true;
    }
    return false;
  }

  _fb(fb) {
    if (this._silent && fb.level === 'bot' && fb.ok) return;
    this.onFeedback(fb);
  }

  execute(cmd) {
    const e = this.engine;
    const a = cmd.action;
    const ts = cmd.target_shape || cmd.targetShape;
    const tc = cmd.target_color || cmd.targetColor;

    if (a === '_place_batch') {
      e.placeBatch(cmd.items);
      return;
    }
    if (a === 'place') {
      e.placeShape(cmd);
      if (!this._silent) this._fb({ ok: true, text: '已绘制。', level: 'bot' });
      return;
    }
    if (a === 'reply') {
      this._fb({ ok: true, text: cmd.text || '', level: 'bot' });
      return;
    }

    switch (a) {
      case 'draw': {
        const created = e.addShapes({
          shape: cmd.shape, color: cmd.color, size: cmd.size,
          position: cmd.position, count: cmd.count || 1, layout: cmd.layout,
        });
        if (!this._silent) {
          const n = created.length;
          this._fb({ ok: true, text: `画了${n > 1 ? n + '个' : '一个'}${COLOR_CN[cmd.color] || ''}${SHAPE_CN[cmd.shape] || ''}。`, level: 'bot' });
        }
        break;
      }
      case 'preset': {
        const ok = e.drawPreset(cmd.preset);
        this._fb({ ok, text: ok ? '画好了。' : '预设不支持。', level: ok ? 'bot' : 'warn' });
        break;
      }
      case 'delete': {
        const n = e.delete({ shape: cmd.shape || ts, color: cmd.color || tc, all: cmd.all });
        this._fb({ ok: n > 0, text: n ? `删除了 ${n} 个图形。` : '没有找到图形。', level: n ? 'bot' : 'warn' });
        break;
      }
      case 'clear': {
        const ok = e.clear();
        this._fb({ ok, text: ok ? '画布已清空。' : '画布本来就是空的。', level: 'bot' });
        break;
      }
      case 'undo':
        this._fb({ ok: e.undo(), text: e.history.length > 1 ? '已撤销。' : '没有可撤销的了。', level: 'bot' });
        break;
      case 'redo':
        this._fb({ ok: e.redo(), text: '已重做。', level: 'bot' });
        break;
      case 'move':
        this._fb({ ok: e.move({ ...cmd, targetShape: ts, targetColor: tc }) > 0, text: '已移动。', level: 'bot' });
        break;
      case 'move_group':
        this._fb({ ok: e.moveGroup(cmd) > 0, text: '已移动整组。', level: 'bot' });
        break;
      case 'recolor':
        this._fb({ ok: e.recolor({ color: cmd.color, targetShape: ts, targetColor: tc }) > 0, text: '已改色。', level: 'bot' });
        break;
      case 'resize':
        this._fb({ ok: e.resize({ size: cmd.size, factor: cmd.factor, targetShape: ts, targetColor: tc }) > 0, text: '已调整大小。', level: 'bot' });
        break;
      case 'rotate':
        this._fb({ ok: e.rotate({ degrees: cmd.degrees, targetShape: ts, targetColor: tc }) > 0, text: '已旋转。', level: 'bot' });
        break;
      case 'text':
        e.addText({ text: cmd.text, color: cmd.color, position: cmd.position, size: cmd.size });
        if (!this._silent) this._fb({ ok: true, text: `已写上「${cmd.text}」。`, level: 'bot' });
        break;
      case 'export':
      case 'export_canvas':
      case 'save':
        this._fb({
          ok: e.exportCanvas(cmd.filename),
          text: e.shapes.length
            ? '画布已导出，请到浏览器下载文件夹查看。'
            : '画布是空的，没有可导出的内容。',
          level: e.shapes.length ? 'bot' : 'warn',
        });
        break;
      default:
        this._fb({ ok: false, text: '指令未识别。', level: 'warn' });
    }
  }
}
