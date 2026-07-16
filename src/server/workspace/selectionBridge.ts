export const selectionBridge = String.raw`(() => {
  if (window.__coworkSelectionBridge) return;
  window.__coworkSelectionBridge = true;
  let enabled = false;
  let mode = 'mixed';
  let hovered = null;
  let selected = null;
  let lastCanvas = null;
  let lastCompatible = null;

  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true'); box.setAttribute('data-cowork-runtime', 'selection-box');
  Object.assign(box.style, {
    position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', display: 'none',
    border: '2px solid #28dcb2', borderRadius: '4px', background: 'rgba(40,220,178,.09)',
    boxShadow: '0 0 0 1px rgba(0,0,0,.4), 0 0 24px rgba(40,220,178,.25)'
  });
  document.documentElement.appendChild(box);

  const selectStyle = document.createElement('style');
  selectStyle.setAttribute('data-cowork-runtime', 'selection-style');
  selectStyle.textContent = 'html[data-cowork-select-dom="true"] [data-cowork-id]{pointer-events:auto!important}';
  document.documentElement.appendChild(selectStyle);

  function draw(value) {
    let rect;
    if (value instanceof Element) rect = value.isConnected ? value.getBoundingClientRect() : null;
    else if (value && value.kind === 'canvas') {
      const { adapter, canvas } = adapterAndCanvas(); const layer = adapter && typeof adapter.getLayer === 'function' ? adapter.getLayer(value.layerId) : null;
      const bounds = layer && (layer.bounds || layer.rect); rect = canvas && bounds ? viewportRect(canvas, bounds) : value.rect;
    } else rect = value && value.rect;
    if (!rect) { box.style.display = 'none'; return; }
    Object.assign(box.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }

  function escape(value) { return CSS.escape(String(value)); }
  function selectorFor(element) {
    if (element.hasAttribute('data-cowork-id')) return '[data-cowork-id="' + escape(element.getAttribute('data-cowork-id')) + '"]';
    if (element.id) return '#' + escape(element.id);
    const parts = []; let node = element;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase(); const testId = node.getAttribute('data-testid');
      if (testId) { parts.unshift(part + '[data-testid="' + escape(testId) + '"]'); break; }
      const parent = node.parentElement;
      if (parent) { const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName); if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'; }
      parts.unshift(part); node = parent; if (parts.length >= 7) break;
    }
    return parts.join(' > ');
  }

  function describeDom(element) {
    const selector = selectorFor(element); const attributes = {};
    for (const attribute of Array.from(element.attributes).slice(0, 20)) if (!attribute.name.startsWith('data-cowork-runtime')) attributes[attribute.name] = attribute.value.slice(0, 500);
    const rect = element.getBoundingClientRect(); const authoredId = element.getAttribute('data-cowork-id') || element.id;
    return {
      kind: 'dom', identifier: authoredId ? 'authored:' + authoredId : 'selector:' + selector, selector,
      tagName: element.tagName.toLowerCase(), text: (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 2000), attributes,
      outerHTML: element.outerHTML.slice(0, 6000), parentText: (element.parentElement && (element.parentElement.innerText || element.parentElement.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 2000),
      rect: rounded(rect)
    };
  }

  function adapterAndCanvas() {
    const adapter = window.coworkCanvas;
    const proposed = adapter && (typeof adapter.getPrimaryCanvas === 'function' ? adapter.getPrimaryCanvas() : adapter.canvas);
    const canvas = proposed instanceof HTMLCanvasElement ? proposed : typeof proposed === 'string' ? document.querySelector(proposed) : document.querySelector('canvas[data-cowork-canvas-primary]');
    return { adapter, canvas: canvas instanceof HTMLCanvasElement ? canvas : null };
  }

  function canvasSelectionAt(clientX, clientY) {
    const { adapter, canvas } = adapterAndCanvas();
    if (!adapter || !canvas || typeof adapter.hitTest !== 'function') return null;
    const canvasRect = canvas.getBoundingClientRect();
    if (clientX < canvasRect.left || clientX > canvasRect.right || clientY < canvasRect.top || clientY > canvasRect.bottom) return null;
    const point = { x: (clientX - canvasRect.left) * canvas.width / canvasRect.width, y: (clientY - canvasRect.top) * canvas.height / canvasRect.height };
    let layer; try { layer = adapter.hitTest(point); } catch { return null; }
    if (!layer || !layer.id) return null;
    const bounds = layer.bounds || layer.rect;
    if (!bounds) return null;
    const rect = viewportRect(canvas, bounds);
    const canvasId = canvas.getAttribute('data-cowork-id') || canvas.id || 'primary-canvas';
    return {
      kind: 'canvas', identifier: 'canvas:' + String(layer.id), canvasId, layerId: String(layer.id),
      label: String(layer.label || layer.name || layer.id), layerType: String(layer.type || 'layer'),
      properties: safeObject(layer.properties || layer.metadata || {}), rect: rounded(rect), canvasRect: rounded(canvasRect),
      canvasSize: { width: canvas.width, height: canvas.height }
    };
  }

  function candidate(event) {
    if (mode === 'canvas') return canvasSelectionAt(event.clientX, event.clientY);
    if (mode === 'mixed' && event.target instanceof HTMLCanvasElement) return canvasSelectionAt(event.clientX, event.clientY) || event.target;
    return event.target instanceof Element && !event.target.hasAttribute('data-cowork-runtime') ? event.target : null;
  }

  function updateMode() {
    document.documentElement.dataset.coworkSelectDom = String(enabled && mode !== 'canvas');
    document.documentElement.style.cursor = enabled ? 'crosshair' : '';
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === 'cowork:set-select-mode') {
      enabled = Boolean(event.data.enabled); updateMode(); if (!enabled) { hovered = null; draw(selected); }
    }
    if (event.data.type === 'cowork:set-workspace-mode' && ['canvas', 'dom', 'mixed'].includes(event.data.mode)) {
      mode = event.data.mode; updateMode(); if (mode === 'canvas' && selected && (selected instanceof Element || selected.kind !== 'canvas')) { selected = null; draw(null); }
    }
    if (event.data.type === 'cowork:clear-selection') { selected = null; hovered = null; enabled = false; updateMode(); draw(null); }
  });
  document.addEventListener('pointermove', (event) => { if (!enabled) return; hovered = candidate(event); draw(selected || hovered); }, true);
  document.addEventListener('click', (event) => {
    if (!enabled) return;
    const value = candidate(event); event.preventDefault(); event.stopImmediatePropagation();
    if (!value) return;
    selected = value; hovered = null; updateMode(); draw(selected);
    window.parent.postMessage({ type: 'cowork:element-selected', selection: value instanceof Element ? describeDom(value) : value }, '*');
  }, true);
  let externalDragDepth = 0;
  function hasExternalFiles(event) { return Array.from(event.dataTransfer && event.dataTransfer.types || []).includes('Files'); }
  document.addEventListener('dragenter', (event) => {
    if (!hasExternalFiles(event)) return; event.preventDefault(); externalDragDepth++; window.parent.postMessage({ type: 'cowork:external-file-drag', active: true }, '*');
  }, true);
  document.addEventListener('dragover', (event) => {
    if (!hasExternalFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, true);
  document.addEventListener('dragleave', (event) => {
    if (!hasExternalFiles(event)) return; externalDragDepth = Math.max(0, externalDragDepth - 1); if (!externalDragDepth) window.parent.postMessage({ type: 'cowork:external-file-drag', active: false }, '*');
  }, true);
  document.addEventListener('drop', (event) => {
    if (!hasExternalFiles(event)) return; event.preventDefault(); event.stopImmediatePropagation(); externalDragDepth = 0;
    const files = Array.from(event.dataTransfer && event.dataTransfer.files || []); window.parent.postMessage({ type: 'cowork:external-file-drag', active: false }, '*');
    if (files.length) window.parent.postMessage({ type: 'cowork:external-files-dropped', files }, '*');
  }, true);
  addEventListener('scroll', () => draw(selected || (enabled ? hovered : null)), true); addEventListener('resize', () => draw(selected || (enabled ? hovered : null)));
  function trackSelection() { if (selected) draw(selected); requestAnimationFrame(trackSelection); }
  requestAnimationFrame(trackSelection);

  async function announceCanvas() {
    const { adapter, canvas } = adapterAndCanvas();
    const compatible = !!(adapter && canvas && typeof adapter.hitTest === 'function' && typeof adapter.getLayer === 'function');
    if (canvas === lastCanvas && compatible === lastCompatible) return;
    lastCanvas = canvas; lastCompatible = compatible; let restrictionTarget;
    if (canvas && window.RestrictionTarget && typeof window.RestrictionTarget.fromElement === 'function') {
      try { restrictionTarget = await window.RestrictionTarget.fromElement(canvas); } catch { /* reported as unavailable */ }
    }
    window.parent.postMessage({ type: 'cowork:canvas-status', compatible, canvasId: canvas && (canvas.getAttribute('data-cowork-id') || canvas.id), restrictionTarget }, '*');
  }
  addEventListener('cowork:canvas-adapter-ready', () => void announceCanvas());
  new MutationObserver(() => void announceCanvas()).observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(() => void announceCanvas(), 1500);
  window.parent.postMessage({ type: 'cowork:selection-ready' }, '*'); void announceCanvas();

  function rounded(rect) { return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }; }
  function viewportRect(canvas, bounds) { const rect = canvas.getBoundingClientRect(); return { x: rect.left + bounds.x * rect.width / canvas.width, y: rect.top + bounds.y * rect.height / canvas.height, width: bounds.width * rect.width / canvas.width, height: bounds.height * rect.height / canvas.height }; }
  function safeObject(value) { try { return JSON.parse(JSON.stringify(value)); } catch { return {}; } }
})();`;
