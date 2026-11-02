// FLM-349 preparation only. Evaluate in a disposable page, not a live app.
(() => {
  const key = '__flm350_measurements';
  if (Object.hasOwn(window, key)) throw new Error('sampler-already-present');
  let last = -Infinity, stopped = false;
  const errors = new Set();
  // Do not inspect Error.message, stack, rejection reason, or logged values.
  const error = () => errors.add('window-error');
  const rejection = () => errors.add('unhandled-rejection');
  window.addEventListener('error', error);
  window.addEventListener('unhandledrejection', rejection);
  const n = x => Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
  const box = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return {x:n(r.x), y:n(r.y), width:n(r.width), height:n(r.height),
      display:s.display === 'none' ? 'none' : 'present',
      visibility:['visible','hidden','collapse'].includes(s.visibility) ? s.visibility : 'other',
      opacity:n(Number(s.opacity)), scrollTop:n(el.scrollTop),
      scrollHeight:n(el.scrollHeight), clientHeight:n(el.clientHeight)};
  };
  window[key] = {
    sample() {
      const now = performance.now();
      if (stopped || now - last < 250) return null;
      const gap = Number.isFinite(last) ? n(now-last) : null;
      last = now;
      const root = document.querySelector('#root');
      const list = document.querySelector('[data-message-list]');
      const rows = list ? list.querySelectorAll('[data-message-id]') : [];
      const r = list?.getBoundingClientRect();
      let intersecting = 0;
      for (const row of rows) {
        const b = row.getBoundingClientRect();
        const left = Math.max(0,r.left), top = Math.max(0,r.top);
        const right = Math.min(innerWidth,r.right), bottom = Math.min(innerHeight,r.bottom);
        if (b.width > 0 && b.height > 0 && b.bottom > top && b.top < bottom &&
            b.right > left && b.left < right && right > left && bottom > top) intersecting++;
      }
      const out = {elapsedMs:n(now), gapMs:gap,
        visible:document.visibilityState === 'visible', focused:document.hasFocus(),
        viewport:{width:n(innerWidth),height:n(innerHeight),
          visualWidth:n(visualViewport?.width), visualHeight:n(visualViewport?.height)},
        root:box(root), list:box(list), mountedRows:rows.length,
        intersectingRows:intersecting, errors:[...errors], stackFrames:[]};
      errors.clear();
      return out;
    },
    stop() {
      stopped = true;
      window.removeEventListener('error', error);
      window.removeEventListener('unhandledrejection', rejection);
      errors.clear();
      delete window[key];
      return !Object.hasOwn(window,key);
    }
  };
  return true;
})()
