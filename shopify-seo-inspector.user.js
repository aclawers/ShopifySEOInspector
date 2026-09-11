// ==UserScript==
// @name         Shopify SEO 检查器
// @name:en      Shopify SEO Inspector
// @namespace    https://github.com/shopify-seo-inspector
// @version      1.0.0
// @description  一键体检 Shopify 店铺的页面 SEO：标题/描述/Canonical、结构化数据、图片 ALT、内外链、多语言 hreflang、主题与 App、性能指标，并可导出报告。
// @description:en One-click SEO audit for Shopify storefronts: meta, schema, images, links, hreflang, theme/apps and performance.
// @author       you
// @license      MIT
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 0. 基础工具
   * ------------------------------------------------------------------ */

  const HOST_ID = 'shopify-seo-inspector-root';
  if (document.getElementById(HOST_ID)) return; // 防重复注入

  const GM = {
    get(k, d) { try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : JSON.parse(localStorage.getItem('ssi_' + k) ?? 'null') ?? d; } catch (e) { return d; } },
    set(k, v) { try { typeof GM_setValue === 'function' ? GM_setValue(k, v) : localStorage.setItem('ssi_' + k, JSON.stringify(v)); } catch (e) { /* noop */ } },
    clip(t) {
      try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(t, 'text'); return true; } } catch (e) { /* fallthrough */ }
      try { navigator.clipboard.writeText(t); return true; } catch (e) { return false; }
    },
    menu(label, fn) { try { if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(label, fn); } catch (e) { /* noop */ } }
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const trunc = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const num = (n) => (n == null || isNaN(n) ? '-' : Number(n).toLocaleString('zh-CN'));
  const kb = (b) => (b == null || isNaN(b) ? '-' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB');
  const ms = (n) => (n == null || isNaN(n) || n <= 0 ? '-' : n < 1000 ? Math.round(n) + ' ms' : (n / 1000).toFixed(2) + ' s');

  // 估算文字在 Google SERP 中的像素宽度（标题 20px Arial，描述 13.3px Arial）
  const measure = (() => {
    let ctx = null;
    return (text, font) => {
      try {
        if (!ctx) ctx = document.createElement('canvas').getContext('2d');
        ctx.font = font;
        return Math.round(ctx.measureText(String(text || '')).width);
      } catch (e) { return 0; }
    };
  })();

  const wordCount = (text) => {
    const s = String(text || '').trim();
    if (!s) return 0;
    const cjk = (s.match(/[一-龥぀-ヿ가-힯]/g) || []).length;
    const latin = (s.replace(/[一-龥぀-ヿ가-힯]/g, ' ').match(/[A-Za-z0-9''-]+/g) || []).length;
    return cjk + latin;
  };

  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u || ''; } };
  const sameHost = (u) => { try { return new URL(u, location.href).hostname === location.hostname; } catch (e) { return false; } };

  const fetchText = (url, timeout) => new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), timeout || 8000);
    if (typeof fetch !== 'function') { clearTimeout(to); resolve(null); return; }
    fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text().then((t) => ({ ok: true, status: r.status, text: t })) : { ok: false, status: r.status, text: '' }))
      .then((r) => { clearTimeout(to); resolve(r); })
      .catch(() => { clearTimeout(to); resolve(null); });
  });

  /* ------------------------------------------------------------------ *
   * 1. Shopify 环境探测
   * ------------------------------------------------------------------ */

  function detectShopify() {
    const out = {
      isShopify: false, reasons: [], shop: '', theme: null, pageType: '', template: '',
      currency: '', locale: '', money: '', product: null, collection: null, apps: [], designMode: false, passwordPage: false
    };
    const w = window.unsafeWindow || window;

    try {
      if (w.Shopify && typeof w.Shopify === 'object') {
        out.isShopify = true; out.reasons.push('window.Shopify');
        out.shop = w.Shopify.shop || '';
        out.currency = (w.Shopify.currency && w.Shopify.currency.active) || '';
        out.locale = w.Shopify.locale || '';
        out.money = w.Shopify.money_format || '';
        out.designMode = !!w.Shopify.designMode;
        if (w.Shopify.theme) {
          out.theme = {
            id: w.Shopify.theme.id, name: w.Shopify.theme.name,
            role: w.Shopify.theme.role, storeId: w.Shopify.theme.theme_store_id
          };
        }
      }
      const meta = w.ShopifyAnalytics && w.ShopifyAnalytics.meta;
      if (meta) {
        out.isShopify = true; out.reasons.push('ShopifyAnalytics');
        if (meta.page) { out.pageType = meta.page.pageType || ''; out.template = meta.page.resourceType || ''; }
        if (meta.product) out.product = meta.product;
        if (meta.collection) out.collection = meta.collection;
        if (!out.currency && meta.currency) out.currency = meta.currency;
      }
    } catch (e) { /* 跨沙箱读取失败时忽略 */ }

    if ($('meta[name="shopify-checkout-api-token"]')) { out.isShopify = true; out.reasons.push('checkout-api-token'); }
    if ($('link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"], script[src*="cdn.shopifycloud.com"]')) {
      out.isShopify = true; out.reasons.push('cdn.shopify.com');
    }
    if (/Shopify/i.test($('meta[name="generator"]')?.content || '')) { out.isShopify = true; out.reasons.push('generator'); }
    if (!out.pageType) out.pageType = guessPageType();
    out.passwordPage = /^\/password/.test(location.pathname);
    out.apps = detectApps();
    out.reasons = Array.from(new Set(out.reasons));
    return out;
  }

  function guessPageType() {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    if (p === '/' ) return 'home';
    if (/\/products\//.test(p)) return 'product';
    if (/\/collections\/[^/]+$/.test(p)) return 'collection';
    if (p === '/collections') return 'list-collections';
    if (/\/blogs\/[^/]+\/[^/]+/.test(p)) return 'article';
    if (/\/blogs\/[^/]+$/.test(p)) return 'blog';
    if (/\/pages\//.test(p)) return 'page';
    if (/^\/search/.test(p)) return 'search';
    if (/^\/cart/.test(p)) return 'cart';
    if (/^\/account/.test(p)) return 'account';
    if (/^\/policies|^\/\d+\/policies/.test(p)) return 'policy';
    return 'other';
  }

  // 通过脚本域名/路径粗略识别第三方 App
  const APP_SIGNATURES = [
    [/judge\.me/i, 'Judge.me 评论'], [/loox\.io/i, 'Loox 评论'], [/stamped\.io/i, 'Stamped 评论'],
    [/okendo/i, 'Okendo 评论'], [/yotpo/i, 'Yotpo 评论'], [/reviews\.io|reviewsio/i, 'REVIEWS.io'],
    [/klaviyo/i, 'Klaviyo 邮件'], [/omnisend/i, 'Omnisend'], [/privy/i, 'Privy 弹窗'],
    [/gorgias/i, 'Gorgias 客服'], [/tidio/i, 'Tidio 客服'], [/zdassets|zendesk/i, 'Zendesk'],
    [/tawk\.to/i, 'Tawk.to'], [/intercom/i, 'Intercom'],
    [/googletagmanager|google-analytics/i, 'Google 统计/GTM'], [/connect\.facebook\.net/i, 'Meta Pixel'],
    [/analytics\.tiktok/i, 'TikTok Pixel'], [/snap\.licdn|linkedin/i, 'LinkedIn'], [/pinterest/i, 'Pinterest'],
    [/hotjar/i, 'Hotjar'], [/clarity\.ms/i, 'MS Clarity'], [/lucky-?orange/i, 'Lucky Orange'],
    [/pagefly/i, 'PageFly 建站'], [/gempages/i, 'GemPages'], [/shogun/i, 'Shogun'],
    [/boosterapps|booster/i, 'Booster 系列'], [/langshop|weglot|transcy|langify/i, '多语言翻译'],
    [/searchanise|boostcommerce|findify|klevu/i, '搜索筛选'], [/rebuy|zipify|honeycomm|upsell/i, '加购/追售'],
    [/smile\.io|loyaltylion|growave/i, '会员/忠诚度'], [/hulkapps|globo|powr/i, '表单/工具'],
    [/tracktor|aftership|parcelpanel|track123/i, '物流追踪'], [/vitals/i, 'Vitals 全家桶'],
    [/seo/i, 'SEO 类 App']
  ];

  function detectApps() {
    const urls = $$('script[src]').map((s) => s.src).concat($$('link[href]').map((l) => l.href));
    const found = new Map();
    urls.forEach((u) => {
      if (/cdn\.shopify(cloud)?\.com|\/cdn\/shop\//.test(u)) return;
      APP_SIGNATURES.forEach(([re, name]) => { if (re.test(u)) { if (!found.has(name)) found.set(name, u); } });
    });
    return Array.from(found, ([name, url]) => ({ name, url }));
  }

  /* ------------------------------------------------------------------ *
   * 2. 页面数据采集
   * ------------------------------------------------------------------ */

  function collect() {
    const d = {};
    d.url = location.href;
    d.pathname = location.pathname;
    d.title = (document.title || '').trim();
    d.titlePx = measure(d.title, '20px Arial');
    d.desc = ($('meta[name="description"]')?.content || '').trim();
    d.descPx = measure(d.desc, '13.3px Arial');
    d.keywords = ($('meta[name="keywords"]')?.content || '').trim();
    d.canonical = $('link[rel="canonical"]')?.getAttribute('href') || '';
    d.canonicalAbs = d.canonical ? abs(d.canonical) : '';
    d.robots = ($('meta[name="robots"]')?.content || '').trim();
    d.googlebot = ($('meta[name="googlebot"]')?.content || '').trim();
    d.viewport = ($('meta[name="viewport"]')?.content || '').trim();
    d.charset = document.characterSet || '';
    d.lang = document.documentElement.getAttribute('lang') || '';
    d.favicon = $$('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').map((l) => abs(l.href));
    d.amp = $('link[rel="amphtml"]')?.href || '';
    d.next = $('link[rel="next"]')?.href || '';
    d.prev = $('link[rel="prev"]')?.href || '';

    // 标题层级
    d.headings = $$('h1,h2,h3,h4,h5,h6').map((h) => ({
      tag: h.tagName.toLowerCase(),
      level: +h.tagName[1],
      text: trunc(h.innerText || h.textContent, 90),
      empty: !(h.innerText || h.textContent || '').trim(),
      hidden: !h.offsetParent && getComputedStyle(h).display === 'none'
    }));
    d.h1 = d.headings.filter((h) => h.level === 1);

    // Open Graph / Twitter
    d.og = {}; d.tw = {};
    $$('meta[property^="og:"], meta[name^="og:"]').forEach((m) => {
      const k = (m.getAttribute('property') || m.getAttribute('name') || '').replace(/^og:/, '');
      if (!(k in d.og)) d.og[k] = (m.content || '').trim();
    });
    $$('meta[name^="twitter:"], meta[property^="twitter:"]').forEach((m) => {
      const k = (m.getAttribute('name') || m.getAttribute('property') || '').replace(/^twitter:/, '');
      if (!(k in d.tw)) d.tw[k] = (m.content || '').trim();
    });

    // hreflang
    d.hreflang = $$('link[rel="alternate"][hreflang]').map((l) => ({
      lang: l.getAttribute('hreflang'), href: abs(l.getAttribute('href'))
    }));

    // 结构化数据
    d.jsonld = []; d.jsonldErrors = [];
    $$('script[type="application/ld+json"]').forEach((s, i) => {
      const raw = s.textContent || '';
      try {
        const parsed = JSON.parse(raw);
        (Array.isArray(parsed) ? parsed : [parsed]).forEach((node) => {
          if (node && node['@graph'] && Array.isArray(node['@graph'])) d.jsonld.push(...node['@graph']);
          else if (node) d.jsonld.push(node);
        });
      } catch (e) {
        d.jsonldErrors.push({ index: i + 1, message: e.message, snippet: trunc(raw, 120) });
      }
    });
    d.schemaTypes = d.jsonld.map((n) => [].concat(n['@type'] || []).join('/')).filter(Boolean);
    d.microdata = $$('[itemscope][itemtype]').map((n) => n.getAttribute('itemtype'));

    // 正文
    const main = $('main') || $('[role="main"]') || $('#MainContent') || document.body;
    const clone = main.cloneNode(true);
    $$('script,style,noscript,nav,footer,header', clone).forEach((n) => n.remove());
    d.text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
    d.words = wordCount(d.text);

    // 图片
    const vh = window.innerHeight || 800;
    d.images = $$('img').map((img) => {
      const r = img.getBoundingClientRect();
      const dispW = Math.round(r.width) || img.width || 0;
      const dispH = Math.round(r.height) || img.height || 0;
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      return {
        src, alt: img.getAttribute('alt'), hasAlt: img.hasAttribute('alt'),
        altLen: (img.getAttribute('alt') || '').length,
        w: img.getAttribute('width'), h: img.getAttribute('height'),
        natW: img.naturalWidth || 0, natH: img.naturalHeight || 0,
        dispW, dispH,
        loading: img.getAttribute('loading') || '',
        decoding: img.getAttribute('decoding') || '',
        aboveFold: r.top < vh && r.bottom > 0,
        srcset: !!(img.getAttribute('srcset') || img.closest('picture')?.querySelector('source')),
        isCdn: /cdn\.shopify\.com|\/cdn\/shop\//.test(src),
        hasSizeParam: /[?&](width|height)=|_\d+x\d*\./.test(src),
        ext: (src.split('?')[0].match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase(),
        file: decodeURIComponent((src.split('?')[0].split('/').pop() || ''))
      };
    }).filter((i) => i.src && !/^data:/.test(i.src));

    // 链接
    const seen = new Map();
    d.links = $$('a[href]').map((a) => {
      const href = a.getAttribute('href') || '';
      const text = trunc(a.innerText || a.textContent || a.getAttribute('aria-label') || a.querySelector('img')?.alt || '', 60);
      const item = {
        href, abs: abs(href), text,
        internal: sameHost(href) && !/^(mailto:|tel:|javascript:)/i.test(href),
        empty: /^#$|^javascript:/i.test(href.trim()),
        rel: (a.getAttribute('rel') || '').toLowerCase(),
        target: a.getAttribute('target') || '',
        noText: !text.trim()
      };
      if (item.internal && !item.empty) {
        const k = item.abs.split('#')[0];
        if (!seen.has(k)) seen.set(k, new Set());
        seen.get(k).add(text.trim().toLowerCase());
      }
      return item;
    });
    d.linkAnchorMap = seen;

    // 性能
    d.perf = collectPerf();
    return d;
  }

  function collectPerf() {
    const p = { lcp: null, fcp: null, cls: null, ttfb: null, dcl: null, load: null, res: [], byType: {}, total: 0, reqs: 0, blocking: 0 };
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        p.ttfb = nav.responseStart - nav.requestStart;
        p.dcl = nav.domContentLoadedEventEnd;
        p.load = nav.loadEventEnd || nav.domComplete;
      }
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      if (fcp) p.fcp = fcp.startTime;
      const res = performance.getEntriesByType('resource') || [];
      p.reqs = res.length;
      res.forEach((r) => {
        const size = r.transferSize || r.encodedBodySize || 0;
        p.total += size;
        const t = r.initiatorType === 'link' ? 'css' : r.initiatorType;
        p.byType[t] = p.byType[t] || { n: 0, size: 0 };
        p.byType[t].n++; p.byType[t].size += size;
        p.res.push({ url: r.name, type: t, size, dur: r.duration });
      });
      p.res.sort((a, b) => b.size - a.size);
      p.blocking = $$('head script[src]:not([async]):not([defer]):not([type="module"])').length
        + $$('head link[rel="stylesheet"]:not([media="print"])').length;
    } catch (e) { /* noop */ }
    p.lcp = window.__ssiLCP || null;
    p.cls = window.__ssiCLS != null ? window.__ssiCLS : null;
    return p;
  }

  // 尽早挂上 LCP / CLS 观察器
  (function observeWebVitals() {
    try {
      new PerformanceObserver((list) => {
        const e = list.getEntries();
        window.__ssiLCP = e[e.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) { /* noop */ }
    try {
      let cls = 0;
      new PerformanceObserver((list) => {
        list.getEntries().forEach((en) => { if (!en.hadRecentInput) cls += en.value; });
        window.__ssiCLS = cls;
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) { /* noop */ }
  })();

  /* ------------------------------------------------------------------ *
   * 3. 检查规则引擎
   * ------------------------------------------------------------------ */

  const CATS = [
    { id: 'basic', name: '基础 SEO', icon: '📄' },
    { id: 'social', name: '社交分享', icon: '🔗' },
    { id: 'schema', name: '结构化数据', icon: '🧩' },
    { id: 'image', name: '图片', icon: '🖼️' },
    { id: 'link', name: '链接', icon: '⛓️' },
    { id: 'shopify', name: 'Shopify', icon: '🛍️' },
    { id: 'perf', name: '性能', icon: '⚡' }
  ];

  function runChecks(d, sp) {
    const R = [];
    const add = (cat, level, title, detail, weight, fix, extra) => {
      R.push({ cat, level, title, detail: detail || '', weight: weight == null ? 3 : weight, fix: fix || '', extra: extra || null });
    };

    /* ---------- 基础 SEO ---------- */
    if (!d.title) {
      add('basic', 'fail', '缺少页面标题', '<title> 为空', 10, '在 theme.liquid 中输出 {{ page_title }}，或在后台「搜索引擎列表预览」中填写标题。');
    } else {
      const L = d.title.length;
      const lv = L < 15 ? 'warn' : L > 60 || d.titlePx > 600 ? 'warn' : 'pass';
      add('basic', lv, '页面标题',
        `${esc(trunc(d.title, 120))}<br><b>${L}</b> 字符${d.titlePx ? ` · 约 <b>${d.titlePx}</b>px（Google 约 600px 截断）` : ''}`,
        10,
        L > 60 || d.titlePx > 600 ? '标题过长会在搜索结果中被截断，建议控制在 50-60 字符 / 600px 以内，并把核心关键词前置。'
          : L < 15 ? '标题过短，补充品类词 + 卖点 + 品牌名，例如「无线蓝牙耳机 - 降噪续航 30 小时 | 品牌名」。' : '');
      if (/^(home|首页|welcome|untitled)$/i.test(d.title.split(/[|\-–—]/)[0].trim())) {
        add('basic', 'warn', '标题以通用词开头', `「${esc(trunc(d.title, 60))}」缺少关键词`, 4, '首页标题建议写成「主营关键词 | 品牌名」而不是「Home」。');
      }
    }

    if (!d.desc) {
      add('basic', 'fail', '缺少 Meta Description', '未找到 <meta name="description">', 9,
        'Shopify 后台 → 商品/页面 → 编辑网站 SEO → 说明；或在 theme.liquid 中输出 {{ page_description }}。');
    } else {
      const L = d.desc.length;
      const lv = L < 50 ? 'warn' : L > 160 || d.descPx > 960 ? 'warn' : 'pass';
      add('basic', lv, 'Meta Description',
        `${esc(trunc(d.desc, 220))}<br><b>${L}</b> 字符${d.descPx ? ` · 约 <b>${d.descPx}</b>px` : ''}`,
        9, L > 160 ? '描述过长会被截断，建议 120-155 字符，包含关键词与行动号召（免费配送 / 30 天退换）。'
          : L < 50 ? '描述过短，信息量不足，建议补充卖点、适用场景与差异化信息。' : '');
    }

    if (d.keywords) add('basic', 'info', '存在 Meta Keywords', esc(trunc(d.keywords, 120)), 0, 'Google 早已忽略该标签，可删除，不影响排名。');

    if (!d.canonical) {
      add('basic', 'fail', '缺少 Canonical', '未找到 <link rel="canonical">', 8, 'Shopify 默认主题自带 canonical，若缺失请检查 theme.liquid 是否被改动。');
    } else {
      const cur = location.href.split('#')[0];
      const canon = d.canonicalAbs;
      const same = canon.replace(/\/$/, '') === cur.replace(/\/$/, '').split('?')[0].replace(/\/$/, '') ||
        canon.replace(/\/$/, '') === cur.replace(/\/$/, '');
      add('basic', same ? 'pass' : 'info', 'Canonical', `${esc(canon)}${same ? '' : '<br><span class="ssi-muted">与当前 URL 不同（跨页指向时属正常）</span>'}`, 8,
        same ? '' : '确认这是有意的归一化；产品页在集合路径下（/collections/xx/products/yy）应指向 /products/yy。');
      if (!/^https?:\/\//i.test(d.canonical)) add('basic', 'warn', 'Canonical 使用相对路径', esc(d.canonical), 3, 'Canonical 建议使用绝对 URL。');
    }

    const noindex = /noindex/i.test(d.robots) || /noindex/i.test(d.googlebot);
    const nofollowAll = /nofollow/i.test(d.robots);
    if (noindex) {
      const expected = ['search', 'cart', 'account', 'policy'].includes(sp.pageType);
      add('basic', expected ? 'info' : 'fail', 'Meta Robots：noindex', `robots = ${esc(d.robots || d.googlebot)}`, 10,
        expected ? '该类页面本就不需要被索引，属正常。' : '⚠️ 此页面被禁止收录，请确认是否为误配置（常见于 SEO App 批量设置或主题代码）。');
    } else {
      add('basic', 'pass', '允许索引', d.robots ? `robots = ${esc(d.robots)}` : '未设置 robots（默认 index,follow）', 10, '');
    }
    if (nofollowAll) add('basic', 'warn', '整页 nofollow', `robots = ${esc(d.robots)}`, 5, '会阻断站内权重传递，除非刻意为之，否则移除。');

    const h1n = d.h1.length;
    add('basic', h1n === 1 ? 'pass' : 'fail', `H1 数量：${h1n}`,
      h1n ? d.h1.map((h) => esc(h.text) || '<i>（空）</i>').join('<br>') : '页面没有 H1',
      7, h1n === 0 ? '每个页面应有且仅有一个 H1，通常是商品名 / 集合名 / 文章标题。'
        : h1n > 1 ? '多个 H1 会稀释主题聚焦，把次要标题改为 H2。' : '');

    // 标题层级跳跃
    let skip = null, last = 0;
    d.headings.forEach((h) => { if (last && h.level > last + 1 && !skip) skip = `${'H' + last} → ${'H' + h.level}（${trunc(h.text, 40)}）`; last = h.level; });
    add('basic', skip ? 'warn' : 'pass', '标题层级结构',
      `共 ${d.headings.length} 个标题：` + ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((t) => `${t.toUpperCase()} ${d.headings.filter((x) => x.tag === t).length}`).join(' · ')
      + (skip ? `<br>存在跳级：${esc(skip)}` : ''),
      4, skip ? '标题应逐级递进（H1→H2→H3），不要为了样式跳级。' : '');

    const emptyH = d.headings.filter((h) => h.empty).length;
    if (emptyH) add('basic', 'warn', `${emptyH} 个空标题标签`, '存在没有文字内容的 Hx 标签', 2, '删除空标题，或改用 div 承载装饰元素。');

    add('basic', d.lang ? 'pass' : 'warn', 'HTML lang 属性', d.lang ? esc(d.lang) : '未设置', 4, d.lang ? '' : '在 <html> 上输出 lang="{{ request.locale.iso_code }}"。');
    add('basic', d.viewport ? 'pass' : 'fail', '移动端 viewport', d.viewport ? esc(d.viewport) : '未设置', 5, d.viewport ? '' : '添加 <meta name="viewport" content="width=device-width,initial-scale=1">。');
    add('basic', /utf-8/i.test(d.charset) ? 'pass' : 'warn', '字符编码', esc(d.charset || '未知'), 2, '');
    add('basic', d.favicon.length ? 'pass' : 'warn', 'Favicon', d.favicon.length ? esc(trunc(d.favicon[0], 80)) : '未设置', 2, d.favicon.length ? '' : 'Google 搜索结果会展示站点图标，建议上传 48×48 以上的 favicon。');

    const wl = d.words < 150 ? 'warn' : d.words < 300 ? 'info' : 'pass';
    add('basic', wl, `正文字数：${num(d.words)}`, `提取自 <main> 区域，约 ${num(d.text.length)} 字符`, 5,
      d.words < 300 ? '内容偏薄。商品页建议 300+ 字原创描述（避免直接复制供应商文案），集合页补充 150-300 字导购文案。' : '');

    // URL 结构
    const urlIssues = [];
    if (location.pathname.length > 100) urlIssues.push('路径过长');
    if (/[A-Z]/.test(location.pathname)) urlIssues.push('包含大写字母');
    if (/_/.test(location.pathname)) urlIssues.push('使用下划线（建议短横线）');
    if (/%[0-9A-F]{2}/i.test(location.pathname)) urlIssues.push('包含非 ASCII 转义字符');
    if (location.search.split('&').filter(Boolean).length > 2) urlIssues.push('查询参数较多');
    add('basic', urlIssues.length ? 'warn' : 'pass', 'URL 结构',
      esc(decodeURIComponent(location.pathname + location.search)) + (urlIssues.length ? `<br>问题：${urlIssues.join('、')}` : ''),
      3, urlIssues.length ? 'Shopify 的 handle 建议使用小写英文 + 短横线，且包含核心关键词。修改 handle 后记得做 301 重定向。' : '');

    /* ---------- 社交分享 ---------- */
    const ogNeed = ['title', 'description', 'image', 'url', 'type'];
    const ogMiss = ogNeed.filter((k) => !d.og[k]);
    add('social', ogMiss.length === 0 ? 'pass' : ogMiss.length >= 4 ? 'fail' : 'warn', 'Open Graph 标签',
      Object.keys(d.og).length
        ? Object.keys(d.og).slice(0, 8).map((k) => `<b>og:${esc(k)}</b> = ${esc(trunc(d.og[k], 90))}`).join('<br>') + (ogMiss.length ? `<br><span class="ssi-bad">缺失：${ogMiss.map((k) => 'og:' + k).join(', ')}</span>` : '')
        : '未找到任何 og: 标签',
      6, ogMiss.length ? '缺失 OG 标签会导致 Facebook / WhatsApp / Line 分享时无缩略图。Shopify 默认主题在 snippets/meta-tags.liquid 中输出。' : '');

    if (d.og.image) {
      const w = d.og['image:width'], h = d.og['image:height'];
      add('social', 'info', 'OG 图片', `${esc(trunc(d.og.image, 100))}${w && h ? `<br>声明尺寸 ${w}×${h}` : '<br>未声明 og:image:width/height'}`, 2,
        '建议 1200×630、小于 8MB，避免使用透明 PNG（社交平台底色不可控）。');
    }
    add('social', d.tw.card ? 'pass' : 'warn', 'Twitter Card', d.tw.card ? `card = ${esc(d.tw.card)}` : '未设置 twitter:card', 3,
      d.tw.card ? '' : '添加 twitter:card（summary_large_image）、twitter:title、twitter:description、twitter:image。');

    /* ---------- 结构化数据 ---------- */
    if (d.jsonldErrors.length) {
      add('schema', 'fail', `${d.jsonldErrors.length} 段 JSON-LD 解析失败`,
        d.jsonldErrors.map((e) => `#${e.index}: ${esc(e.message)}<br><code>${esc(e.snippet)}</code>`).join('<br>'),
        6, 'JSON 语法错误会导致整段结构化数据失效，常见原因是 Liquid 输出未转义（应使用 | json 过滤器）。');
    }
    const types = Array.from(new Set(d.schemaTypes));
    add('schema', types.length ? 'pass' : 'warn', 'JSON-LD 类型',
      types.length ? types.map((t) => `<span class="ssi-tag">${esc(t)}</span>`).join(' ') : '页面没有 JSON-LD 结构化数据',
      6, types.length ? '' : '结构化数据是获得富摘要（价格、星级、面包屑）的前提，建议在主题中补全。');
    if (d.microdata.length) add('schema', 'info', 'Microdata', Array.from(new Set(d.microdata)).slice(0, 6).map((t) => esc(t.split('/').pop())).join(', '), 0, '与 JSON-LD 重复时以 JSON-LD 为准，注意不要出现冲突数据。');

    const hasType = (re) => d.jsonld.find((n) => [].concat(n['@type'] || []).some((t) => re.test(t)));
    const expectMap = {
      product: [/^Product$/i, 'Product'],
      article: [/Article|BlogPosting/i, 'Article/BlogPosting'],
      collection: [/CollectionPage|ItemList/i, 'CollectionPage/ItemList'],
      home: [/Organization|WebSite|Store|LocalBusiness/i, 'Organization/WebSite']
    };
    const exp = expectMap[sp.pageType];
    if (exp) {
      const node = hasType(exp[0]);
      add('schema', node ? 'pass' : 'fail', `${sp.pageType} 页应有 ${exp[1]} 结构化数据`,
        node ? '已检测到' : `当前类型：${types.join(', ') || '无'}`, 7,
        node ? '' : `缺少 ${exp[1]} schema，会失去富摘要展示机会。`);
    }
    if (!hasType(/BreadcrumbList/i) && ['product', 'collection', 'article', 'page'].includes(sp.pageType)) {
      add('schema', 'warn', '缺少面包屑结构化数据', '未检测到 BreadcrumbList', 4, '添加 BreadcrumbList 可让搜索结果显示层级路径，提高点击率。');
    } else if (hasType(/BreadcrumbList/i)) {
      add('schema', 'pass', '面包屑结构化数据', '已检测到 BreadcrumbList', 4, '');
    }

    const prod = hasType(/^Product$/i);
    if (sp.pageType === 'product' && prod) {
      const offers = [].concat(prod.offers || [])[0] || {};
      const missing = [];
      if (!prod.name) missing.push('name');
      if (!prod.image) missing.push('image');
      if (!prod.description) missing.push('description');
      if (!prod.offers) missing.push('offers');
      if (!offers.price && !offers.lowPrice) missing.push('offers.price');
      if (!offers.priceCurrency) missing.push('offers.priceCurrency');
      if (!offers.availability) missing.push('offers.availability');
      add('schema', missing.length ? (missing.length > 2 ? 'fail' : 'warn') : 'pass', 'Product Schema 必填字段',
        missing.length ? `缺失：<span class="ssi-bad">${missing.join(', ')}</span>` : '必填字段齐全'
          + `<br>价格 ${esc(offers.price || offers.lowPrice || '-')} ${esc(offers.priceCurrency || '')} · 库存 ${esc(String(offers.availability || '-').split('/').pop())}`,
        7, missing.length ? 'Google 商品富摘要要求 name / image / offers(price, priceCurrency, availability)。' : '');
      const rec = [];
      if (!prod.sku && !prod.mpn && !prod.gtin && !prod.gtin13) rec.push('sku / gtin / mpn');
      if (!prod.brand) rec.push('brand');
      if (!prod.aggregateRating && !prod.review) rec.push('aggregateRating / review');
      if (rec.length) add('schema', 'info', 'Product Schema 建议补充', rec.join('、'), 3,
        'brand + gtin/sku 可提升商品匹配度；评分数据能带来星级富摘要（需页面真实展示评论）。');
      if (offers.priceValidUntil) {
        const exp2 = new Date(offers.priceValidUntil);
        if (exp2 < new Date()) add('schema', 'warn', 'priceValidUntil 已过期', esc(offers.priceValidUntil), 3, '过期日期会让富摘要失效，改为动态输出未来日期或移除该字段。');
      }
    }

    /* ---------- 图片 ---------- */
    const imgs = d.images;
    const noAlt = imgs.filter((i) => !i.hasAlt);
    const emptyAlt = imgs.filter((i) => i.hasAlt && !String(i.alt).trim());
    const longAlt = imgs.filter((i) => i.altLen > 125);
    if (!imgs.length) {
      add('image', 'info', '页面无图片', '未检测到 <img> 元素（可能全部使用 CSS 背景图）', 0, 'CSS 背景图无法被图片搜索收录，重要视觉内容建议用 <img> + alt。');
    } else {
      const ratio = noAlt.length / imgs.length;
      add('image', noAlt.length === 0 ? 'pass' : ratio > 0.3 ? 'fail' : 'warn',
        `ALT 缺失：${noAlt.length}/${imgs.length}`,
        noAlt.length ? noAlt.slice(0, 8).map((i) => esc(trunc(i.file || i.src, 70))).join('<br>') + (noAlt.length > 8 ? `<br>… 另有 ${noAlt.length - 8} 张` : '') : '全部图片都有 alt 属性',
        8, noAlt.length ? 'Shopify 后台「商品 → 媒体 → 编辑替代文本」可批量补充；装饰性图片用 alt="" 显式留空。' : '',
        { type: 'images', items: noAlt });
      if (emptyAlt.length) add('image', 'info', `${emptyAlt.length} 张图片 alt 为空`, 'alt="" 表示装饰性图片，会被读屏器跳过', 1, '若是商品图/内容图，应补充描述性文字。');
      if (longAlt.length) add('image', 'warn', `${longAlt.length} 张图片 ALT 过长`, '超过 125 字符', 2, 'ALT 保持在 125 字符内，自然描述图片内容并含关键词，不要堆砌。');

      const noDim = imgs.filter((i) => (!i.w || !i.h) && i.dispW > 50);
      add('image', noDim.length ? 'warn' : 'pass', `未声明宽高：${noDim.length}/${imgs.length}`,
        noDim.length ? '缺少 width/height 会造成布局偏移（CLS）' : '全部图片都声明了尺寸', 5,
        noDim.length ? '给 <img> 加上 width/height 属性（Liquid: width="{{ image.width }}" height="{{ image.height }}"）。' : '');

      const lazyMiss = imgs.filter((i) => !i.aboveFold && i.loading !== 'lazy' && i.dispW > 50);
      const eagerAbove = imgs.filter((i) => i.aboveFold && i.loading === 'lazy');
      add('image', lazyMiss.length > 3 ? 'warn' : 'pass', `未懒加载的首屏外图片：${lazyMiss.length}`,
        lazyMiss.length ? lazyMiss.slice(0, 5).map((i) => esc(trunc(i.file, 60))).join('<br>') : '首屏外图片均已懒加载', 4,
        lazyMiss.length > 3 ? '为首屏以下图片添加 loading="lazy"。' : '');
      if (eagerAbove.length) add('image', 'warn', `${eagerAbove.length} 张首屏图片使用了 lazy`, '会拖慢 LCP', 4, '首屏主图应使用 loading="eager" 与 fetchpriority="high"。');

      const oversize = imgs.filter((i) => i.natW && i.dispW > 40 && i.natW > i.dispW * 2.2);
      add('image', oversize.length ? 'warn' : 'pass', `尺寸过大的图片：${oversize.length}`,
        oversize.length ? oversize.slice(0, 6).map((i) => `${esc(trunc(i.file, 50))} <span class="ssi-muted">原图 ${i.natW}×${i.natH} → 显示 ${i.dispW}×${i.dispH}</span>`).join('<br>') : '图片实际尺寸与显示尺寸匹配', 5,
        oversize.length ? 'Shopify CDN 支持按需裁剪：{{ image | image_url: width: 800 }}，并配合 srcset 输出多档尺寸。' : '');

      const noSrcset = imgs.filter((i) => !i.srcset && i.dispW > 200);
      if (noSrcset.length) add('image', 'info', `${noSrcset.length} 张大图未使用 srcset`, '无法按设备分辨率自适应', 2, '使用 image_url + srcset 输出 375/750/1100/1500 多档宽度。');

      const badName = imgs.filter((i) => /^(img|dsc|image|photo|screenshot)[-_ ]?\d+\./i.test(i.file) || /[一-龥\s]/.test(i.file));
      if (badName.length) add('image', 'info', `${badName.length} 张图片文件名不规范`,
        badName.slice(0, 5).map((i) => esc(trunc(i.file, 60))).join('<br>'), 2,
        '图片文件名也是排名因素，上传前改为 blue-cotton-tshirt-front.jpg 这类描述性英文名（Shopify 上传后无法改名，需重新上传）。');

      const nonCdn = imgs.filter((i) => !i.isCdn && sameHost(i.src));
      if (nonCdn.length) add('image', 'info', `${nonCdn.length} 张图片未走 Shopify CDN`, '', 1, '把图片上传到 Shopify Files 或商品媒体，可获得全球 CDN 与自动 WebP。');
    }

    /* ---------- 链接 ---------- */
    const links = d.links;
    const internal = links.filter((l) => l.internal && !l.empty);
    const external = links.filter((l) => !l.internal && !l.empty && /^https?:/i.test(l.abs));
    add('link', 'info', `链接总数：${links.length}`, `站内 ${internal.length} · 站外 ${external.length}`, 0,
      internal.length < 5 ? '站内链接偏少，商品页可增加「相关商品 / 所属集合 / 尺码指南」等内链。' : '');

    const emptyLinks = links.filter((l) => l.empty);
    if (emptyLinks.length) add('link', emptyLinks.length > 10 ? 'warn' : 'info', `${emptyLinks.length} 个空链接`, 'href="#" 或 javascript:', 2, '交互元素应使用 <button>，避免产生无意义链接。');

    const noTextLinks = links.filter((l) => l.noText && !l.empty);
    if (noTextLinks.length) add('link', 'warn', `${noTextLinks.length} 个链接没有可读文本`,
      noTextLinks.slice(0, 5).map((l) => esc(trunc(l.href, 70))).join('<br>'), 3,
      '为图标链接添加 aria-label，为图片链接添加 alt，让爬虫理解链接指向。');

    const generic = links.filter((l) => /^(点击这里|查看更多|更多|here|click here|read more|learn more|link|详情)$/i.test(l.text.trim()));
    if (generic.length) add('link', 'info', `${generic.length} 个通用锚文本`, generic.slice(0, 5).map((l) => esc(l.text)).join('、'), 2, '锚文本应描述目标页内容，如「查看男士跑鞋系列」。');

    const unsafeExt = external.filter((l) => l.target === '_blank' && !/noopener|noreferrer/.test(l.rel));
    if (unsafeExt.length) add('link', 'warn', `${unsafeExt.length} 个外链缺少 rel="noopener"`, unsafeExt.slice(0, 5).map((l) => esc(trunc(l.abs, 70))).join('<br>'), 3, 'target="_blank" 必须配 rel="noopener noreferrer"，否则存在安全与性能问题。');

    const nofollowExt = external.filter((l) => /nofollow|sponsored|ugc/.test(l.rel)).length;
    if (external.length) add('link', 'info', `外链 nofollow 比例：${nofollowExt}/${external.length}`,
      Array.from(new Set(external.map((l) => { try { return new URL(l.abs).hostname; } catch (e) { return ''; } }))).filter(Boolean).slice(0, 8).join('、'), 0,
      '广告/合作链接应加 rel="sponsored"，用户生成内容加 rel="ugc"。');

    let conflict = 0;
    d.linkAnchorMap.forEach((set) => { if (set.size > 2) conflict++; });
    if (conflict) add('link', 'info', `${conflict} 个 URL 使用了 3 种以上锚文本`, '', 1, '同一目标页锚文本保持相对一致，有助于主题聚焦。');

    const httpLinks = links.filter((l) => /^http:\/\//i.test(l.abs));
    if (httpLinks.length) add('link', 'warn', `${httpLinks.length} 个 HTTP 链接`, httpLinks.slice(0, 4).map((l) => esc(trunc(l.abs, 70))).join('<br>'), 3, '全站应使用 HTTPS，混合内容会被浏览器拦截。');

    /* ---------- Shopify ---------- */
    add('shopify', sp.isShopify ? 'info' : 'warn', sp.isShopify ? '已识别为 Shopify 站点' : '未识别为 Shopify 站点',
      sp.isShopify ? `店铺：<b>${esc(sp.shop || location.hostname)}</b> · 依据：${esc(sp.reasons.join(', '))}` : '部分 Shopify 专项检查可能不准确', 0, '');

    if (sp.theme) {
      add('shopify', 'info', '当前主题',
        `${esc(sp.theme.name || '-')} <span class="ssi-muted">(id ${esc(sp.theme.id)}${sp.theme.storeId ? ' · store ' + esc(sp.theme.storeId) : ' · 自定义主题'}${sp.theme.role ? ' · ' + esc(sp.theme.role) : ''})</span>`, 0, '');
    }
    add('shopify', 'info', '页面类型', `${esc(sp.pageType)}${sp.template ? ' / ' + esc(sp.template) : ''}${sp.locale ? ' · locale ' + esc(sp.locale) : ''}${sp.currency ? ' · ' + esc(sp.currency) : ''}`, 0, '');
    if (sp.designMode) add('shopify', 'info', '当前处于主题编辑器预览', 'Shopify.designMode = true', 0, '编辑器预览下部分脚本行为与线上不同，建议在正式页面复测。');
    if (sp.passwordPage) add('shopify', 'fail', '店铺处于密码保护状态', '/password 页面', 6, '密码页会阻止所有收录，上线前记得在「在线商店 → 偏好设置」中关闭。');

    // 产品页专项
    if (sp.pageType === 'product') {
      const inColl = /\/collections\/[^/]+\/products\//.test(location.pathname);
      if (inColl) {
        const ok = d.canonicalAbs && !/\/collections\//.test(d.canonicalAbs);
        add('shopify', ok ? 'pass' : 'fail', '集合路径下的商品 Canonical', esc(d.canonicalAbs || '无'), 6,
          ok ? '' : 'Shopify 会为同一商品生成 /collections/xx/products/yy 与 /products/yy 两个 URL，canonical 必须指向后者，否则造成重复内容。');
      }
      if (location.search.includes('variant=')) {
        const ok = d.canonicalAbs && !/variant=/.test(d.canonicalAbs);
        add('shopify', ok ? 'pass' : 'warn', 'Variant 参数与 Canonical', esc(d.canonicalAbs || '无'), 4, ok ? '' : '?variant= 参数页应 canonical 到主商品 URL。');
      }
      const gallery = imgs.filter((i) => i.isCdn && i.dispW > 150);
      add('shopify', gallery.length >= 3 ? 'pass' : 'warn', `商品图数量（可见大图）：${gallery.length}`, '', 3,
        gallery.length < 3 ? '建议 4-8 张：正面、细节、使用场景、尺寸对比、包装，有助于转化与图片搜索流量。' : '');
      if (sp.product) {
        const p = sp.product;
        const v = (p.variants || [])[0] || {};
        add('shopify', 'info', '商品数据',
          `ID ${esc(p.id)} · 变体 ${(p.variants || []).length} 个<br>厂商 ${esc(p.vendor || '-')} · 类型 ${esc(p.type || '-')}<br>SKU ${esc(v.sku || '-')} · 价格 ${esc(v.price != null ? (v.price / 100).toFixed(2) : '-')} ${esc(sp.currency)}`, 0, '');
        if (!v.sku) add('shopify', 'warn', '首个变体缺少 SKU', '', 3, 'SKU/条码有助于结构化数据与 Google 购物匹配。');
        if (!p.vendor || /^(default|vendor|品牌)$/i.test(p.vendor)) add('shopify', 'warn', '商品缺少有效品牌（vendor）', esc(p.vendor || '空'), 3, 'vendor 会映射到 schema 的 brand 字段，请填写真实品牌名。');
      }
      const descNode = $('.product__description, [class*="product-description"], [id*="ProductDescription"], .rte');
      const dw = wordCount(descNode ? (descNode.innerText || descNode.textContent) : '');
      if (descNode) add('shopify', dw >= 200 ? 'pass' : 'warn', `商品描述字数：${num(dw)}`, '', 5,
        dw < 200 ? '商品描述建议 200-500 字原创内容，覆盖材质、尺寸、适用场景、保养方式与常见问答；直接复制供应商文案容易被判定为重复内容。' : '');
    }

    // 集合页专项
    if (sp.pageType === 'collection') {
      const descNode = $('.collection-hero__description, [class*="collection-description"], .collection__description, .rte');
      const dw = wordCount(descNode ? (descNode.innerText || descNode.textContent) : '');
      add('shopify', dw >= 100 ? 'pass' : 'warn', `集合描述字数：${num(dw)}`, dw ? '' : '未检测到集合描述', 5,
        dw < 100 ? '集合页是承接品类词的核心页面，建议添加 150-300 字导购文案（可放在商品网格下方避免干扰体验）。' : '');
      const hasPager = $$('a[href*="page="], .pagination a').length > 0;
      if (hasPager) {
        add('shopify', d.next || d.prev ? 'pass' : 'info', '分页 rel=next/prev',
          d.next || d.prev ? `${d.prev ? 'prev: ' + esc(trunc(d.prev, 60)) + '<br>' : ''}${d.next ? 'next: ' + esc(trunc(d.next, 60)) : ''}` : '未输出 rel=next/prev',
          3, d.next || d.prev ? '' : 'Google 虽已不再用作索引信号，但仍建议输出，同时确保分页页面的 canonical 指向自身而非第一页。');
        if (d.canonicalAbs && /page=\d/.test(location.search) && !/page=/.test(d.canonicalAbs)) {
          add('shopify', 'fail', '分页 canonical 指向了第一页', esc(d.canonicalAbs), 5, '第 2 页及以后的 canonical 应指向自身，否则后续页商品无法被发现。');
        }
      }
      const filterParams = ['filter.', 'sort_by', 'pf_'];
      if (filterParams.some((f) => location.search.includes(f))) {
        add('shopify', noindex ? 'pass' : 'warn', '筛选/排序参数页', esc(location.search), 4,
          noindex ? '' : '筛选与排序组合会产生大量近似重复页面，建议对这类 URL 设置 noindex 或 canonical 到无参版本。');
      }
    }

    if (sp.pageType === 'article') {
      const art = hasType(/Article|BlogPosting/i);
      if (art) {
        const miss = ['headline', 'image', 'datePublished', 'author'].filter((k) => !art[k]);
        if (miss.length) add('shopify', 'warn', '文章结构化数据字段缺失', miss.join(', '), 4, '补充 headline / image / datePublished / dateModified / author。');
      }
    }

    // hreflang
    if (d.hreflang.length) {
      const selfRef = d.hreflang.some((h) => h.href.replace(/\/$/, '') === location.href.split('?')[0].replace(/\/$/, ''));
      const xdefault = d.hreflang.some((h) => /x-default/i.test(h.lang));
      const dup = d.hreflang.length !== new Set(d.hreflang.map((h) => h.lang)).size;
      const lvl = !selfRef || !xdefault || dup ? 'warn' : 'pass';
      add('shopify', lvl, `hreflang 标签：${d.hreflang.length} 个`,
        d.hreflang.slice(0, 10).map((h) => `<b>${esc(h.lang)}</b> ${esc(trunc(h.href, 70))}`).join('<br>')
        + (d.hreflang.length > 10 ? `<br>… 另有 ${d.hreflang.length - 10} 个` : '')
        + `<br>自引用 ${selfRef ? '✅' : '❌'} · x-default ${xdefault ? '✅' : '❌'}${dup ? ' · <span class="ssi-bad">存在重复语言代码</span>' : ''}`,
        5, lvl === 'pass' ? '' : 'hreflang 必须双向且包含自引用，同时提供 x-default 指向默认市场版本。');
    } else if (sp.isShopify) {
      add('shopify', 'info', '未检测到 hreflang', '单语言店铺可忽略', 0, '若已开启 Shopify Markets 多语言/多国家，需在 theme.liquid 中输出 hreflang 标签。');
    }

    // 第三方 App
    const appN = sp.apps.length;
    add('shopify', appN > 12 ? 'warn' : 'info', `检测到第三方脚本：${appN} 类`,
      appN ? sp.apps.map((a) => `<span class="ssi-tag">${esc(a.name)}</span>`).join(' ') : '未识别到常见 App 脚本', 3,
      appN > 12 ? 'App 脚本是 Shopify 店铺最主要的性能杀手，卸载不用的 App 后记得手动清理主题里残留的代码片段。' : '');

    /* ---------- 性能 ---------- */
    const p = d.perf;
    const lcpLv = p.lcp == null ? 'info' : p.lcp <= 2500 ? 'pass' : p.lcp <= 4000 ? 'warn' : 'fail';
    add('perf', lcpLv, 'LCP 最大内容绘制', p.lcp == null ? '本次浏览未采集到（可刷新页面后重测）' : `${ms(p.lcp)} <span class="ssi-muted">（优秀 ≤2.5s）</span>`, 6,
      lcpLv === 'pass' ? '' : '优化首屏主图（预加载 + eager + 合适尺寸）、减少阻塞渲染脚本、精简轮播插件。');
    const clsLv = p.cls == null ? 'info' : p.cls <= 0.1 ? 'pass' : p.cls <= 0.25 ? 'warn' : 'fail';
    add('perf', clsLv, 'CLS 累积布局偏移', p.cls == null ? '未采集' : `${p.cls.toFixed(3)} <span class="ssi-muted">（优秀 ≤0.1）</span>`, 5,
      clsLv === 'pass' ? '' : '为图片/广告位/弹窗预留固定尺寸，字体加载使用 font-display: swap 并预加载。');
    add('perf', 'info', '加载时间', `TTFB ${ms(p.ttfb)} · FCP ${ms(p.fcp)} · DOMContentLoaded ${ms(p.dcl)} · Load ${ms(p.load)}`, 0, '');

    const reqLv = p.reqs > 150 ? 'fail' : p.reqs > 90 ? 'warn' : 'pass';
    add('perf', reqLv, `请求数：${num(p.reqs)}`,
      Object.keys(p.byType).sort((a, b) => p.byType[b].size - p.byType[a].size)
        .map((t) => `${esc(t)} ${p.byType[t].n} 个 / ${kb(p.byType[t].size)}`).join(' · '), 4,
      reqLv === 'pass' ? '' : '合并/延迟非关键脚本，删除无用 App，图片使用 CDN 尺寸参数。');

    const sizeLv = p.total > 5e6 ? 'fail' : p.total > 3e6 ? 'warn' : 'pass';
    add('perf', sizeLv, `资源总大小：${kb(p.total)}`, `其中图片 ${kb((p.byType.img || {}).size || 0)} · 脚本 ${kb((p.byType.script || {}).size || 0)} · 样式 ${kb((p.byType.css || {}).size || 0)}`, 4,
      sizeLv === 'pass' ? '' : '移动端首屏建议控制在 2MB 以内。');

    add('perf', p.blocking > 6 ? 'warn' : 'pass', `阻塞渲染资源：${p.blocking}`, 'head 中同步 script + 阻塞 CSS', 4,
      p.blocking > 6 ? '为脚本添加 defer/async，非关键 CSS 异步加载。' : '');

    if (p.res.length) {
      add('perf', 'info', '最大的 5 个资源',
        p.res.slice(0, 5).map((r) => `${kb(r.size)} <span class="ssi-muted">${esc(r.type)}</span> ${esc(trunc(r.url.replace(/^https?:\/\//, ''), 70))}`).join('<br>'), 0, '');
    }

    return R;
  }

  function scoreOf(results) {
    let got = 0, total = 0;
    results.forEach((r) => {
      if (!r.weight || r.level === 'info') return;
      total += r.weight;
      got += r.level === 'pass' ? r.weight : r.level === 'warn' ? r.weight * 0.5 : 0;
    });
    return total ? Math.round((got / total) * 100) : 0;
  }

  /* ------------------------------------------------------------------ *
   * 4. 异步补充检查（robots.txt / sitemap.xml / 商品 JSON）
   * ------------------------------------------------------------------ */

  async function asyncChecks(d, sp, push) {
    const origin = location.origin;

    const [robots, sitemap] = await Promise.all([
      fetchText(origin + '/robots.txt'),
      fetchText(origin + '/sitemap.xml')
    ]);

    if (robots && robots.ok) {
      const txt = robots.text || '';
      const maps = (txt.match(/^\s*Sitemap:\s*(\S+)/gim) || []).map((l) => l.split(/:\s*/).slice(1).join(':').trim());
      const blocked = (txt.match(/^\s*Disallow:\s*(\S+)/gim) || []).map((l) => l.replace(/^\s*Disallow:\s*/i, '').trim());
      const dangerous = blocked.filter((b) => b === '/' );
      push('shopify', dangerous.length ? 'fail' : 'pass', 'robots.txt',
        `可访问 · ${maps.length} 条 Sitemap 声明 · ${blocked.length} 条 Disallow`
        + (maps.length ? '<br>' + maps.slice(0, 3).map((m) => esc(m)).join('<br>') : '')
        + (dangerous.length ? '<br><span class="ssi-bad">存在 Disallow: /（全站禁止抓取）</span>' : ''),
        5, dangerous.length ? '立即检查 robots.txt.liquid，Disallow: / 会让整站从搜索结果消失。' : '');
      const customized = /robots\.txt\.liquid/i.test(txt) || blocked.length > 30;
      if (customized) push('shopify', 'info', 'robots.txt 可能被自定义', `${blocked.length} 条 Disallow 规则`, 0, 'Shopify 支持通过 robots.txt.liquid 自定义，改动前请确认不会屏蔽 /collections/ 等重要路径。');
    } else {
      push('shopify', 'warn', 'robots.txt 不可访问', robots ? `HTTP ${robots.status}` : '请求失败', 4, '');
    }

    if (sitemap && sitemap.ok) {
      const subs = (sitemap.text.match(/<loc>([^<]+)<\/loc>/gi) || []).map((l) => l.replace(/<\/?loc>/gi, ''));
      push('shopify', 'pass', 'sitemap.xml', `可访问 · 包含 ${subs.length} 个子 Sitemap<br>`
        + subs.slice(0, 6).map((s) => esc(s.replace(origin, ''))).join('<br>'), 5,
        '在 Google Search Console 提交 /sitemap.xml，Shopify 会自动维护商品、集合、页面、博客四类子地图。');
    } else {
      push('shopify', 'warn', 'sitemap.xml 不可访问', sitemap ? `HTTP ${sitemap.status}` : '请求失败', 4, '');
    }

    // 商品 JSON：核对结构化数据与真实库存/价格
    if (sp.pageType === 'product') {
      const handle = (location.pathname.match(/\/products\/([^/?#]+)/) || [])[1];
      if (handle) {
        const r = await fetchText(`${origin}/products/${handle}.js`);
        if (r && r.ok) {
          try {
            const pj = JSON.parse(r.text);
            const avail = pj.available;
            const node = d.jsonld.find((n) => [].concat(n['@type'] || []).some((t) => /^Product$/i.test(t)));
            const offers = node ? [].concat(node.offers || [])[0] || {} : {};
            const schemaAvail = /InStock/i.test(String(offers.availability || ''));
            if (node && offers.availability != null && schemaAvail !== avail) {
              push('schema', 'fail', '结构化数据库存状态与实际不符',
                `Schema: ${esc(String(offers.availability).split('/').pop())} · 实际: ${avail ? 'InStock' : 'OutOfStock'}`, 5,
                '库存状态不一致会触发 Google Merchant / 富摘要告警，请让 schema 从商品对象动态输出。');
            }
            const realPrice = (pj.price / 100);
            if (node && offers.price && Math.abs(parseFloat(offers.price) - realPrice) > 0.011) {
              push('schema', 'fail', '结构化数据价格与实际不符', `Schema: ${esc(offers.price)} · 实际: ${realPrice.toFixed(2)}`, 5, '价格不一致是富摘要被拒的常见原因。');
            }
            const descWords = wordCount(String(pj.description || '').replace(/<[^>]+>/g, ' '));
            push('shopify', descWords >= 200 ? 'pass' : 'warn', `商品描述（后台原文）：${num(descWords)} 字`,
              `${pj.images ? pj.images.length : 0} 张媒体 · ${pj.variants ? pj.variants.length : 0} 个变体 · 标签 ${esc((pj.tags || []).slice(0, 6).join('、') || '无')}`, 4,
              descWords < 200 ? '在后台商品描述中补充结构化内容（材质 / 尺寸表 / 使用说明 / FAQ），并使用 H2/H3 分段。' : '');
            const noImgVariants = (pj.variants || []).filter((v) => !v.featured_image).length;
            if (pj.variants && pj.variants.length > 1 && noImgVariants === pj.variants.length) {
              push('shopify', 'info', '变体未关联图片', `${pj.variants.length} 个变体均无独立图片`, 2, '为颜色类变体关联图片，可提升转化并让 Google 购物正确展示。');
            }
          } catch (e) { /* noop */ }
        }
      }
    }

    // 首页：检查是否有 Organization / WebSite schema 与 sitelinks searchbox
    if (sp.pageType === 'home') {
      const org = d.jsonld.find((n) => [].concat(n['@type'] || []).some((t) => /Organization|Store|LocalBusiness/i.test(t)));
      if (org) {
        const miss = ['name', 'url', 'logo'].filter((k) => !org[k]);
        if (miss.length) push('schema', 'warn', 'Organization 字段缺失', miss.join(', '), 3, '补充 name / url / logo / sameAs（社交主页），有助于品牌知识面板。');
        if (!org.sameAs) push('schema', 'info', 'Organization 缺少 sameAs', '未声明社交媒体主页', 2, '添加 sameAs: [Facebook, Instagram, X, YouTube…] 建立实体关联。');
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 5. UI
   * ------------------------------------------------------------------ */

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.fab {
  position: fixed; z-index: 2147483646; right: 20px; bottom: 20px; width: 52px; height: 52px;
  border-radius: 50%; background: linear-gradient(135deg,#5b8def,#3b5bdb); color:#fff; border: none;
  box-shadow: 0 6px 20px rgba(0,0,0,.28); cursor: pointer; font-size: 22px; line-height: 52px; text-align:center;
  transition: transform .15s ease, box-shadow .15s ease; user-select:none;
}
.fab:hover { transform: scale(1.08); box-shadow: 0 10px 28px rgba(0,0,0,.35); }
.fab .badge {
  position:absolute; top:-4px; right:-4px; min-width:22px; height:22px; border-radius:11px; background:#fff;
  color:#1f2937; font-size:11px; font-weight:700; line-height:22px; padding:0 5px; box-shadow:0 2px 6px rgba(0,0,0,.2);
}
.badge.s-good { background:#16a34a; color:#fff; } .badge.s-mid { background:#f59e0b; color:#fff; } .badge.s-bad { background:#dc2626; color:#fff; }

.panel {
  position: fixed; z-index: 2147483647; right: 20px; bottom: 84px; width: 440px; max-width: calc(100vw - 24px);
  height: 74vh; max-height: 820px; background: #fff; color:#111827; border-radius: 14px; overflow: hidden;
  box-shadow: 0 20px 60px rgba(0,0,0,.32); display: flex; flex-direction: column; border: 1px solid rgba(0,0,0,.08);
}
.panel[hidden] { display: none !important; }
.hd { display:flex; align-items:center; gap:10px; padding:12px 14px; background:linear-gradient(135deg,#3b5bdb,#5b8def); color:#fff; cursor:move; }
.hd h1 { font-size:14px; font-weight:600; flex:1; display:flex; align-items:center; gap:6px; }
.hd button { background:rgba(255,255,255,.16); border:none; color:#fff; width:26px; height:26px; border-radius:7px; cursor:pointer; font-size:13px; }
.hd button:hover { background:rgba(255,255,255,.3); }

.summary { display:flex; gap:14px; padding:14px; border-bottom:1px solid #eef0f4; align-items:center; }
.ring { position:relative; width:72px; height:72px; flex:none; }
.ring svg { transform: rotate(-90deg); }
.ring .val { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
.ring .val b { font-size:20px; line-height:1; } .ring .val span { font-size:10px; color:#6b7280; margin-top:2px; }
.stats { flex:1; display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
.stat { border-radius:8px; padding:6px 8px; text-align:center; background:#f7f8fa; }
.stat b { display:block; font-size:16px; } .stat span { font-size:10px; color:#6b7280; }
.stat.f b { color:#dc2626; } .stat.w b { color:#d97706; } .stat.p b { color:#16a34a; }
.meta { padding:0 14px 10px; font-size:11px; color:#6b7280; display:flex; gap:8px; flex-wrap:wrap; }
.meta em { font-style:normal; background:#eef2ff; color:#3b5bdb; padding:1px 6px; border-radius:4px; }

.tabs { display:flex; gap:2px; padding:8px 10px 0; border-bottom:1px solid #eef0f4; overflow-x:auto; scrollbar-width:none; }
.tabs::-webkit-scrollbar { display:none; }
.tab { border:none; background:none; padding:7px 9px; font-size:12px; color:#6b7280; cursor:pointer; border-bottom:2px solid transparent; white-space:nowrap; border-radius:6px 6px 0 0; }
.tab:hover { background:#f4f6f9; color:#111827; }
.tab.on { color:#3b5bdb; border-bottom-color:#3b5bdb; font-weight:600; }
.tab .n { display:inline-block; min-width:15px; height:15px; line-height:15px; font-size:9px; border-radius:8px; background:#e5e7eb; color:#374151; padding:0 4px; margin-left:3px; }
.tab .n.bad { background:#fee2e2; color:#dc2626; } .tab .n.warn { background:#fef3c7; color:#b45309; }

.body { flex:1; overflow-y:auto; padding:8px 10px 16px; }
.body::-webkit-scrollbar { width:8px; } .body::-webkit-scrollbar-thumb { background:#d5d9e0; border-radius:4px; }
.item { border:1px solid #eef0f4; border-radius:9px; margin:6px 0; overflow:hidden; background:#fff; }
.item > .top { display:flex; gap:8px; padding:9px 10px; cursor:pointer; align-items:flex-start; }
.item > .top:hover { background:#fafbfc; }
.ic { flex:none; width:17px; height:17px; border-radius:50%; font-size:10px; line-height:17px; text-align:center; color:#fff; font-weight:700; margin-top:1px; }
.ic.pass { background:#16a34a; } .ic.warn { background:#f59e0b; } .ic.fail { background:#dc2626; } .ic.info { background:#6b7280; }
.item .t { flex:1; font-size:12.5px; font-weight:600; line-height:1.5; }
.item .d { font-size:11.5px; color:#4b5563; font-weight:400; margin-top:3px; line-height:1.65; word-break:break-word; }
.item .d code { background:#f3f4f6; padding:1px 4px; border-radius:3px; font-family: ui-monospace, Menlo, monospace; font-size:10.5px; }
.item .fix { display:none; padding:9px 10px 10px 35px; background:#f8fafc; border-top:1px solid #eef0f4; font-size:11.5px; color:#334155; line-height:1.7; }
.item.open .fix { display:block; }
.item .fix::before { content:"💡 建议："; font-weight:600; color:#3b5bdb; }
.item .arrow { flex:none; color:#9ca3af; font-size:10px; margin-top:3px; }
.ssi-tag { display:inline-block; background:#eef2ff; color:#3b5bdb; padding:1px 6px; border-radius:4px; font-size:10.5px; margin:1px 2px 1px 0; }
.ssi-muted { color:#9ca3af; } .ssi-bad { color:#dc2626; font-weight:600; }
.sec { font-size:11px; color:#9ca3af; font-weight:600; margin:12px 2px 4px; letter-spacing:.4px; }

.ft { display:flex; gap:6px; padding:9px 10px; border-top:1px solid #eef0f4; background:#fafbfc; }
.ft button { flex:1; border:1px solid #e5e7eb; background:#fff; border-radius:7px; padding:7px 6px; font-size:11.5px; cursor:pointer; color:#374151; }
.ft button:hover { background:#f3f4f6; border-color:#d1d5db; }
.ft button.pri { background:#3b5bdb; color:#fff; border-color:#3b5bdb; } .ft button.pri:hover { background:#3550c4; }

.tools a { display:flex; align-items:center; gap:8px; padding:9px 10px; border:1px solid #eef0f4; border-radius:9px; margin:5px 0; text-decoration:none; color:#111827; font-size:12.5px; }
.tools a:hover { background:#f8fafc; border-color:#d5d9e0; }
.tools a span { margin-left:auto; color:#9ca3af; font-size:11px; }
.kv { font-size:11.5px; line-height:1.8; word-break:break-all; }
.kv b { color:#6b7280; font-weight:600; display:inline-block; min-width:92px; }
.toast { position:fixed; z-index:2147483647; bottom:26px; left:50%; transform:translateX(-50%); background:#111827; color:#fff; padding:9px 16px; border-radius:8px; font-size:12.5px; box-shadow:0 8px 24px rgba(0,0,0,.3); }

@media (prefers-color-scheme: dark) {
  .panel { background:#161a23; color:#e5e7eb; border-color:#2a3040; }
  .summary, .tabs, .item, .ft { border-color:#252b38; }
  .stat { background:#1e2430; } .item { background:#1a1f2b; border-color:#252b38; }
  .item > .top:hover { background:#20263280; } .item .fix { background:#141922; border-color:#252b38; color:#cbd5e1; }
  .item .d { color:#9ca3af; } .item .d code { background:#252b38; }
  .ft { background:#12161e; } .ft button { background:#1e2430; border-color:#2a3040; color:#cbd5e1; }
  .ft button:hover { background:#252b38; } .ft button.pri { background:#3b5bdb; color:#fff; }
  .tab:hover { background:#1e2430; color:#e5e7eb; } .tab .n { background:#2a3040; color:#cbd5e1; }
  .tools a { background:#1a1f2b; border-color:#252b38; color:#e5e7eb; } .tools a:hover { background:#20263d; }
  .ssi-tag { background:#1e2a4a; color:#93b4ff; }
}
`;

  const ICONS = { pass: '✓', warn: '!', fail: '×', info: 'i' };
  const LEVEL_NAME = { pass: '通过', warn: '警告', fail: '问题', info: '信息' };

  const state = { data: null, sp: null, results: [], tab: 'overview', scanning: false, full: false };
  let shadow, panel, fab;

  function build() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    (document.body || document.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    fab = document.createElement('button');
    fab.className = 'fab';
    fab.title = 'Shopify SEO 检查器 (Alt+S)';
    fab.innerHTML = '🔍';
    fab.addEventListener('click', toggle);
    shadow.appendChild(fab);

    panel = document.createElement('div');
    panel.className = 'panel';
    panel.hidden = true;
    shadow.appendChild(panel);

    const pos = GM.get('fabPos', null);
    if (pos && pos.right != null) { fab.style.right = pos.right + 'px'; fab.style.bottom = pos.bottom + 'px'; }
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    shadow.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  function toggle() {
    if (panel.hidden) { panel.hidden = false; if (!state.full) scan(); else render(); }
    else panel.hidden = true;
  }

  function counts(list) {
    return {
      fail: list.filter((r) => r.level === 'fail').length,
      warn: list.filter((r) => r.level === 'warn').length,
      pass: list.filter((r) => r.level === 'pass').length,
      info: list.filter((r) => r.level === 'info').length
    };
  }

  function render() {
    const R = state.results, sp = state.sp || {}, d = state.data || {};
    const c = counts(R);
    const score = scoreOf(R);
    const color = score >= 80 ? '#16a34a' : score >= 60 ? '#f59e0b' : '#dc2626';
    const dash = 2 * Math.PI * 30;

    fab.innerHTML = `🔍<span class="badge ${score >= 80 ? 's-good' : score >= 60 ? 's-mid' : 's-bad'}">${score}</span>`;

    const tabs = [{ id: 'overview', name: '总览', icon: '📊' }]
      .concat(CATS.map((k) => Object.assign({}, k, { n: counts(R.filter((r) => r.cat === k.id)) })))
      .concat([{ id: 'tools', name: '工具', icon: '🧰' }]);

    panel.innerHTML = `
      <div class="hd">
        <h1>🔍 Shopify SEO 检查器</h1>
        <button data-act="rescan" title="重新检测">↻</button>
        <button data-act="close" title="关闭">✕</button>
      </div>
      <div class="summary">
        <div class="ring">
          <svg width="72" height="72">
            <circle cx="36" cy="36" r="30" fill="none" stroke="#e5e7eb" stroke-width="7"></circle>
            <circle cx="36" cy="36" r="30" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"
              stroke-dasharray="${dash}" stroke-dashoffset="${dash * (1 - score / 100)}"></circle>
          </svg>
          <div class="val"><b style="color:${color}">${score}</b><span>SEO 得分</span></div>
        </div>
        <div class="stats">
          <div class="stat f"><b>${c.fail}</b><span>严重问题</span></div>
          <div class="stat w"><b>${c.warn}</b><span>待优化</span></div>
          <div class="stat p"><b>${c.pass}</b><span>已通过</span></div>
        </div>
      </div>
      <div class="meta">
        <em>${esc(sp.pageType || '-')}</em>
        ${sp.shop ? `<em>${esc(sp.shop)}</em>` : ''}
        ${sp.theme ? `<em>主题 ${esc(sp.theme.name || sp.theme.id)}</em>` : ''}
        ${d.words != null ? `<em>${num(d.words)} 字</em>` : ''}
        ${state.scanning ? '<em>检测中…</em>' : ''}
      </div>
      <div class="tabs">
        ${tabs.map((t) => {
          const n = t.n ? (t.n.fail ? `<i class="n bad">${t.n.fail}</i>` : t.n.warn ? `<i class="n warn">${t.n.warn}</i>` : `<i class="n">${t.n.pass}</i>`) : '';
          return `<button class="tab ${state.tab === t.id ? 'on' : ''}" data-tab="${t.id}">${t.icon} ${esc(t.name)}${n}</button>`;
        }).join('')}
      </div>
      <div class="body">${renderBody()}</div>
      <div class="ft">
        <button data-act="copy-md" class="pri">📋 复制报告</button>
        <button data-act="copy-json">{ } JSON</button>
        <button data-act="highlight">🎯 标记问题图片</button>
      </div>`;

    panel.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
    panel.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act)));
    panel.querySelectorAll('.item').forEach((it) => {
      const top = it.querySelector('.top');
      if (it.querySelector('.fix')) top.addEventListener('click', () => it.classList.toggle('open'));
    });
    dragify(panel.querySelector('.hd'));
  }

  function renderItem(r) {
    return `<div class="item">
      <div class="top">
        <i class="ic ${r.level}">${ICONS[r.level]}</i>
        <div class="t">${esc(r.title)}${r.detail ? `<div class="d">${r.detail}</div>` : ''}</div>
        ${r.fix ? '<i class="arrow">▾</i>' : ''}
      </div>
      ${r.fix ? `<div class="fix">${esc(r.fix)}</div>` : ''}
    </div>`;
  }

  function renderBody() {
    const R = state.results, d = state.data || {}, sp = state.sp || {};
    if (state.scanning && !R.length) return '<div style="padding:30px;text-align:center;color:#9ca3af">正在检测…</div>';

    if (state.tab === 'overview') {
      const order = { fail: 0, warn: 1, pass: 2, info: 3 };
      const issues = R.filter((r) => r.level === 'fail' || r.level === 'warn')
        .sort((a, b) => (order[a.level] - order[b.level]) || (b.weight - a.weight));
      if (!issues.length) return '<div style="padding:30px;text-align:center;color:#16a34a">🎉 没有发现明显问题</div>';
      const catName = (id) => (CATS.find((c) => c.id === id) || {}).name || id;
      return `<div class="sec">按优先级排序的待办（${issues.length}）</div>`
        + issues.map((r) => renderItem(Object.assign({}, r, { title: `[${catName(r.cat)}] ${r.title}` }))).join('');
    }

    if (state.tab === 'tools') {
      const u = encodeURIComponent(location.href);
      const host = location.hostname;
      const links = [
        ['🔎', 'Google 富媒体结果测试', `https://search.google.com/test/rich-results?url=${u}`],
        ['📐', 'Schema.org 验证器', `https://validator.schema.org/#url=${u}`],
        ['⚡', 'PageSpeed Insights', `https://pagespeed.web.dev/analysis?url=${u}`],
        ['🧪', 'Google 收录查询 site:', `https://www.google.com/search?q=site%3A${host}`],
        ['📄', '查看当前页 Google 快照', `https://www.google.com/search?q=${u}`],
        ['🤖', 'robots.txt', `${location.origin}/robots.txt`],
        ['🗺️', 'sitemap.xml', `${location.origin}/sitemap.xml`],
        ['📦', '当前商品 JSON', sp.pageType === 'product' ? location.pathname.split('?')[0].replace(/\/$/, '') + '.js' : `${location.origin}/products.json?limit=5`],
        ['🗂️', '集合 JSON', `${location.origin}/collections.json?limit=50`],
        ['🔗', 'Facebook 分享调试', `https://developers.facebook.com/tools/debug/?q=${u}`],
        ['🧭', 'Search Console', `https://search.google.com/search-console?resource_id=sc-domain%3A${host.replace(/^www\./, '')}`]
      ];
      const og = Object.keys(d.og || {}).map((k) => `<b>og:${esc(k)}</b> ${esc(trunc(d.og[k], 100))}`).join('<br>');
      return `<div class="sec">外部工具</div><div class="tools">`
        + links.map(([i, n, h]) => `<a href="${esc(h)}" target="_blank" rel="noopener">${i} ${esc(n)}<span>↗</span></a>`).join('')
        + `</div><div class="sec">页面原始数据</div><div class="item"><div class="top"><div class="t"><div class="d kv">`
        + `<b>URL</b> ${esc(d.url || '')}<br><b>Title</b> ${esc(d.title || '-')}<br><b>Description</b> ${esc(d.desc || '-')}<br>`
        + `<b>Canonical</b> ${esc(d.canonicalAbs || '-')}<br><b>Robots</b> ${esc(d.robots || '默认')}<br><b>Lang</b> ${esc(d.lang || '-')}<br>`
        + `<b>Schema</b> ${esc(Array.from(new Set(d.schemaTypes || [])).join(', ') || '-')}<br>`
        + `<b>Hreflang</b> ${esc((d.hreflang || []).map((h) => h.lang).join(', ') || '-')}<br>`
        + (og ? `<br>${og}` : '')
        + `</div></div></div></div>`;
    }

    const list = R.filter((r) => r.cat === state.tab);
    if (!list.length) return '<div style="padding:30px;text-align:center;color:#9ca3af">暂无检查项</div>';
    const order = { fail: 0, warn: 1, pass: 2, info: 3 };
    return list.slice().sort((a, b) => (order[a.level] - order[b.level]) || (b.weight - a.weight)).map(renderItem).join('');
  }

  /* ---------------- 交互动作 ---------------- */

  function act(name) {
    if (name === 'close') { panel.hidden = true; return; }
    if (name === 'rescan') { scan(); return; }
    if (name === 'copy-md') { GM.clip(toMarkdown()); toast('报告已复制到剪贴板'); return; }
    if (name === 'copy-json') { GM.clip(JSON.stringify(toJSON(), null, 2)); toast('JSON 已复制到剪贴板'); return; }
    if (name === 'highlight') { highlightImages(); return; }
  }

  let marks = [];
  function highlightImages() {
    if (marks.length) { marks.forEach((m) => m.remove()); marks = []; toast('已清除标记'); return; }
    const bad = $$('img').filter((i) => !i.hasAttribute('alt') || !String(i.getAttribute('alt')).trim());
    if (!bad.length) { toast('没有缺失 ALT 的图片'); return; }
    bad.forEach((img) => {
      const r = img.getBoundingClientRect();
      if (r.width < 10) return;
      const m = document.createElement('div');
      m.style.cssText = `position:absolute;z-index:2147483640;pointer-events:none;border:2px solid #dc2626;background:rgba(220,38,38,.12);
        left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;height:${r.height}px;`;
      m.innerHTML = '<span style="position:absolute;top:0;left:0;background:#dc2626;color:#fff;font:11px/1.6 sans-serif;padding:0 5px">缺少 ALT</span>';
      document.body.appendChild(m);
      marks.push(m);
    });
    toast(`已标记 ${marks.length} 张图片（再次点击清除）`);
    if (bad[0]) bad[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function toJSON() {
    const d = state.data || {}, sp = state.sp || {};
    return {
      url: location.href, scannedAt: new Date().toISOString(), score: scoreOf(state.results),
      shop: sp.shop, pageType: sp.pageType, theme: sp.theme, apps: sp.apps,
      title: d.title, titleLength: (d.title || '').length, description: d.desc, descriptionLength: (d.desc || '').length,
      canonical: d.canonicalAbs, robots: d.robots, lang: d.lang, words: d.words,
      h1: (d.h1 || []).map((h) => h.text), schemaTypes: Array.from(new Set(d.schemaTypes || [])),
      hreflang: d.hreflang, openGraph: d.og, twitter: d.tw,
      images: { total: (d.images || []).length, missingAlt: (d.images || []).filter((i) => !i.hasAlt).length },
      links: { total: (d.links || []).length, internal: (d.links || []).filter((l) => l.internal).length },
      performance: { lcp: d.perf?.lcp, cls: d.perf?.cls, ttfb: d.perf?.ttfb, load: d.perf?.load, requests: d.perf?.reqs, bytes: d.perf?.total },
      results: state.results.map((r) => ({ category: r.cat, level: r.level, title: r.title, weight: r.weight, fix: r.fix }))
    };
  }

  function toMarkdown() {
    const R = state.results, sp = state.sp || {}, d = state.data || {};
    const c = counts(R);
    const strip = (h) => String(h).replace(/<br\s*\/?>/gi, ' / ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    let md = `# Shopify SEO 检查报告\n\n`;
    md += `- **页面**：${location.href}\n- **店铺**：${sp.shop || location.hostname}\n- **页面类型**：${sp.pageType || '-'}\n`;
    md += `- **主题**：${sp.theme ? (sp.theme.name || sp.theme.id) : '-'}\n- **检测时间**：${new Date().toLocaleString('zh-CN')}\n`;
    md += `- **得分**：**${scoreOf(R)}/100**（问题 ${c.fail} · 待优化 ${c.warn} · 通过 ${c.pass}）\n\n`;
    const order = { fail: 0, warn: 1, pass: 2, info: 3 };
    CATS.forEach((cat) => {
      const list = R.filter((r) => r.cat === cat.id).sort((a, b) => order[a.level] - order[b.level] || b.weight - a.weight);
      if (!list.length) return;
      md += `## ${cat.icon} ${cat.name}\n\n`;
      list.forEach((r) => {
        md += `- ${{ pass: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' }[r.level]} **${r.title}**`;
        if (r.detail) md += ` — ${strip(r.detail)}`;
        md += '\n';
        if (r.fix && r.level !== 'pass') md += `  - 💡 ${r.fix}\n`;
      });
      md += '\n';
    });
    md += `---\n由 Shopify SEO 检查器（Tampermonkey 脚本）生成。\n`;
    return md;
  }

  /* ---------------- 拖拽 ---------------- */

  function dragify(handle) {
    if (!handle || handle.__drag) return;
    handle.__drag = true;
    let sx, sy, sr, sb, on = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      sr = innerWidth - r.right; sb = innerHeight - r.bottom;
      e.preventDefault();
    });
    const move = (e) => {
      if (!on) return;
      panel.style.right = Math.max(4, sr - (e.clientX - sx)) + 'px';
      panel.style.bottom = Math.max(4, sb - (e.clientY - sy)) + 'px';
    };
    const up = () => { on = false; };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /* ------------------------------------------------------------------ *
   * 6. 主流程
   * ------------------------------------------------------------------ */

  async function scan() {
    state.scanning = true;
    state.full = false;
    state.results = [];
    render();
    try {
      const sp = detectShopify();
      const d = collect();
      state.sp = sp; state.data = d;
      state.results = runChecks(d, sp);
      render();
      await asyncChecks(d, sp, (cat, level, title, detail, weight, fix) => {
        state.results.push({ cat, level, title, detail: detail || '', weight: weight == null ? 3 : weight, fix: fix || '' });
      });
    } catch (e) {
      console.error('[Shopify SEO Inspector]', e);
      state.results.push({ cat: 'basic', level: 'fail', title: '检测过程出错', detail: esc(e.message), weight: 0, fix: '请在控制台查看详细堆栈并反馈。' });
    }
    state.scanning = false;
    state.full = true;
    render();
  }

  function init() {
    const sp = detectShopify();
    const always = GM.get('alwaysShow', false);
    if (!sp.isShopify && !always) return;

    build();
    render();

    if (GM.get('autoOpen', false)) { panel.hidden = false; scan(); }
    else {
      // 后台静默评分，便于在按钮上直接看到分数
      setTimeout(() => {
        try {
          const d = collect();
          state.sp = sp; state.data = d; state.results = runChecks(d, sp);
          render();
        } catch (e) { /* noop */ }
      }, 1200);
    }

    document.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); toggle(); }
    });

    GM.menu('打开 / 关闭面板', toggle);
    GM.menu('重新检测', () => { panel.hidden = false; scan(); });
    GM.menu('复制 Markdown 报告', () => { if (!state.results.length) scan().then(() => { GM.clip(toMarkdown()); toast('已复制'); }); else { GM.clip(toMarkdown()); toast('已复制'); } });
    GM.menu(`${GM.get('autoOpen', false) ? '关闭' : '开启'}自动打开面板`, () => { GM.set('autoOpen', !GM.get('autoOpen', false)); location.reload(); });
    GM.menu(`${GM.get('alwaysShow', false) ? '仅在' : '在所有'} Shopify 站点显示`, () => { GM.set('alwaysShow', !GM.get('alwaysShow', false)); location.reload(); });
  }

  // 非 Shopify 站点也提供菜单入口，便于强制开启
  if (!detectShopify().isShopify && !GM.get('alwaysShow', false)) {
    GM.menu('在本站强制启用 SEO 检查器', () => { GM.set('alwaysShow', true); location.reload(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
