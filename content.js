(() => {
  // 扩展重新加载后旧脚本会失效，此时允许重新注入
  if (window.__scrollShot?.isAlive()) return;

  const MAX_FRAMES = 200;
  const MAX_HEIGHT_CSS = 60000;
  const MIN_SIZE = 16;
  const SHOT_INTERVAL = 600; // 与 captureVisibleTab 的频率限制保持一致

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 等待浏览器完成重绘；页面不可见时 rAF 会暂停，用超时兜底
  const nextPaint = () =>
    new Promise((r) => {
      requestAnimationFrame(() => requestAnimationFrame(r));
      setTimeout(r, 150);
    });
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const viewportRect = () => ({ left: 0, top: 0, width: innerWidth, height: innerHeight });

  function intersect(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.left + a.width, b.left + b.width);
    const bottom = Math.min(a.top + a.height, b.top + b.height);
    return right - left >= 1 && bottom - top >= 1 ? { left, top, width: right - left, height: bottom - top } : null;
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) return reject(new Error(res?.error || '扩展后台无响应'));
        resolve(res);
      });
    });
  }

  /* ---------------- 滚动容器 ---------------- */

  const parentOf = (el) => el.parentElement || el.getRootNode()?.host || null;

  function isScrollableY(el) {
    if (!(el instanceof Element) || el.scrollHeight - el.clientHeight < 2) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
  }

  function windowScrollable() {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight - se.clientHeight < 2) return false;
    const html = getComputedStyle(document.documentElement).overflowY;
    const body = document.body ? getComputedStyle(document.body).overflowY : 'visible';
    const vp = html !== 'visible' ? html : body;
    return vp !== 'hidden' && vp !== 'clip';
  }

  function windowScroller() {
    const se = document.scrollingElement || document.documentElement;
    return {
      el: se,
      styleEl: document.documentElement,
      get top() { return se.scrollTop; },
      set top(v) { se.scrollTop = v; },
      get max() { return se.scrollHeight - this.viewRect().height; },
      viewRect() {
        const de = document.documentElement;
        const std = document.compatMode === 'CSS1Compat';
        return { left: 0, top: 0, width: (std && de.clientWidth) || innerWidth, height: (std && de.clientHeight) || innerHeight };
      },
    };
  }

  function elementScroller(el) {
    return {
      el,
      styleEl: el,
      get top() { return el.scrollTop; },
      set top(v) { el.scrollTop = v; },
      get max() { return el.scrollHeight - el.clientHeight; },
      viewRect() {
        const r = el.getBoundingClientRect();
        const box = { left: r.left + el.clientLeft, top: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
        return intersect(box, viewportRect());
      },
    };
  }

  /** 全屏模式：优先页面自身滚动，否则选可见面积最大的内部滚动容器（常见于 SPA 布局）。 */
  function findMainScroller() {
    const se = document.scrollingElement || document.documentElement;
    const winRange = windowScrollable() ? se.scrollHeight - se.clientHeight : 0;
    if (winRange > 120) return windowScroller();

    const vp = viewportRect();
    let best = null;
    let bestArea = 0;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.clientHeight < 50 || !isScrollableY(n)) continue;
      const vis = intersect(n.getBoundingClientRect(), vp);
      const area = vis ? vis.width * vis.height : 0;
      if (area > bestArea) {
        best = n;
        bestArea = area;
      }
    }
    if (best && bestArea > vp.width * vp.height * 0.15) return elementScroller(best);
    if (winRange > 0) return windowScroller();
    return best ? elementScroller(best) : null;
  }

  /** 区域模式：从选区中心向上查找第一个可纵向滚动的祖先。 */
  function findScrollerAt(ui, x, y) {
    for (let el = ui.elementAt(x, y); el && el !== document.body && el !== document.documentElement; el = parentOf(el)) {
      if (isScrollableY(el)) return elementScroller(el);
    }
    return windowScrollable() ? windowScroller() : null;
  }

  /** 选区阶段把滚轮转发给鼠标下方的页面元素，方便先滚到想要的起点。 */
  function forwardWheel(ui, e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    for (let el = ui.elementAt(e.clientX, e.clientY); el && el !== document.body && el !== document.documentElement; el = parentOf(el)) {
      const canMove = dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
      if (isScrollableY(el) && canMove) {
        el.scrollBy(dx, dy);
        return;
      }
    }
    window.scrollBy(dx, dy);
  }

  /** 收集 fixed / sticky 元素，滚动拼接时它们会在每一屏重复出现。 */
  function scanPositioned(scroller) {
    const fixed = [];
    const sticky = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' && !n.contains(scroller.el)) fixed.push(n);
      else if (pos === 'sticky' && scroller.el.contains(n)) sticky.push(n);
    }
    return { fixed, sticky };
  }

  /** 临时覆盖内联样式，结束后原样恢复。 */
  class StyleOverrides {
    items = [];
    set(el, prop, value) {
      this.items.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
      el.style.setProperty(prop, value, 'important');
    }
    restore() {
      for (const [el, prop, value, priority] of this.items.reverse()) {
        if (value) el.style.setProperty(prop, value, priority);
        else el.style.removeProperty(prop);
      }
      this.items = [];
    }
  }

  /* ---------------- 界面 ---------------- */

  const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';
  const CSS = `
    * { box-sizing: border-box; }
    :host(.pass) * { pointer-events: none !important; }
    .mask { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; background: rgba(15, 23, 42, .32); }
    .mask.picked { background: transparent; }
    .hint, .panel, .toast, .bar, .label { font: 500 13px/1.4 ${FONT}; }
    .hint { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); padding: 8px 16px; border-radius: 999px;
      background: rgba(17, 24, 39, .9); color: #fff; white-space: nowrap; pointer-events: none;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .25); }
    .sel, .frame { position: fixed; pointer-events: none; outline: 2px solid #3b82f6; outline-offset: 1px; }
    .sel { display: none; box-shadow: 0 0 0 100vmax rgba(15, 23, 42, .45); }
    .frame { box-shadow: 0 0 0 100vmax rgba(15, 23, 42, .3); }
    .label { position: fixed; padding: 2px 7px; border-radius: 5px; background: #3b82f6; color: #fff;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; pointer-events: none; }
    .bar { position: fixed; display: none; gap: 6px; padding: 6px; border-radius: 10px; background: #fff; pointer-events: auto;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .2), 0 0 0 1px rgba(0, 0, 0, .06); }
    .bar.show { display: flex; }
    button { all: unset; padding: 6px 12px; border-radius: 7px; font: 500 13px/1.4 ${FONT}; color: #1f2937;
      background: #f3f4f6; cursor: pointer; white-space: nowrap; }
    button:hover { background: #e5e7eb; }
    button.primary { background: #2563eb; color: #fff; }
    button.primary:hover { background: #1d4ed8; }
    .blocker { position: fixed; inset: 0; pointer-events: auto; cursor: progress; background: transparent; }
    .panel { position: fixed; right: 20px; bottom: 20px; display: flex; align-items: center; gap: 8px;
      padding: 7px 7px 7px 14px; border-radius: 12px; background: rgba(17, 24, 39, .92); color: #fff; pointer-events: auto;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .3); }
    .panel .txt { min-width: 96px; font-variant-numeric: tabular-nums; }
    .panel button { background: rgba(255, 255, 255, .14); color: #fff; }
    .panel button:hover { background: rgba(255, 255, 255, .24); }
    .panel button.primary { background: #2563eb; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    .toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); max-width: 80vw; padding: 10px 16px;
      border-radius: 10px; background: #dc2626; color: #fff; pointer-events: auto; box-shadow: 0 10px 30px rgba(0, 0, 0, .25); }
  `;

  function createUI() {
    const host = document.createElement('scroll-shot-ui');
    host.setAttribute(
      'style',
      'all: initial !important; position: fixed !important; inset: 0 !important; display: block !important;' +
        'z-index: 2147483647 !important; pointer-events: none !important;',
    );
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>`;
    document.documentElement.appendChild(host);
    const cleanups = [];

    return {
      host,
      /** 可能覆盖到截图区域的浮层，截图瞬间会被隐藏 */
      floating: [],
      add(cls, text) {
        const el = document.createElement('div');
        el.className = cls;
        if (text) el.textContent = text;
        root.appendChild(el);
        return el;
      },
      place(el, r) {
        Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      },
      /** 穿透自身浮层获取页面元素 */
      elementAt(x, y) {
        host.classList.add('pass');
        const el = document.elementFromPoint(x, y);
        host.classList.remove('pass');
        return el === host ? null : el;
      },
      hideOverlapping(rect) {
        const hidden = this.floating.filter((el) => el.isConnected && intersect(el.getBoundingClientRect(), rect));
        hidden.forEach((el) => (el.style.visibility = 'hidden'));
        return hidden;
      },
      toast(message) {
        this.floating.push(this.add('toast', message));
      },
      listen(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        cleanups.push(() => target.removeEventListener(type, fn, opts));
      },
      destroy() {
        cleanups.forEach((fn) => fn());
        host.remove();
      },
    };
  }

  /** 框选区域，返回 { action: 'scroll' | 'visible', rect } 或 null（取消）。 */
  function selectRegion(ui) {
    return new Promise((resolve) => {
      const mask = ui.add('mask');
      const hint = ui.add('hint', '拖动鼠标框选截图区域 · 滚轮可滚动页面 · Esc 退出');
      const sel = ui.add('sel');
      const label = ui.add('label');
      const bar = ui.add('bar');
      bar.innerHTML =
        '<button class="primary" data-act="scroll" title="Enter">滚动截图</button>' +
        '<button data-act="visible">仅截当前区域</button>' +
        '<button data-act="cancel" title="Esc">取消</button>';
      label.style.display = 'none';
      let rect = null;
      let from = null;

      const layout = () => {
        mask.classList.toggle('picked', !!rect);
        sel.style.display = label.style.display = rect ? 'block' : 'none';
        if (!rect) return;
        ui.place(sel, rect);
        label.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
        label.style.left = `${rect.left}px`;
        label.style.top = `${rect.top >= 28 ? rect.top - 26 : rect.top + 6}px`;
      };

      const showBar = () => {
        bar.classList.add('show');
        const bw = bar.offsetWidth;
        const bh = bar.offsetHeight;
        let top = rect.top + rect.height + 10;
        if (top + bh > innerHeight - 8) top = rect.top - bh - 10;
        if (top < 8) top = rect.top + rect.height - bh - 10;
        bar.style.top = `${top}px`;
        bar.style.left = `${clamp(rect.left + rect.width - bw, 8, innerWidth - bw - 8)}px`;
      };

      const done = (action) => {
        [mask, hint, sel, label, bar].forEach((el) => el.remove());
        window.removeEventListener('keydown', onKey, true);
        resolve(action && rect ? { action, rect } : null);
      };

      const onKey = (e) => {
        if (e.key === 'Escape') done(null);
        else if (e.key === 'Enter' && rect && !from) done('scroll');
        else return;
        e.preventDefault();
        e.stopPropagation();
      };

      mask.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        mask.setPointerCapture(e.pointerId);
        from = { x: e.clientX, y: e.clientY };
        rect = null;
        hint.style.display = 'none';
        bar.classList.remove('show');
        layout();
      });
      mask.addEventListener('pointermove', (e) => {
        if (!from) return;
        const x = clamp(e.clientX, 0, innerWidth);
        const y = clamp(e.clientY, 0, innerHeight);
        rect = { left: Math.min(from.x, x), top: Math.min(from.y, y), width: Math.abs(x - from.x), height: Math.abs(y - from.y) };
        layout();
      });
      mask.addEventListener('pointerup', () => {
        if (!from) return;
        from = null;
        if (!rect || rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
          rect = null;
          hint.style.display = '';
          layout();
          return;
        }
        showBar();
      });
      mask.addEventListener('wheel', (e) => forwardWheel(ui, e), { passive: false });
      bar.addEventListener('click', (e) => {
        const act = e.target.closest?.('button')?.dataset.act;
        if (act) done(act === 'cancel' ? null : act);
      });
      window.addEventListener('keydown', onKey, true);
    });
  }

  /** 截图进行中的浮层：选区边框、阻止交互的遮罩、进度面板。 */
  function showProgress(ui, rect) {
    const state = { stop: null };
    if (rect) ui.place(ui.add('frame'), { left: rect.left - 1, top: rect.top - 1, width: rect.width + 2, height: rect.height + 2 });

    const blocker = ui.add('blocker');
    ui.listen(blocker, 'wheel', (e) => e.preventDefault(), { passive: false });

    const panel = ui.add('panel');
    panel.innerHTML =
      '<span class="dot"></span><span class="txt">准备中…</span>' +
      '<button class="primary" data-act="done" title="Enter">完成</button>' +
      '<button data-act="cancel" title="Esc">取消</button>';
    ui.floating.push(panel);
    panel.addEventListener('click', (e) => {
      const act = e.target.closest?.('button')?.dataset.act;
      if (act) state.stop ??= act;
    });

    // 区域模式下尽量把面板放在选区外，避免截图时闪烁
    if (rect) {
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      let top = null;
      if (rect.top + rect.height + 12 + ph <= innerHeight - 8) top = rect.top + rect.height + 12;
      else if (rect.top - 12 - ph >= 8) top = rect.top - 12 - ph;
      if (top !== null) {
        Object.assign(panel.style, {
          top: `${top}px`,
          left: `${clamp(rect.left + rect.width - pw, 8, innerWidth - pw - 8)}px`,
          right: 'auto',
          bottom: 'auto',
        });
      }
    }

    const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
    ui.listen(
      window,
      'keydown',
      (e) => {
        if (e.key === 'Escape') state.stop = 'cancel';
        else if (e.key === 'Enter') state.stop ??= 'done';
        else if (!SCROLL_KEYS.has(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );

    const txt = panel.querySelector('.txt');
    return {
      state,
      setText: (t) => (txt.textContent = t),
      lock() {
        panel.querySelectorAll('button').forEach((b) => b.remove());
      },
    };
  }

  /* ---------------- 截图流程 ---------------- */

  let running = false;
  let lastShotAt = 0;

  async function shot(ui, crop, docStart, docEnd) {
    const wait = lastShotAt + SHOT_INTERVAL - performance.now();
    if (wait > 0) await sleep(wait);
    const hidden = ui.hideOverlapping(crop);
    await nextPaint();
    try {
      lastShotAt = performance.now();
      await send({ type: 'ss-capture', crop, docStart, docEnd, viewportWidth: innerWidth });
    } finally {
      hidden.forEach((el) => (el.style.visibility = ''));
    }
  }

  async function run(mode, settings) {
    const ui = createUI();
    const overrides = new StyleOverrides();
    let origin = null;
    let begun = false;

    const restorePage = () => {
      if (origin) origin.scroller.top = origin.top;
      origin = null;
      overrides.restore();
    };

    try {
      let rect = null;
      let action = 'scroll';
      let scroller = null;

      if (mode === 'region') {
        const picked = await selectRegion(ui);
        if (!picked) return;
        ({ rect, action } = picked);
        if (action === 'scroll') scroller = findScrollerAt(ui, rect.left + rect.width / 2, rect.top + rect.height / 2);
      } else {
        scroller = findMainScroller();
      }

      const scrolling = action === 'scroll' && !!scroller;
      let fixed = [];
      if (scrolling) {
        origin = { scroller, top: scroller.top };
        overrides.set(scroller.styleEl, 'scroll-behavior', 'auto');
        overrides.set(scroller.styleEl, 'scroll-snap-type', 'none');
        overrides.set(scroller.styleEl, 'overflow-anchor', 'none');
        overrides.set(scroller.styleEl, 'scrollbar-width', 'none');
        if (settings.hideFixed) {
          const found = scanPositioned(scroller);
          found.sticky.forEach((el) => overrides.set(el, 'position', 'static'));
          fixed = found.fixed;
        }
      }

      // 截图区域必须落在滚动容器可视范围内，否则容器外的静态内容会在每一屏重复
      if (mode === 'full') rect = scroller ? scroller.viewRect() : viewportRect();
      else if (scroller) rect = intersect(rect, scroller.viewRect()) || rect;
      if (!rect) throw new Error('没有找到可截取的区域');

      const progress = showProgress(ui, mode === 'region' ? rect : null);
      const { state } = progress;
      if (mode === 'full' && scrolling) scroller.top = 0;
      await sleep(scrolling ? settings.delay : 60);

      await send({ type: 'ss-begin', title: document.title, url: location.href, quality: settings.quality });
      begun = true;

      // 滚动区域边缘常有吸顶栏阴影、底部悬浮条等（滚动后才出现），会在每条拼缝处重复。
      // 因此相邻两屏重叠滚动，中间帧丢弃上下 edge 像素，只取干净的中段；首帧保留顶部，末帧保留底部。
      const edge = scrolling ? Math.min(60, Math.floor(rect.height * 0.12)) : 0;
      const step = rect.height - edge * 2;
      const s0 = scrolling ? scroller.top : 0;
      const atBottom = (top) => !scrolling || top >= scroller.max - 1;

      let docEnd = atBottom(s0) ? rect.height : rect.height - edge;
      await shot(ui, { ...rect, height: docEnd }, 0, docEnd);
      let frames = 1;
      let truncated = false;
      progress.setText(`已截取 ${frames} 屏`);

      if (scrolling && docEnd < rect.height) {
        fixed.forEach((el) => overrides.set(el, 'visibility', 'hidden'));
        let prev = s0;
        while (!state.stop) {
          if (frames >= MAX_FRAMES || docEnd >= MAX_HEIGHT_CSS) {
            truncated = true;
            break;
          }
          scroller.top = prev + step;
          await sleep(settings.delay);
          if (state.stop) break;
          const cur = scroller.top;
          const last = cur - prev < 0.5 || atBottom(cur);
          // 截图区域内第 row 行对应的文档位置为 (cur - s0) + row
          const from = Math.max(0, docEnd - (cur - s0));
          const to = last ? rect.height : rect.height - edge;
          if (to - from >= 0.5) {
            await shot(ui, { ...rect, top: rect.top + from, height: to - from }, docEnd, docEnd + to - from);
            docEnd += to - from;
            frames++;
            progress.setText(`已截取 ${frames} 屏`);
          }
          prev = cur;
          if (last) break;
        }
      }

      if (state.stop === 'cancel') {
        begun = false;
        await send({ type: 'ss-cancel' });
        return;
      }

      restorePage();
      progress.lock();
      progress.setText('正在拼接长图…');
      await send({ type: 'ss-finish', truncated });
      begun = false;
    } catch (err) {
      console.error('[滚动长截图]', err);
      if (begun) send({ type: 'ss-cancel' }).catch(() => {});
      restorePage();
      ui.toast(err?.message || String(err));
      await sleep(3500);
    } finally {
      restorePage();
      ui.destroy();
    }
  }

  window.__scrollShot = {
    isAlive() {
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
    start(mode, settings) {
      if (running) return { error: '截图正在进行中' };
      running = true;
      run(mode, settings).finally(() => (running = false));
      return { ok: true };
    },
  };
})();
