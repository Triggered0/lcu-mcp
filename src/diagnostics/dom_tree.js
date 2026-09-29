/**
 * UI Modal Stack & Viewport Hierarchy Analysis
 * Inspects CEF page DOM for active modals, invisible blocking backdrops,
 * viewport plugin routes, and focused elements.
 */

export function buildDomInspectorScript({ includeOverlaysOnly = false, maxDepth = 5 } = {}) {
  const overlaysOnlyJson = JSON.stringify(Boolean(includeOverlaysOnly));
  const maxDepthJson = JSON.stringify(Number(maxDepth) || 5);

  return `(() => {
    try {
      // 1. Viewport & Plugin identification
      const plugins = Array.from(document.querySelectorAll('*'))
        .filter((el) => el.tagName.toLowerCase().startsWith('rcp-fe-lol-'));
      
      const visiblePlugin = plugins.find((el) => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0;
      }) || plugins[0] || null;

      const viewportInfo = {
        activePlugin: visiblePlugin ? visiblePlugin.tagName.toLowerCase() : null,
        currentScreen: visiblePlugin ? visiblePlugin.tagName.toLowerCase() : null,
        routeName: window.location.hash ? window.location.hash.replace(/^#/, '') : (window.location.pathname || null),
        documentTitle: document.title || null,
        location: window.location.href || null
      };

      // 2. Focused Element
      let focusedInfo = null;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) {
        focusedInfo = {
          tag: active.tagName.toLowerCase(),
          id: active.id || null,
          className: active.className || null,
          placeholder: active.placeholder || active.getAttribute('placeholder') || null,
          text: (active.textContent || active.value || '').trim().slice(0, 100) || null
        };
      }

      function checkVisible(el, style) {
        if (!style) style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity || '1') <= 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function parseZIndex(style) {
        const z = parseInt(style.zIndex, 10);
        return Number.isFinite(z) ? z : 0;
      }

      // 3. Active Modals & Dialogs
      const modalSelectors = [
        'lol-uikit-dialog-frame',
        '.modal-container',
        'lol-uikit-full-page-backdrop',
        '[class*="modal"]',
        '.ember-view.active',
        'dialog[open]',
        '[role="dialog"]'
      ];
      const matchedModals = new Set();
      modalSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          if (el !== document.body && el !== document.documentElement && !el.id?.includes('viewport-root')) {
            matchedModals.add(el);
          }
        });
      });

      const modals = [];
      matchedModals.forEach((el) => {
        const style = window.getComputedStyle(el);
        const visible = checkVisible(el, style);
        const titleEl = el.querySelector('h1, h2, h3, [class*="title"], [slot="title"], .dialog-header, lol-uikit-content-block-header');
        const title = titleEl ? titleEl.textContent.trim() : (el.getAttribute('title') || el.getAttribute('data-title') || null);
        const btnNodes = Array.from(el.querySelectorAll('button, lol-uikit-flat-button, [role="button"], input[type="button"], input[type="submit"]'));
        const buttons = btnNodes.slice(0, 10).map((b) => ({
          tag: b.tagName.toLowerCase(),
          text: (b.textContent || b.value || '').trim().replace(/\\s+/g, ' '),
          className: b.className || undefined,
          id: b.id || undefined,
          disabled: b.disabled || b.hasAttribute('disabled') || false
        }));
        modals.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          className: el.className || null,
          title,
          zIndex: parseZIndex(style),
          visible,
          buttons
        });
      });

      // 4. Invisible Backdrops / Blocking Overlays
      const overlays = [];
      const candidateElements = document.querySelectorAll('div, lol-uikit-full-page-backdrop, [class*="backdrop"], [class*="overlay"]');
      const vWidth = window.innerWidth || 1280;
      const vHeight = window.innerHeight || 720;

      candidateElements.forEach((el) => {
        const style = window.getComputedStyle(el);
        const pointerEvents = style.pointerEvents || 'auto';
        if (pointerEvents === 'none') return;
        const opacity = parseFloat(style.opacity || '1');
        const bg = style.backgroundColor;
        const isTransparent = opacity <= 0.05 || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
        const rect = el.getBoundingClientRect();
        const coversViewport = (rect.width >= vWidth * 0.7 && rect.height >= vHeight * 0.7) ||
          (style.position === 'fixed' && rect.width >= vWidth * 0.5 && rect.height >= vHeight * 0.5);

        if (isTransparent && coversViewport) {
          overlays.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            className: el.className || null,
            zIndex: parseZIndex(style),
            opacity,
            pointerEvents,
            coversViewport: true,
            rect: { width: Math.round(rect.width), height: Math.round(rect.height) }
          });
        }
      });

      // 5. Hierarchy Tree
      let hierarchy = null;
      if (!${overlaysOnlyJson}) {
        const maxD = ${maxDepthJson};
        function walk(node, depth) {
          if (!node || node.nodeType !== 1) return null;
          const s = window.getComputedStyle(node);
          const out = {
            tag: node.tagName.toLowerCase(),
            id: node.id || undefined,
            className: node.className || undefined,
            visible: checkVisible(node, s)
          };
          if (depth < maxD && node.children && node.children.length > 0) {
            out.children = Array.from(node.children)
              .slice(0, 30)
              .map((child) => walk(child, depth + 1))
              .filter(Boolean);
          }
          return out;
        }
        const root = document.querySelector('#rcp-fe-viewport-root') || document.body;
        hierarchy = walk(root, 1);
      }

      return {
        modals,
        overlays,
        viewport: viewportInfo,
        focusedElement: focusedInfo,
        hierarchy
      };
    } catch (err) {
      return {
        error: err.message,
        stack: err.stack
      };
    }
  })()`;
}

