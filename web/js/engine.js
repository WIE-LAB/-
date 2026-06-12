// 画布引擎：矢量图形 + AI 图片
export const COLORS = {
  red: '#e74c3c', blue: '#3498db', green: '#2ecc71', yellow: '#f1c40f',
  orange: '#e67e22', purple: '#9b59b6', pink: '#fd79a8', black: '#2c3e50',
  white: '#ffffff', gray: '#95a5a6', brown: '#8d6e63', cyan: '#1abc9c',
};
const HEX_TO_NAME = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [v, k]));

const POSITIONS = {
  center: [0.5, 0.5], top: [0.5, 0.2], bottom: [0.5, 0.8],
  left: [0.25, 0.5], right: [0.75, 0.5],
  'top-left': [0.22, 0.22], 'top-right': [0.78, 0.22],
  'bottom-left': [0.22, 0.78], 'bottom-right': [0.78, 0.78],
};

let _id = 0;
const nextId = () => ++_id;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = canvas.width;
    this.H = canvas.height;
    this.shapes = [];
    this.selectedId = null;
    this.lastId = null;
    this.history = [];
    this.future = [];
    this._images = new Map();
    this.pushHistory();
    this.render();
  }

  snapshot() {
    return JSON.stringify({
      shapes: this.shapes.map(s => ({ ...s })),
      selectedId: this.selectedId,
      lastId: this.lastId,
      _id,
    });
  }

  restore(s) {
    const d = JSON.parse(s);
    this.shapes = d.shapes;
    this.selectedId = d.selectedId;
    this.lastId = d.lastId;
    _id = d._id;
    this._images.clear();
    for (const sh of this.shapes) {
      if (sh.type === 'image' && sh.url) this._loadImage(sh);
    }
  }

  pushHistory() {
    this.history.push(this.snapshot());
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }

  undo() {
    if (this.history.length <= 1) return false;
    this.future.push(this.history.pop());
    this.restore(this.history[this.history.length - 1]);
    this.render();
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    const s = this.future.pop();
    this.history.push(s);
    this.restore(s);
    this.render();
    return true;
  }

  resolvePosition(pos) {
    const key = pos && POSITIONS[pos] ? pos : 'center';
    const [fx, fy] = POSITIONS[key];
    return { x: Math.round(this.W * fx), y: Math.round(this.H * fy) };
  }

  defaultSize(w) {
    const map = { tiny: 50, small: 80, medium: 120, large: 190, huge: 260 };
    return map[w] || 120;
  }

  resolveColor(c, fallback = COLORS.blue) {
    if (!c) return fallback;
    return COLORS[c] || (typeof c === 'string' && c[0] === '#' ? c : fallback);
  }

  getContext() {
    return {
      width: this.W,
      height: this.H,
      shape_count: this.shapes.length,
      selected_id: this.selectedId,
      shapes: this.shapes.map(s => ({
        id: s.id,
        type: s.type,
        x: s.x,
        y: s.y,
        size: s.size,
        color: s.color || '',
        color_name: s.type === 'image' ? '图片' : (HEX_TO_NAME[s.color] || s.color),
        text: s.text || '',
        w: s.w,
        h: s.h,
        prompt: s.prompt || '',
      })),
    };
  }

  placeShape(spec) {
    const x = spec.x ?? this.W / 2;
    const y = spec.y ?? this.H / 2;
    const size = spec.size ?? 80;
    const shape = {
      id: nextId(),
      type: spec.shape || 'circle',
      x, y, size,
      color: this.resolveColor(spec.color),
      rotation: spec.rotation || 0,
      text: spec.text || '',
      w: spec.w,
      h: spec.h,
    };
    this.shapes.push(shape);
    this.lastId = shape.id;
    this.selectedId = shape.id;
    this.pushHistory();
    this.render();
    return shape;
  }

  placeBatch(items) {
    const created = items.map(s => {
      const shape = {
        id: nextId(),
        type: s.shape || 'circle',
        x: s.x ?? this.W / 2,
        y: s.y ?? this.H / 2,
        size: s.size ?? 80,
        color: this.resolveColor(s.color),
        rotation: s.rotation || 0,
        text: '',
      };
      this.shapes.push(shape);
      return shape;
    });
    if (created.length) {
      this.lastId = created[created.length - 1].id;
      this.selectedId = this.lastId;
      this.pushHistory();
      this.render();
    }
    return created;
  }

  async placeImage({ url, x, y, w, h, prompt, animate = false }) {
    w = w ?? Math.min(this.W, this.H) - 40;
    h = h ?? w;
    x = x ?? this.W / 2;
    y = y ?? this.H / 2;
    const shape = {
      id: nextId(),
      type: 'image',
      x, y, w, h,
      size: Math.max(w, h),
      color: '',
      rotation: 0,
      text: '',
      url,
      prompt: prompt || '',
      _reveal: animate ? 0 : 1,
    };
    await this._loadImage(shape);
    this.shapes.push(shape);
    this.lastId = shape.id;
    this.selectedId = shape.id;
    if (animate) {
      await this.revealImage(shape, 2400);
    }
    this.pushHistory();
    this.render();
    return shape;
  }

  // 像笔刷一样左右来回把图片「画」出来
  revealImage(shape, durationMs = 2400) {
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / Math.max(60, durationMs));
        // ease-in-out，更像运笔
        shape._reveal = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        this.render();
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          shape._reveal = 1;
          this.render();
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  lastImage() {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      if (this.shapes[i].type === 'image') return this.shapes[i];
    }
    return null;
  }

  removeShapeSilent(id) {
    this.shapes = this.shapes.filter(s => s.id !== id);
    this._images.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    if (this.lastId === id) this.lastId = null;
  }

  _loadImage(shape) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this._images.set(shape.id, img);
        resolve(img);
      };
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = shape.url;
    });
  }

  addShapes(spec) {
    const count = Math.max(1, spec.count || 1);
    const size = typeof spec.size === 'number' ? spec.size : this.defaultSize(spec.size);
    const color = this.resolveColor(spec.color);
    const base = this.resolvePosition(spec.position);
    const layout = spec.layout || (count > 1 ? 'row' : 'single');
    const gap = size + 40;
    const created = [];
    for (let i = 0; i < count; i++) {
      let { x, y } = base;
      if (count > 1) {
        if (layout === 'row') x = base.x + (i - (count - 1) / 2) * gap;
        else if (layout === 'column') y = base.y + (i - (count - 1) / 2) * gap;
      }
      const shape = {
        id: nextId(), type: spec.shape || 'circle',
        x, y, size, color, rotation: 0, text: '',
      };
      this.shapes.push(shape);
      created.push(shape);
    }
    if (created.length) {
      this.lastId = created[created.length - 1].id;
      this.selectedId = this.lastId;
      this.pushHistory();
      this.render();
    }
    return created;
  }

  addStroke(spec) {
    const pts = (spec.points || [])
      .filter(p => Array.isArray(p) && p.length >= 2)
      .map(p => [Math.round(p[0]), Math.round(p[1])]);
    let cx = 0, cy = 0;
    if (pts.length) {
      cx = Math.round(pts.reduce((a, p) => a + p[0], 0) / pts.length);
      cy = Math.round(pts.reduce((a, p) => a + p[1], 0) / pts.length);
    }
    const shape = {
      id: nextId(),
      type: 'stroke',
      points: pts,
      color: this.resolveColor(spec.color, '#2c3e50'),
      width: spec.width || 5,
      closed: !!spec.closed,
      fill: spec.fill ? this.resolveColor(spec.fill) : null,
      _progress: spec.animate === false ? 1 : 0,
      x: cx, y: cy, size: 0, rotation: 0, text: '',
    };
    this.shapes.push(shape);
    this.lastId = shape.id;
    this.selectedId = shape.id;
    return shape;
  }

  strokeLen(pts, closed) {
    if (!pts || pts.length < 2) return 0;
    const seq = closed ? [...pts, pts[0]] : pts;
    let total = 0;
    for (let i = 1; i < seq.length; i++) {
      total += Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1]);
    }
    return total;
  }

  animateStroke(shape, durationMs) {
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / Math.max(60, durationMs));
        shape._progress = t;
        this.render();
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  addText(spec) {
    const base = this.resolvePosition(spec.position);
    const shape = {
      id: nextId(), type: 'text',
      x: base.x, y: base.y,
      size: spec.size || 48,
      color: this.resolveColor(spec.color, COLORS.black),
      rotation: 0, text: spec.text || '文字',
    };
    this.shapes.push(shape);
    this.lastId = shape.id;
    this.selectedId = shape.id;
    this.pushHistory();
    this.render();
    return shape;
  }

  resolveTargets(spec = {}) {
    const shape = spec.shape || spec.targetShape;
    const color = spec.color || spec.targetColor;
    if (spec.all) return [...this.shapes];
    let pool = this.shapes;
    if (shape) pool = pool.filter(s => s.type === shape);
    if (color) {
      const hx = COLORS[color] || color;
      pool = pool.filter(s => s.color === hx);
    }
    if (shape || color) return pool;
    const ref = this.shapes.find(s => s.id === this.selectedId) ||
                this.shapes.find(s => s.id === this.lastId);
    return ref ? [ref] : (this.shapes.length ? [this.shapes[this.shapes.length - 1]] : []);
  }

  delete(spec) {
    const targets = this.resolveTargets(spec);
    if (!targets.length) return 0;
    const ids = new Set(targets.map(t => t.id));
    this.shapes = this.shapes.filter(s => !ids.has(s.id));
    ids.forEach(id => this._images.delete(id));
    if (ids.has(this.selectedId)) this.selectedId = null;
    if (ids.has(this.lastId)) this.lastId = null;
    this.pushHistory();
    this.render();
    return targets.length;
  }

  clear() {
    if (!this.shapes.length) return false;
    this.shapes = [];
    this.selectedId = null;
    this.lastId = null;
    this._images.clear();
    this.pushHistory();
    this.render();
    return true;
  }

  select(spec) {
    const targets = this.resolveTargets(spec);
    if (!targets.length) return null;
    const t = targets[targets.length - 1];
    this.selectedId = t.id;
    this.lastId = t.id;
    this.render();
    return t;
  }

  recolor(spec) {
    const targets = this.resolveTargets({ shape: spec.targetShape, color: spec.targetColor });
    const hex = this.resolveColor(spec.color);
    targets.forEach(t => { if (t.type !== 'image') t.color = hex; });
    if (targets.length) { this.lastId = targets[targets.length - 1].id; this.pushHistory(); this.render(); }
    return targets.length;
  }

  resize(spec) {
    const targets = this.resolveTargets({ shape: spec.targetShape, color: spec.targetColor });
    targets.forEach(t => {
      if (t.type === 'image') {
        const scale = typeof spec.size === 'number'
          ? spec.size / Math.max(t.w, 1)
          : (spec.factor || 1.3);
        t.w = Math.max(40, Math.min(this.W, t.w * scale));
        t.h = Math.max(40, Math.min(this.H, t.h * scale));
        t.size = Math.max(t.w, t.h);
      } else if (typeof spec.size === 'number') {
        t.size = spec.size;
      } else {
        t.size = Math.max(20, Math.min(500, t.size * (spec.factor || 1.3)));
      }
    });
    if (targets.length) { this.lastId = targets[targets.length - 1].id; this.pushHistory(); this.render(); }
    return targets.length;
  }

  move(spec) {
    let targets = this.resolveTargets({
      shape: spec.targetShape || spec.shape,
      color: spec.targetColor || spec.color,
    });
    if (!targets.length && spec.color) {
      const hx = COLORS[spec.color] || spec.color;
      targets = this.shapes.filter(s => s.color === hx);
    }
    targets.forEach(t => this._applyMove(t, spec));
    if (targets.length) { this.lastId = targets[targets.length - 1].id; this.pushHistory(); this.render(); }
    return targets.length;
  }

  _applyMove(t, spec) {
    let nx = t.x, ny = t.y;
    if (spec.x != null || spec.y != null) {
      if (spec.x != null) nx = spec.x;
      if (spec.y != null) ny = spec.y;
    } else if (spec.position) {
      const p = this.resolvePosition(spec.position);
      nx = p.x; ny = p.y;
    } else {
      nx = t.x + (spec.dx || 0);
      ny = t.y + (spec.dy || 0);
    }
    nx = Math.max(0, Math.min(this.W, nx));
    ny = Math.max(0, Math.min(this.H, ny));
    const dx = nx - t.x, dy = ny - t.y;
    t.x = nx; t.y = ny;
    if (t.type === 'stroke' && t.points) {
      t.points = t.points.map(p => [p[0] + dx, p[1] + dy]);
    }
  }

  moveGroup(spec) {
    const colorKey = spec.color || spec.targetColor;
    if (!colorKey) return this.move(spec);
    const hx = COLORS[colorKey] || colorKey;
    const targets = this.shapes.filter(s => s.color === hx);
    if (!targets.length) return 0;
    let dx, dy;
    if (spec.position) {
      const p = this.resolvePosition(spec.position);
      const cx = targets.reduce((a, t) => a + t.x, 0) / targets.length;
      const cy = targets.reduce((a, t) => a + t.y, 0) / targets.length;
      dx = p.x - cx;
      dy = p.y - cy;
    } else {
      dx = spec.dx || 0;
      dy = spec.dy || 0;
    }
    targets.forEach(t => {
      t.x = Math.max(20, Math.min(this.W - 20, t.x + dx));
      t.y = Math.max(20, Math.min(this.H - 20, t.y + dy));
      if (t.type === 'stroke' && t.points) {
        t.points = t.points.map(p => [p[0] + dx, p[1] + dy]);
      }
    });
    this.lastId = targets[targets.length - 1].id;
    this.pushHistory();
    this.render();
    return targets.length;
  }

  rotate(spec) {
    const targets = this.resolveTargets({ shape: spec.targetShape, color: spec.targetColor });
    const deg = spec.degrees || 45;
    targets.forEach(t => { t.rotation = ((t.rotation || 0) + deg) % 360; });
    if (targets.length) { this.lastId = targets[targets.length - 1].id; this.pushHistory(); this.render(); }
    return targets.length;
  }

  drawPreset(name) {
    const presets = {
      house: [
        { shape: 'square', color: 'brown', size: 200, dx: 0, dy: 60 },
        { shape: 'triangle', color: 'red', size: 260, dx: 0, dy: -120 },
      ],
      sun: [{ shape: 'circle', color: 'yellow', size: 240, dx: 0, dy: 0 }],
      tree: [
        { shape: 'rect', color: 'brown', size: 60, dx: 0, dy: 150 },
        { shape: 'circle', color: 'green', size: 240, dx: 0, dy: -40 },
      ],
    };
    const parts = presets[name];
    if (!parts) return false;
    const c = this.resolvePosition('center');
    let last = null;
    for (const p of parts) {
      const shape = {
        id: nextId(), type: p.shape,
        x: c.x + (p.dx || 0), y: c.y + (p.dy || 0),
        size: p.size, color: this.resolveColor(p.color),
        rotation: 0, text: '',
      };
      this.shapes.push(shape);
      last = shape;
    }
    if (last) { this.lastId = last.id; this.selectedId = last.id; }
    this.pushHistory();
    this.render();
    return true;
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.W, this.H);
    for (const s of this.shapes) {
      if (s.type === 'stroke') {
        this.drawStroke(ctx, s);
        continue;
      }
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate((s.rotation || 0) * Math.PI / 180);
      if (s.type === 'image') {
        const img = this._images.get(s.id);
        if (img) this._drawImageReveal(ctx, img, s);
      } else {
        ctx.fillStyle = s.color;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = Math.max(3, s.size / 30);
        this.drawShape(ctx, s);
      }
      ctx.restore();
      if (s.id === this.selectedId) this.drawSelection(ctx, s);
    }
  }

  _drawImageReveal(ctx, img, s) {
    const reveal = s._reveal ?? 1;
    const left = -s.w / 2;
    const top = -s.h / 2;
    if (reveal >= 1) {
      ctx.drawImage(img, left, top, s.w, s.h);
      return;
    }
    // 横向分带，左右来回扫，模拟笔刷一笔笔画
    const bands = 16;
    const bandH = s.h / bands;
    const filledBands = reveal * bands;
    ctx.save();
    ctx.beginPath();
    for (let b = 0; b < bands; b++) {
      const f = Math.max(0, Math.min(1, filledBands - b));
      if (f <= 0) break;
      const bw = s.w * f;
      const xLeft = (b % 2 === 0) ? left : left + s.w - bw;
      ctx.rect(xLeft, top + b * bandH, bw, bandH + 1);
    }
    ctx.clip();
    ctx.drawImage(img, left, top, s.w, s.h);
    ctx.restore();
  }

  drawStroke(ctx, s) {
    const pts = s.points;
    if (!pts || !pts.length) return;
    const prog = s._progress ?? 1;
    if (pts.length === 1) {
      if (prog > 0) {
        ctx.save();
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], s.width / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      return;
    }
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // 完成且需填充：先填充再描边
    if (prog >= 1 && s.fill) {
      ctx.fillStyle = s.fill;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fill();
    }
    const total = this.strokeLen(pts, s.closed);
    const target = total * prog;
    const seq = s.closed ? [...pts, pts[0]] : pts;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(seq[0][0], seq[0][1]);
    let acc = 0;
    for (let i = 1; i < seq.length; i++) {
      const [x0, y0] = seq[i - 1];
      const [x1, y1] = seq[i];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      if (seg === 0) continue;
      if (acc + seg <= target) {
        ctx.lineTo(x1, y1);
        acc += seg;
      } else {
        const t = (target - acc) / seg;
        ctx.lineTo(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        break;
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  drawShape(ctx, s) {
    const r = s.size / 2;
    switch (s.type) {
      case 'circle':
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); break;
      case 'square':
      case 'rect': {
        const w = s.type === 'rect' ? s.size * 1.5 : s.size;
        ctx.fillRect(-w / 2, -r, w, s.size); break;
      }
      case 'triangle':
        ctx.beginPath();
        ctx.moveTo(0, -r); ctx.lineTo(r, r); ctx.lineTo(-r, r);
        ctx.closePath(); ctx.fill(); break;
      case 'line':
        ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.stroke(); break;
      case 'star': this.drawStar(ctx, 0, 0, 5, r, r * 0.42); ctx.fill(); break;
      case 'text':
        ctx.font = `bold ${s.size}px "Microsoft YaHei", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(s.text || '文字', 0, 0); break;
      default:
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  drawStar(ctx, cx, cy, spikes, outer, inner) {
    let rot = -Math.PI / 2, step = Math.PI / spikes;
    ctx.beginPath();
    for (let i = 0; i < spikes; i++) {
      ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer); rot += step;
      ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner); rot += step;
    }
    ctx.closePath();
  }

  drawSelection(ctx, s) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = '#5b8cff';
    ctx.lineWidth = 2;
    if (s.type === 'image') {
      ctx.strokeRect(-s.w / 2 - 6, -s.h / 2 - 6, s.w + 12, s.h + 12);
    } else {
      const pad = s.size * 0.7 + 14;
      ctx.strokeRect(-pad, -pad, pad * 2, pad * 2);
    }
    ctx.restore();
  }
}
