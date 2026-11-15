// The stylesheet owns the interface's colours and sizes. Canvases and scripts cannot use CSS directly, so they read the same tokens here.
//   Theme.css('--ink')      the token as written in CSS ('#1e1a15')
//   Theme.rgb('--ink')      [r, g, b] in 0..255, whatever notation the token used
//   Theme.num('--lane-h')   a number
//   Theme.onChange(fn)      called when what was read may be stale: once the page's font has loaded, or after Theme.changed()
(function (NS) {
  'use strict';

  const root = document.documentElement;
  let style = null;
  let probe = null;
  const cache = new Map();
  const listeners = [];

  function css(name) {
    if (!style) style = getComputedStyle(root);
    return style.getPropertyValue(name).trim();
  }

  // Any CSS colour → [r, g, b]: let a canvas normalise it
  function rgb(name) {
    if (cache.has(name)) return cache.get(name);
    if (!probe) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      probe = cv.getContext('2d', { willReadFrequently: true });
    }
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = css(name) || '#000';
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    const out = [d[0], d[1], d[2]];
    cache.set(name, out);
    return out;
  }

  const hex = (name) => '#' + rgb(name).map((v) => v.toString(16).padStart(2, '0')).join('');
  const num = (name, fallback) => {
    const v = parseFloat(css(name));
    return isFinite(v) ? v : fallback;
  };

  function changed() {
    style = null;
    cache.clear();
    listeners.forEach((fn) => fn());
  }

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(changed);

  NS.Theme = { css, rgb, hex, num, onChange: (fn) => listeners.push(fn), changed };
})((window.VVVF3D = window.VVVF3D || {}));