export function parseDomHierarchy(rawDomData, options = {}) {
  const { includeOverlaysOnly = false, maxDepth = 5 } = options;
  if (!rawDomData || typeof rawDomData !== 'object') {
    return {
      activeModals: [],
      invisibleBackdrops: [],
      viewport: {
        activePlugin: null,
        currentScreen: null,
        routeName: null,
        documentTitle: null,
        location: null
      },
      focusedElement: null,
      hierarchy: null,
      summary: 'No DOM data available'
    };
  }

  const rawModals = Array.isArray(rawDomData.activeModals)
    ? rawDomData.activeModals
    : Array.isArray(rawDomData.modals)
      ? rawDomData.modals
      : [];

  const activeModals = rawModals
    .map((m) => ({
      tag: String(m.tag || 'div').toLowerCase(),
      id: m.id || null,
      className: m.className || null,
      title: m.title || null,
      zIndex: Number.isFinite(m.zIndex) ? m.zIndex : 0,
      visible: Boolean(m.visible ?? true),
      buttons: Array.isArray(m.buttons) ? m.buttons : []
    }))
    .sort((a, b) => b.zIndex - a.zIndex);

  const rawOverlays = Array.isArray(rawDomData.invisibleBackdrops)
    ? rawDomData.invisibleBackdrops
    : Array.isArray(rawDomData.overlays)
      ? rawDomData.overlays
      : [];

  const invisibleBackdrops = rawOverlays
    .filter((o) => {
      const pe = (o.pointerEvents || '').toLowerCase();
      if (pe === 'none') return false;
      const opacity = typeof o.opacity === 'number' ? o.opacity : 1;
      const isTransparent = opacity <= 0.05 || o.isTransparent === true;
      return isTransparent && Boolean(o.coversViewport ?? true);
    })
    .map((o) => ({
      tag: String(o.tag || 'div').toLowerCase(),
      id: o.id || null,
      className: o.className || null,
      zIndex: Number.isFinite(o.zIndex) ? o.zIndex : 0,
      opacity: typeof o.opacity === 'number' ? o.opacity : 0,
      pointerEvents: o.pointerEvents || 'all',
      coversViewport: Boolean(o.coversViewport ?? true),
      blocking: true,
      reason: 'Transparent overlay element with active pointer events covering viewport'
    }))
    .sort((a, b) => b.zIndex - a.zIndex);

  const viewport = {
    activePlugin: rawDomData.viewport?.activePlugin || null,
    currentScreen: rawDomData.viewport?.currentScreen || rawDomData.viewport?.activePlugin || null,
    routeName: rawDomData.viewport?.routeName || null,
    documentTitle: rawDomData.viewport?.documentTitle || null,
    location: rawDomData.viewport?.location || null
  };

  const focused = rawDomData.focusedElement;
  const focusedElement =
    focused && focused.tag && focused.tag.toLowerCase() !== 'body'
      ? {
          tag: String(focused.tag).toLowerCase(),
          id: focused.id || null,
          className: focused.className || null,
          placeholder: focused.placeholder ?? null,
          text: focused.text ?? null
        }
      : null;

  let hierarchy = null;
  if (!includeOverlaysOnly && rawDomData.hierarchy) {
    function trimDepth(node, currentDepth) {
      if (!node) return null;
      const res = {
        tag: node.tag,
        id: node.id || undefined,
        className: node.className || undefined,
        visible: Boolean(node.visible)
      };
      if (currentDepth < maxDepth && Array.isArray(node.children)) {
        res.children = node.children.map((c) => trimDepth(c, currentDepth + 1)).filter(Boolean);
      }
      return res;
    }
    hierarchy = trimDepth(rawDomData.hierarchy, 1);
  }

  const modalCount = activeModals.length;
  const backdropCount = invisibleBackdrops.length;
  const pluginName = viewport.activePlugin || 'unknown';
  let summary = `Plugin: ${pluginName} | Active modals: ${modalCount} | Invisible backdrops: ${backdropCount}`;
  if (backdropCount > 0) {
    summary += ` (WARNING: ${backdropCount} invisible backdrop(s) may block UI clicks)`;
  }

  return {
    activeModals,
    invisibleBackdrops,
    viewport,
    focusedElement,
    hierarchy,
    summary
  };
}

export async function inspectDomTree(cdp, options = {}) {
  const expression = buildDomInspectorScript(options);
  const { value, exceptionDetails } = await cdp.evaluate(expression);
  if (exceptionDetails) {
    throw new Error(
      `CDP DOM inspection failed: ${exceptionDetails.description || exceptionDetails.text || 'unknown error'}`
    );
  }
  if (value?.error) {
    throw new Error(`DOM inspection script failed: ${value.error}`);
  }
  return parseDomHierarchy(value, options);
}
