'use strict';

window.CandleChart = (function () {

  /* ── Theme ───────────────────────────────────────────────────── */
  var BG      = '#0A0714';
  var BULL    = '#00FF7F';
  var BEAR    = '#FF2A6D';
  var GRID    = '#1A1535';
  var TEXT    = '#8B88A0';
  var CROSS   = '#00FFF0';
  var DASH    = '#F0C040';
  var BORDER  = '#2C2250';
  var RM = 80, TM = 20, BM = 28, LM = 4;

  /* ── Brand watermark: faint EURO TRADER logo behind the chart ──── */
  var LOGO = new Image();
  var LOGO_OK = false;
  LOGO.onload = function () { LOGO_OK = true; };
  try { LOGO.src = 'logo.jpg'; } catch (_) {}

  function drawWatermark(ctx, W, H) {
    if (!LOGO_OK || !LOGO.width) return;
    var lw = Math.min(W, H) * 0.55;
    var lh = lw * (LOGO.height / LOGO.width);
    ctx.save();
    ctx.globalAlpha = 0.05;            /* faint / semi-transparent */
    ctx.drawImage(LOGO, (W - lw) / 2, (H - lh) / 2, lw, lh);
    ctx.restore();
  }

  /* ── Proxy base URL ─────────────────────────────────────────── */
  var PROXY = 'https://euro-trade-proxy-1.onrender.com';

  /* ── OTC data flows through the proxy server (no direct Supabase calls). ── */

  /* fetch with a hard timeout. A plain fetch() against a cold-starting / sleeping
     Render instance can hang indefinitely — which used to leave the OTC status
     poll's request-lock stuck `true` forever, silently killing the live price
     loop (chart shows candles + a ticking countdown, but the price is frozen).
     Aborting after `ms` guarantees the promise settles so .finally() always runs. */
  function fetchT(url, ms) {
    ms = ms || 12000;
    if (typeof AbortController === 'undefined') return fetch(url);
    var ac = new AbortController();
    var timer = setTimeout(function () { try { ac.abort(); } catch (_) {} }, ms);
    return fetch(url, { signal: ac.signal })
      .finally(function () { clearTimeout(timer); });
  }

  /* ── Sliding window: max candles kept in memory ─────────────── */
  var MAX_CANDLES = 100;

  /* ── Asset profiles (realistic base prices + volatility) ────── */
  var ASSETS = {
    /* Forex */
    'EUR/USD':       { p: 1.08520, s: 0.00015, d: 5 },
    'GBP/USD':       { p: 1.27340, s: 0.00022, d: 5 },
    'USD/JPY':       { p: 149.500, s: 0.025,   d: 3 },
    'AUD/USD':       { p: 0.65800, s: 0.00012, d: 5 },
    'USD/CAD':       { p: 1.36500, s: 0.00015, d: 5 },
    'USD/CHF':       { p: 0.90500, s: 0.00012, d: 5 },
    'EUR/GBP':       { p: 0.85200, s: 0.00010, d: 5 },
    'EUR/JPY':       { p: 162.500, s: 0.028,   d: 3 },
    'GBP/JPY':       { p: 190.800, s: 0.035,   d: 3 },
    'NZD/USD':       { p: 0.61000, s: 0.00011, d: 5 },
    /* Metals */
    'XAU/USD':       { p: 2348.50, s: 0.38,    d: 2 },
    'XAG/USD':       { p: 28.4500, s: 0.009,   d: 3 },
    /* Commodities */
    'WTICO/USD':     { p: 78.500,  s: 0.015,   d: 2 },
    'BRENT/USD':     { p: 82.300,  s: 0.015,   d: 2 },
    'NATGAS/USD':    { p: 2.4500,  s: 0.0008,  d: 3 },
    /* Metals extended */
    'XAU/EUR':       { p: 2165.00, s: 0.35,    d: 2 },
    'XAG/EUR':       { p: 26.200,  s: 0.008,   d: 3 },
    'XPD/USD':       { p: 1000.00, s: 5.0,     d: 2 },
    'XPT/USD':       { p: 950.000, s: 4.0,     d: 2 },
    /* Forex extended */
    'EUR/CAD':       { p: 1.47500, s: 0.00018, d: 5 },
    'EUR/CHF':       { p: 0.97500, s: 0.00012, d: 5 },
    'EUR/AUD':       { p: 1.65000, s: 0.00022, d: 5 },
    'EUR/NZD':       { p: 1.78500, s: 0.00022, d: 5 },
    'EUR/RUB':       { p: 98.000,  s: 0.10,    d: 3 },
    'EUR/HUF':       { p: 390.00,  s: 0.10,    d: 2 },
    'EUR/TRY':       { p: 36.500,  s: 0.05,    d: 3 },
    'GBP/AUD':       { p: 1.93500, s: 0.00028, d: 5 },
    'GBP/CHF':       { p: 1.15000, s: 0.00018, d: 5 },
    'GBP/CAD':       { p: 1.72000, s: 0.00022, d: 5 },
    'AUD/CAD':       { p: 0.90500, s: 0.00013, d: 5 },
    'AUD/CHF':       { p: 0.59500, s: 0.00011, d: 5 },
    'AUD/JPY':       { p: 98.200,  s: 0.018,   d: 3 },
    'AUD/NZD':       { p: 1.07500, s: 0.00014, d: 5 },
    'CAD/JPY':       { p: 109.50,  s: 0.020,   d: 3 },
    'CAD/CHF':       { p: 0.66300, s: 0.00010, d: 5 },
    'CHF/JPY':       { p: 165.50,  s: 0.028,   d: 3 },
    'CHF/NOK':       { p: 11.500,  s: 0.005,   d: 3 },
    'NZD/JPY':       { p: 91.000,  s: 0.016,   d: 3 },
    'USD/SGD':       { p: 1.34000, s: 0.00013, d: 5 },
    'USD/PHP':       { p: 57.500,  s: 0.008,   d: 3 },
    'USD/RUB':       { p: 88.000,  s: 0.08,    d: 3 },
    'USD/INR':       { p: 83.500,  s: 0.008,   d: 3 },
    'USD/MXN':       { p: 17.200,  s: 0.003,   d: 3 },
    'USD/CNH':       { p: 7.23500, s: 0.00080, d: 5 },
    'USD/BRL':       { p: 4.9500,  s: 0.0008,  d: 4 },
    'USD/ZAR':       { p: 18.600,  s: 0.010,   d: 3 },
    /* Crypto */
    'BTCUSD':        { p: 65000,   s: 200,     d: 0 },
    'BTCGBP':        { p: 51000,   s: 180,     d: 0 },
    'BTCJPY':        { p: 9750000, s: 30000,   d: 0 },
    'ETHUSDT':       { p: 3500.0,  s: 15.0,    d: 2 },
    'ADAUSDT':       { p: 0.4500,  s: 0.003,   d: 4 },
    'DOGEUSDT':      { p: 0.1500,  s: 0.001,   d: 4 },
    'DOTUSDT':       { p: 7.5000,  s: 0.06,    d: 3 },
    'SOLUSDT':       { p: 170.00,  s: 1.5,     d: 2 },
    'AVAXUSDT':      { p: 35.000,  s: 0.30,    d: 2 },
    'TRXUSDT':       { p: 0.1200,  s: 0.0008,  d: 4 },
    'BNBUSDT':       { p: 580.00,  s: 3.0,     d: 2 },
    'LINKUSDT':      { p: 14.000,  s: 0.10,    d: 3 },
    'MATICUSDT':     { p: 0.8500,  s: 0.006,   d: 4 },
    'LTCUSDT':       { p: 85.000,  s: 0.50,    d: 2 },
    'TONUSDT':       { p: 6.0000,  s: 0.050,   d: 3 },
    'DASHUSDT':      { p: 32.000,  s: 0.20,    d: 2 },
    'BCHUSDT':       { p: 450.00,  s: 3.0,     d: 2 },
    'BCHEUR':        { p: 415.00,  s: 3.0,     d: 2 },
    'BCHGBP':        { p: 355.00,  s: 2.5,     d: 2 },
  };

  function asset(sym) {
    var k = sym.replace(/^[A-Z]+:/, '').replace(/_/g, '/');
    return ASSETS[k] || ASSETS['EUR/USD'];
  }

  /* ── Helpers ─────────────────────────────────────────────────── */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function candleSec(iv) {
    switch (iv) { case '5m': return 300; case '15m': return 900;
      case '1h': return 3600; case '1D': return 86400; default: return 60; }
  }

  function decimals(sym) { return asset(sym).d; }

  /* Auto-detect decimal places from actual price magnitude — never truncate */
  function autoDec(price) {
    var abs = Math.abs(price);
    if (!isFinite(abs) || abs === 0) return 5;
    if (abs >= 10000) return 0;   // BTC, indices
    if (abs >= 1000)  return 2;   // Gold, Palladium
    if (abs >= 100)   return 2;   // Oil, JPY crosses, EGP
    if (abs >= 10)    return 3;   // USD/JPY, CAD/JPY
    if (abs >= 1)     return 5;   // EUR/USD, GBP/USD, major forex
    return 6;                      // sub-dollar pairs
  }

  /* Candle frames are built on UTC epoch boundaries server-side (data identical
     everywhere), but LABELS render in the device's LOCAL time so the newest
     candle reads the SAME as the phone clock and the broker platform — e.g. a
     live candle at 19:21 UTC shows 22:21 for a UTC+3 (Egypt) user, matching the
     wall clock instead of looking 3 hours behind. */
  function fmtShort(t, iv) {
    var d = new Date(t * 1000);
    if (iv === '1D') return (d.getMonth()+1)+'/'+pad2(d.getDate());
    return pad2(d.getHours())+':'+pad2(d.getMinutes());
  }
  function fmtFull(t, iv) {
    var d = new Date(t * 1000);
    if (iv === '1D') return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
    return pad2(d.getMonth()+1)+'/'+pad2(d.getDate())+' '+pad2(d.getHours())+':'+pad2(d.getMinutes());
  }

  function showLabel(t, iv) {
    var d = new Date(t * 1000);
    switch(iv) {
      case '1m':  return d.getMinutes() % 30 === 0;
      case '5m':  return d.getMinutes() === 0;
      case '15m': return d.getHours() % 4 === 0 && d.getMinutes() === 0;
      case '1h':  return d.getMinutes() === 0;
      case '1D':  return d.getDay() === 1;
      default:    return d.getMinutes() % 30 === 0;
    }
  }

  function niceTicks(lo, hi, n) {
    var r = hi - lo || 1;
    var raw = r / n;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = Math.ceil(raw / mag) * mag;
    var first = Math.ceil(lo / step) * step;
    var ticks = [];
    for (var v = first; v <= hi + 1e-10; v = +(v + step).toFixed(10)) ticks.push(v);
    return ticks;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ── Normal random number (Box-Muller) ───────────────────────── */
  function randn() {
    var u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* How many initial sim candles to show per interval (time-window ~1-2 hours) */
  function simCandleCount(iv) {
    switch(iv) {
      case '5m':  return 48;   // 4 hours
      case '15m': return 24;   // 6 hours
      case '1h':  return 24;   // 24 hours
      case '1D':  return 30;   // 30 days
      default:    return 60;   // 1m: 1 hour
    }
  }

  /* ── Generate realistic history ──────────────────────────────── */
  function buildHistory(sym, iv, count) {
    var a     = asset(sym);
    var cs    = candleSec(iv);
    count = count || MAX_CANDLES;
    var sigma = a.s * Math.sqrt(cs / 60);  // scale volatility by candle size
    var now   = Math.floor(Date.now() / 1000);
    var t0    = Math.floor(now / cs) * cs - count * cs;

    var price = a.p * (1 + (Math.random() - 0.5) * 0.004);
    var trend = 0;
    var candles = [];

    for (var i = 0; i < count; i++) {
      var open  = price;

      /* Occasional trend shifts */
      if (Math.random() < 0.04) trend = (Math.random() - 0.5) * sigma * 0.6;
      trend *= 0.95; // decay

      /* Candle body */
      var move  = trend + sigma * randn();
      var close = open + move;

      /* Gentle mean reversion keeps price near base */
      close += (a.p - close) * 0.003;

      /* Wicks */
      var hi = Math.max(open, close) + Math.abs(sigma * Math.random() * 0.8);
      var lo = Math.min(open, close) - Math.abs(sigma * Math.random() * 0.8);

      candles.push({ t: t0 + i * cs, o: open, h: hi, l: lo, c: close });
      price = close;
    }

    return candles;
  }

  /* ── Candle integrity validator ──────────────────────────────── */
  /* A candle is only usable if it carries a numeric timestamp and finite
     OHLC values. Guards against half-written candles from a server that
     restarted mid-write, or malformed live ticks. */
  function validCandle(b) {
    return b && isFinite(b.t) && isFinite(b.o) && isFinite(b.h) && isFinite(b.l) && isFinite(b.c);
  }

  /* Clean, sort, and deduplicate candles chronologically */
  function cleanAndSortCandles(arr) {
    if (!Array.isArray(arr) || !arr.length) return [];
    // Reject candles stamped in the future (bad feed / clock skew) — a future
    // candle otherwise becomes a permanent `last` that blocks all live updates.
    var futureCut = Math.floor(Date.now() / 1000) + 120;
    var valid = [];
    for (var i = 0; i < arr.length; i++) {
      if (validCandle(arr[i]) && arr[i].t <= futureCut) valid.push(arr[i]);
    }
    valid.sort(function (a, b) { return a.t - b.t; });
    var unique = [];
    for (var j = 0; j < valid.length; j++) {
      if (unique.length === 0 || unique[unique.length - 1].t !== valid[j].t) {
        unique.push(valid[j]);
      } else {
        unique[unique.length - 1] = valid[j];
      }
    }
    /* Keep only the most recent CONTIGUOUS run. If the series has a large time
       gap (scraper was down / restarted — e.g. during a migration), old pre-gap
       candles otherwise render as a separate cluster with an empty void between
       them and the live candles. Cut at the last gap wider than 3× the base
       interval (inferred as the smallest gap) so the chart is one clean series. */
    if (unique.length > 2) {
      var minGap = Infinity;
      for (var k = 1; k < unique.length; k++) {
        var g = unique[k].t - unique[k - 1].t;
        if (g > 0 && g < minGap) minGap = g;
      }
      if (isFinite(minGap) && minGap > 0) {
        var cut = 0;
        for (var m = 1; m < unique.length; m++) {
          var gg = unique[m].t - unique[m - 1].t;
          // Only a real downtime gap: >10× the interval AND >30 min absolute
          // (so a quiet-market minute-skip never trims legit history).
          if (gg > minGap * 10 && gg > 1800) cut = m;
        }
        if (cut > 0) unique = unique.slice(cut);
      }
    }
    return unique;
  }

  /* ── Guaranteed-win price bias ───────────────────────────────────
     Works as a persistent price OFFSET (self._gwinBias) that is eased in and
     out gradually — it never snaps, so the candle stream is always continuous
     (NO gap / empty space between candles, even at the moment the trade ends):
       • Each trade wins by a DIFFERENT amount (gwinTarget, per-trade) → no
         fixed-size tell.
       • A smooth guided path (smootherstep) runs from entry to that target
         across the WHOLE trade — calm start, calm finish — so candles stay
         small and there is never a big late jump.
       • We only ever lift a SHORTFALL behind the path; a genuine bigger real
         move is left to ride (offset eases back to 0), nothing looks clipped.
       • When the trade ends the offset eases back to 0 over the next few ticks,
         so the price drifts back to the real market smoothly — no snap, no gap.
       • Per-tick cap + micro-jitter keep every candle small and organic.
     `price` is the RAW market/sim price (no offset baked in); we return the
     shown price = raw + eased offset. gwinTarget/gwinTotal/gwinJit come from
     _setTradeState. */
  function gwinAdjust(self, price) {
    if (!isFinite(price)) return price;
    var t = self._trade;
    var bias = self._gwinBias || 0;
    var active = t && t.gwin && t.gwinTarget != null;
    if (!active && bias === 0) return price;            // fast path: nothing applied
    var desiredBias = 0;
    if (active) {
      var isCall = t.direction === 'CALL';
      var total  = t.gwinTotal || 1;
      var p = 1 - (t.secondsLeft / total);             // progress 0 → 1
      if (p < 0) p = 0; else if (p > 1) p = 1;
      var e = p * p * p * (p * (p * 6 - 15) + 10);      // smootherstep
      var center = t.entryPrice + (t.gwinTarget - t.entryPrice) * e;
      // Shown price should sit on the win path; if the real price is already
      // deeper in profit, ride it (offset → 0).
      var desiredShown = isCall ? Math.max(price, center) : Math.min(price, center);
      desiredBias = desiredShown - price;
    }
    var step = (desiredBias - bias) * 0.18;            // ease toward target offset
    if (active && desiredBias !== 0) step += (Math.random() - 0.5) * (t.gwinJit || 0);
    var cap = price * 0.00015;                          // ≤ ~1.5 pip per tick → no candle jumps
    if (step >  cap) step =  cap;
    else if (step < -cap) step = -cap;
    bias += step;
    if (Math.abs(bias) < price * 0.000002) bias = 0;    // fully release tiny residual
    self._gwinBias = bias;
    return price + bias;
  }

  /* ── Chart Instance ──────────────────────────────────────────── */
  function Chart(container, symbol, interval, mode) {
    this.container  = container;
    this.symbol     = symbol;
    this.interval   = interval;
    this.mode       = mode || 'sim';   // 'sim' | 'otc'
    this.candles    = [];
    this.scrollRight = 0;
    this.candleW    = 9;   // fallback; _draw sizes candles to fill the width
    this.gap        = 1;
    this.mouse      = null;
    this.dragging   = false;
    this.dragX      = 0;
    this.dragScroll = 0;  /* unused — interaction disabled */
    this._tickTimer      = null;
    this._priceTimer        = null;
    this._simFallbackTimer = null;
    this._lastPrice    = 0;
    this._lastPriceTickTime = 0;
    this._distinctPrices = 0; /* count of distinct price changes received */
    this._resolvedSym    = null;
    this._destroyed      = false;
    this._ws             = null;
    this._wsTimer        = null;
    this._retryTimer     = null;  // (legacy retry timer handle)
    this._otcHistTimer   = null;  // otc-mode: periodic candle history refresh
    this._otcPriceTimer  = null;  // otc-mode: per-second live price poll
    this._loadStartedAt  = 0;     // (legacy load-cycle timing handle)
    this._sawEmptyResponse = false; // received >=1 valid JSON with empty candles
    this._marketClosedNote = false; // overlay 'market closed' note on next _draw
    this._poClosed       = false; // PO marks this pair closed → history load must not repaint
    this._trade          = null; // { direction, entryPrice, secondsLeft, gwin }
    this._gwinBias       = 0;    // current guaranteed-win price offset (eased in/out — never snaps)

    this.canvas = document.createElement('canvas');
    /* Lock the chart down: no text selection, no iOS long-press "Save/Open image"
       callout, no drag-out of the canvas as an image. This closes the loophole
       where touching/long-pressing the chart opened it as an image. */
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:crosshair;' +
      'user-select:none;-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;' +
      '-webkit-touch-callout:none;-webkit-user-drag:none;';
    this.canvas.setAttribute('draggable', 'false');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    var self = this;
    this._mm  = function(e) { self._onMM(e); };
    this._ml  = function()  { self.mouse = null; self._draw(); };
    this._ctx_menu = function(e) { e.preventDefault(); return false; };
    this._drag = function(e) { e.preventDefault(); return false; };

    this.canvas.addEventListener('mousemove',  this._mm);
    this.canvas.addEventListener('mouseleave', this._ml);
    // Block the browser context menu + image drag on the chart (all platforms).
    this.canvas.addEventListener('contextmenu', this._ctx_menu);
    this.canvas.addEventListener('dragstart',   this._drag);

    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(function() { self._resize(); });
      this._ro.observe(container);
    }

    this._init();
  }

  Chart.prototype._init = function() {
    var self = this;
    if (this.mode === 'otc') {
      this._resize();          // loading screen until proxy data arrives
      this._fetchOtcCandles();
      this._startOtcStream();
    } else {
      this.candles = buildHistory(this.symbol, this.interval, simCandleCount(this.interval));
      this._resize();
      this._startTick();
    }
  };

  Chart.prototype._resize = function() {
    var r  = this.container.getBoundingClientRect();
    this.W = r.width  || 400;
    this.H = r.height || 300;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.canvas.style.width  = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this._draw();
  };

  Chart.prototype._startPriceTick = function() {
    var self = this;
    // Close any existing WS
    if (this._ws) { try { this._ws.close(); } catch(_) {} this._ws = null; }
    clearTimeout(this._wsTimer); this._wsTimer = null;

    /* 1-second heartbeat: redraw only (keeps the live countdown badge ticking).
       A NEW candle is opened ONLY when a CHANGED price arrives (ws.onmessage),
       never as a flat candle on a timer — mirrors the server rule: a new candle
       requires BOTH the frame elapsing AND the price changing. So during a frozen
       price no flat candle is created; the new one opens when the price moves. */
    if (this._priceTimer) clearInterval(this._priceTimer);
    this._priceTimer = setInterval(function() {
      if (self._destroyed || !self.candles.length) return;
      self._draw();
    }, 1000);

    function connect() {
      if (self._destroyed) return;
      // Recompute the WS URL from PROXY on EVERY (re)connect so an admin proxy
      // switch (setProxy) is picked up — otherwise the socket stays pinned to the
      // proxy that was active when the chart first loaded and can never recover.
      var wsUrl = PROXY.replace(/^http/, 'ws') + '/ws';
      var ws = new WebSocket(wsUrl);
      self._ws = ws;

      ws.onopen = function() {
        ws.send(JSON.stringify({ sub: toOtcSym(self.symbol) }));
      };

      ws.onmessage = function(e) {
        if (self._destroyed) { ws.close(); return; }
        try {
          var d     = JSON.parse(e.data);
          var price = d.price;
          if (!isFinite(price) || !price) return;

          /* OTC: route WS ticks through the SAME price pipeline as the status
             poll (_feedOtcPrice → _animTarget → eased anim loop). Otherwise the
             WS wrote last.c directly while the anim loop simultaneously eased it
             back toward the (stale, 8s) poll target — the anim loop won and the
             live price froze. Feeding here makes every WS tick the live target,
             so the price moves in real time and new candles open on the frame. */
          self._lastPriceTickTime = Date.now();
          self._marketClosedNote = false;
          /* A live tick means the server is up — clear any stale server-down /
             reconnect banner right away instead of waiting for the 8s poll. */
          if (self._otcProblem === 'server' || self._otcProblem === 'reconnecting') {
            self._otcProblem = null;
            self._otcOverlay = null;
          }
          self._feedOtcPrice(price);   // handles gwinAdjust + new-candle + anim
        } catch(_) {}
      };

      ws.onclose = function() {
        self._ws = null;
        if (!self._destroyed) {
          self._wsTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = function() {};
    }

    connect();
  };

  /* ── OTC data mode (Pocket Option via proxy server) ─────────────────
     OTC pair candles + per-second price + scraper
     status flow through the proxy server's /api/otc/* endpoints (backed by the
     OTC scraper's in-memory store, with Supabase as persistence-only fallback).
     Live ticks arrive over the WebSocket. All candle timing is UTC-epoch based,
     identical on every device. */

  /* OTC symbol = PO's exact asset symbol (e.g. "EURUSD_otc", "#AAPL_otc").
     Do NOT upper-case — PO uses lowercase "_otc", and candle keys must match
     exactly what the scraper wrote. Only strip an exchange prefix if present. */
  function toOtcSym(sym) { return String(sym).replace(/^[A-Z]+:/, ''); }

  /* One specific message per real cause — never a generic "error". */
  var OTC_MSG = {
    offline:        ['🌐 تحقق من اتصالك بالإنترنت', '#F0C040'],
    reconnecting:   ['🔄 جاري إعادة الاتصال...', '#F0C040'],
    server:         ['⚠️ تعذر الاتصال بالسيرفر، جاري المحاولة...', '#F0C040'],
    relogin:        ['🔄 جاري إعادة تسجيل الدخول للمنصة...', '#F0C040'],
    login_failed:   ['⚠️ تعذر الاتصال بمنصة البيانات، يتم إبلاغ الدعم الفني', '#FF6B6B'],
    ip_blocked:     ['⚠️ تعذر الوصول لمصدر البيانات حاليًا', '#FF6B6B'],
    resolving:      ['🔧 جاري إصلاح الاتصال بمصدر البيانات...', '#F0C040'],
    repairing:      ['🔄 جاري إعادة الاتصال بمصدر البيانات...', '#F0C040'],
    repairing_long: ['⏳ النظام بيستعيد الاتصال، استنى لحظات', '#F0C040'],
    circuit:        ['⏳ النظام بيستريح شوية، هيرجع تلقائي خلال دقايق', '#F0C040'],
    supabase:       ['📡 مشكلة مؤقتة في تحميل البيانات، جاري المحاولة', '#F0C040'],
    warming:        ['📊 جاري تجهيز البيانات لأول مرة، يستغرق دقيقة', '#5AC8FA'],
    unavailable:    ['هذا الزوج غير متاح حاليًا', '#9CA3AF'],
    market_closed:  ['🔒 السوق مغلق حاليًا', '#FF6B6B'],
  };

  /* Transient states keep the last candles visible with a calm banner overlay
     (the chart isn't "broken" — something is working quietly in the background).
     Hard/no-data states take over the whole canvas. */
  var OTC_OVERLAY_KINDS = { repairing: 1, repairing_long: 1, reconnecting: 1, relogin: 1, resolving: 1 };

  /* _sbHeaders removed — OTC data routed through proxy, no direct Supabase. */

  Chart.prototype._otcMsg = function(kind) {
    this._otcProblem = kind;
    var m = OTC_MSG[kind] || OTC_MSG.unavailable;
    /* market_closed HIDES the chart entirely — the user asked to just show
       "market closed" with no chart. Transient states keep candles + a banner.
       Everything else keeps candles once loaded (calm banner). */
    if (kind !== 'market_closed' && this.candles && this.candles.length) {
      this._otcOverlay = { text: m[0], color: m[1] };   // candles stay + banner
      this._draw();
    } else {
      this._otcOverlay = null;
      this._drawMessage(m[0], m[1]);                     // full takeover (hide chart)
    }
  };

  /* Candle history from the proxy /api/otc/candles endpoint. */
  Chart.prototype._fetchOtcCandles = function() {
    var self = this;
    function load() {
      if (self._destroyed) return;
      var url = PROXY + '/api/otc/candles?symbol=' +
                encodeURIComponent(toOtcSym(self.symbol)) + '&interval=' + self.interval;
      fetchT(url)
        .then(function(r) { if (!r.ok) throw 0; return r.json(); })
        .then(function(d) {
          if (self._destroyed) return;
          var arr = (d && d.candles) || [];
          arr = cleanAndSortCandles(arr);
          if (!arr.length) return;
          if (!self._otcHistLoaded) {
            /* FIRST successful load → BATCH RENDER: adopt all 50 and paint them
               in one shot, right now, regardless of any status message the poll
               may have raised. Full chart on screen in < 1s, like the platform. */
            self._otcHistLoaded = true;
            self.candles = arr.slice(-MAX_CANDLES);
            self._otcProblem = null;      // never let a transient message hide the chart
            self._otcOverlay = null;
            // Don't paint over the "market closed" takeover — the price poll owns
            // that state. Adopt the candles now; they'll show when it reopens.
            if (!self._poClosed) {
              self._draw();
              self._startPriceTick();
            }
            return;
          }
          /* Periodic top-up: adopt stored history only when it's at/ahead of our
             local forming candle, so a refresh never wipes the live candle. */
          var lastLocal  = self.candles.length ? self.candles[self.candles.length - 1].t : 0;
          var lastStored = arr[arr.length - 1].t;
          if (lastStored >= lastLocal) {
            self.candles = arr.slice(-MAX_CANDLES);
            if (!self._otcProblem && !self._poClosed) self._draw();
          }
        })
        .catch(function() { /* surfaced by the status poll (supabase down) */ });
    }
    load();
    this._otcHistTimer = setInterval(load, 15000);
  };

  /* Per-second status + price poll → resolves the exact state, then either shows
     the right message or feeds the live price into the candles. */
  Chart.prototype._startOtcStream = function() {
    var self = this;
    function poll() {
      if (self._destroyed) return;
      if (self._otcPolling) return; // Prevent request queue piling
      /* STATE 17 — the user's own device is offline. */
      if (navigator.onLine === false) { self._otcMsg('offline'); return; }
      var url = PROXY + '/api/otc/status';
      self._otcPolling = true;
      fetchT(url)
        .then(function(r) { if (!r.ok) throw 0; return r.json(); })
        .then(function(rows) {
          if (self._destroyed) return;
          var status = {}, prices = {};
          (rows || []).forEach(function(row) {
            if (row.id === 'otc_status') status = row.data || {};
            else if (row.id === 'otc_prices') prices = row.data || {};
          });
          self._onOtcData(status, prices);
        })
        /* STATE 6 — Supabase itself isn't responding. */
        .catch(function() { if (!self._destroyed) self._otcMsg('supabase'); })
        .finally(function() { self._otcPolling = false; });
    }
    poll();
    this._otcPriceTimer = setInterval(poll, 8000);   // 8s status refresh (WebSocket delivers ticks)
  };

  Chart.prototype._onOtcData = function(status, prices) {
    var sym   = toOtcSym(this.symbol);
    var now   = Date.now();
    var hbAge = status.updatedAt ? (now - Date.parse(status.updatedAt)) : Infinity;
    var entry = prices ? prices[sym] : null;

    /* MARKET CLOSED (Pocket Option's own flag): if PO marks this asset closed
       (po === false — the "N/A" state), HIDE the chart entirely and show only
       "market closed" — even though PO keeps streaming the price. */
    if (entry && entry.po === false) { this._poClosed = true; this._otcMsg('market_closed'); return; }
    this._poClosed = false;   // market is open for this pair → history load may draw

    /* PRICES WIN: if THIS pair has a fresh live price, render it regardless of the
       global scraper status. The price source (e.g. a local worker) can be a
       different process than whatever last wrote otc_status, so a stale/failed
       status must never hide live data. */
    var fresh = entry && entry.t && (now / 1000 - entry.t < 15) && entry.p > 0;
    if (fresh && entry.st !== 'circuit' && entry.st !== 'resolving') {
      this._otcProblem = null;
      this._otcOverlay = null;
      this._feedOtcPrice(entry.p);
      return;
    }

    /* ── Macro (whole scraper / server) states ── */
    /* STATE 8 — auto-repair gave up / token truly dead → manual re-capture. */
    if (status.phase === 'login_failed') { this._otcMsg('login_failed'); return; }
    /* STATE 12 — Pocket Option blocked the server IP. */
    if (status.phase === 'ip_blocked')   { this._otcMsg('ip_blocked');   return; }
    /* SELF-REPAIR — token died, system is re-capturing it automatically. Keep
       last candles + calm banner; escalate the wording if it runs over a minute. */
    if (status.phase === 'repairing') {
      var since = status.phaseSince ? (now - Date.parse(status.phaseSince)) : 0;
      this._otcMsg(since > 60000 ? 'repairing_long' : 'repairing');
      return;
    }
    /* A live WS tick in the last minute PROVES the server is up — never show a
       "server down / reconnecting" banner off a stale-or-absent otc_status
       .updatedAt (it's event-driven: it goes stale in steady state and, as seen
       in prod, can be missing entirely → hbAge = Infinity → false "server" banner
       while prices stream fine). Price liveness is the ground truth. */
    var tickAge  = this._lastPriceTickTime ? (now - this._lastPriceTickTime) : Infinity;
    var liveTick = tickAge < 60000;
    /* STATE 2 & 14 — scraper not heartbeating for long → server down / maintenance. */
    if (!liveTick && hbAge > 150000) { this._otcMsg('server'); return; }
    /* STATE 10 & 13 — short heartbeat gap → new deploy / restart / VPN hiccup. */
    if (!liveTick && hbAge > 45000)  { this._otcMsg('reconnecting'); return; }
    /* STATE 4 — re-establishing the Pocket Option session. */
    if (status.phase === 'relogin' || status.phase === 'reconnecting' ||
        status.connected === false) { this._otcMsg('relogin'); return; }

    /* ── Per-pair states ── */
    if (!entry) {
      /* Enabled pair with no price yet: warming if we already have some candles,
         otherwise genuinely unavailable on the platform (STATE 7 / 16). */
      if (this.candles.length) this._otcMsg('warming');
      else this._otcMsg('unavailable');
      return;
    }
    /* STATE 5 — circuit breaker open for this pair. */
    if (entry.st === 'circuit')   { this._otcMsg('circuit');   return; }
    /* STATE 3 — server up but the scraper can't read this pair's price. */
    if (entry.st === 'resolving') { this._otcMsg('resolving'); return; }
    /* STATE 16 — first-time: price flowing but not enough candles yet. */
    if (this.candles.length < 3) { this._feedOtcPrice(entry.p, true); this._otcMsg('warming'); return; }

    /* Live (STATE 1 market-closed is surfaced by the Flutter dialog, candles
       just stay frozen) → feed the real price into the candle series. */
    this._otcProblem = null;
    this._otcOverlay = null;     // clear any repair/reconnect banner
    this._feedOtcPrice(entry.p);
  };

  /* Feed one real OTC price. The close is EASED toward the new price by the
     animation loop (smooth up/down), and a new candle opens AT the previous
     close (continuous — no price gap between candles). */
  Chart.prototype._feedOtcPrice = function(price, noDraw) {
    if (!isFinite(price) || !price) return;
    price = gwinAdjust(this, price);
    var cs    = candleSec(this.interval);
    var now   = Math.floor(Date.now() / 1000);   // UTC epoch
    var cTime = Math.floor(now / cs) * cs;
    /* SELF-HEAL: drop any trailing candle whose timestamp is in the FUTURE
       relative to real now. A one-off device-clock jump (laptop wake / NTP
       resync) can stamp a candle minutes/hours ahead; that future `last` then
       permanently froze the price (cTime < last.t hit the `else return` below,
       and the history top-up refused to overwrite a "newer" local candle). */
    while (this.candles.length && this.candles[this.candles.length - 1].t > cTime) {
      this.candles.pop();
    }
    if (!this.candles.length) {
      this.candles.push({ t: cTime, o: price, h: price, l: price, c: price });
      this._animTarget = price;
      this._startAnim();
      return;
    }
    var last = this.candles[this.candles.length - 1];
    if (cTime === last.t) {
      // Same frame: extend H/L now for accuracy; the close eases toward price.
      if (price > last.h) last.h = price;
      if (price < last.l) last.l = price;
      this._animTarget = price;
    } else if (cTime > last.t) {
      // New frame: open the candle AT the previous close so the series stays
      // continuous (no visual gap), then ease the close toward the new price.
      var open = last.c;
      var nc = { t: cTime, o: open, h: Math.max(open, price), l: Math.min(open, price), c: open };
      this.candles.push(nc);
      if (this.candles.length > MAX_CANDLES) this.candles.shift();
      this._animTarget = price;
    } else { return; }
    this._lastPrice = price;
    this._startAnim();
  };

  /* Smooth animation loop: eases the current candle's close toward the latest
     price (~60fps) so it glides up/down instead of jumping every poll; keeps the
     countdown ticking (~2/s) when the price is steady. */
  Chart.prototype._startAnim = function() {
    if (this._animOn) return;
    this._animOn = true;
    var self = this;
    var lastTick = -1;
    function frame() {
      if (self._destroyed || !self._animOn) { self._animRAF = null; return; }
      var arr = self.candles, drew = false;
      if (arr.length && self._animTarget != null) {
        var last = arr[arr.length - 1];
        var diff = self._animTarget - last.c;
        var eps = Math.abs(self._animTarget) * 1e-7 || 1e-9;
        if (Math.abs(diff) > eps) {
          last.c += diff * 0.2;                       // ease toward target
          if (last.c > last.h) last.h = last.c;
          if (last.c < last.l) last.l = last.c;
          if (!self._otcProblem || self._otcOverlay) self._draw();
          drew = true;
        } else if (last.c !== self._animTarget) {
          last.c = self._animTarget;
          if (last.c > last.h) last.h = last.c;
          if (last.c < last.l) last.l = last.c;
          if (!self._otcProblem || self._otcOverlay) self._draw();
          drew = true;
        }
      }
      if (!drew) {                                    // keep countdown alive ~2/s
        var t = Math.floor(Date.now() / 500);
        if (t !== lastTick) { lastTick = t; if (!self._otcProblem || self._otcOverlay) self._draw(); }
      }
      self._animRAF = requestAnimationFrame(frame);
    }
    self._animRAF = requestAnimationFrame(frame);
  };
  Chart.prototype._stopAnim = function() {
    this._animOn = false;
    if (this._animRAF) { cancelAnimationFrame(this._animRAF); this._animRAF = null; }
  };

  /* ── Live tick simulation ────────────────────────────────────── */
  Chart.prototype._startTick = function() {
    var self = this;
    if (this._tickTimer) clearInterval(this._tickTimer);

    var a  = asset(this.symbol);
    var cs = candleSec(this.interval);
    /* Tick sigma = 1/8 of candle sigma so each tick is a small move */
    var tickSigma = a.s * Math.sqrt(cs / 60) / 8;

    this._tickTimer = setInterval(function() {
      if (self._destroyed || !self.candles.length) return;

      var last  = self.candles[self.candles.length - 1];
      var nowSec = Math.floor(Date.now() / 1000);
      var cT     = Math.floor(nowSec / cs) * cs;

      if (cT > last.t) {
        /* New candle — drop oldest if window is full */
        var open = last.c;
        self.candles.push({ t: cT, o: open, h: open, l: open, c: open });
        if (self.candles.length > MAX_CANDLES) self.candles.shift();
        last = self.candles[self.candles.length - 1];
      }

      /* Price tick — walk the RAW (offset-free) price, then re-apply the eased
         guaranteed-win offset on top so it is never double-counted and candles
         stay continuous. */
      var raw   = last.c - (self._gwinBias || 0);
      var move  = tickSigma * randn();
      /* Gentle pull toward base price */
      move += (a.p - raw) * 0.0008;
      raw = raw + move;

      var price = gwinAdjust(self, raw);

      last.c = price;
      if (price > last.h) last.h = price;
      if (price < last.l) last.l = price;

      self._draw();
    }, 500); // new tick every 500 ms
  };

  /* ── Loading screen (waiting for data) ──────────────────────── */
  Chart.prototype._drawLoading = function() {
    var ctx = this.ctx;
    var W = this.W || 400, H = this.H || 300, dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    drawWatermark(ctx, W, H);
    ctx.fillStyle = TEXT;
    ctx.font = '13px Outfit,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('جاري الاتصال بالسوق...', W / 2, H / 2 - 10);
    ctx.font = '11px Outfit,sans-serif';
    ctx.fillStyle = GRID;
    var displaySym = this.symbol.replace(/^[A-Z]+:/, '').replace(/_/g, '/');
    ctx.fillText(displaySym, W / 2, H / 2 + 14);
  };

  /* ── Generic on-canvas message (status / error states) ───────── */
  /* Clears the canvas and draws `text` centered (word-wrapped if long) in
     `color` (default light gray). Used for all status states. */
  Chart.prototype._drawMessage = function(text, color) {
    var ctx = this.ctx;
    var W = this.W || 400, H = this.H || 300, dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    drawWatermark(ctx, W, H);

    ctx.fillStyle = color || TEXT;
    ctx.font = '13px Outfit,sans-serif';
    ctx.textAlign = 'center';

    /* Word-wrap to fit width (with a small horizontal margin) */
    var maxW  = Math.max(40, W - 24);
    var words = ('' + text).split(' ');
    var lines = [];
    var line  = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line); line = words[i];
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);

    var lh = 18;
    var startY = H / 2 - ((lines.length - 1) * lh) / 2;
    for (var li = 0; li < lines.length; li++) {
      ctx.fillText(lines[li], W / 2, startY + li * lh);
    }

    /* Symbol caption underneath, like the loading screen */
    ctx.font = '11px Outfit,sans-serif';
    ctx.fillStyle = GRID;
    var displaySym = this.symbol.replace(/^[A-Z]+:/, '').replace(/_/g, '/');
    ctx.fillText(displaySym, W / 2, startY + lines.length * lh + 8);
  };

  /* ── Draw ────────────────────────────────────────────────────── */
  Chart.prototype._draw = function() {
    var ctx = this.ctx;
    var W = this.W, H = this.H, dpr = this.dpr || 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    drawWatermark(ctx, W, H);   /* faint brand logo behind everything */

    if (!this.candles.length) { this._drawLoading(); return; }

    var cl = LM, cr = W - RM, ct = TM, cb = H - BM;
    var cw = cr - cl, ch = cb - ct;

    /* ── Candle sizing ──────────────────────────────────────────────
       Candles TILE the plot width edge-to-edge with ZERO gap — a continuous
       series like the trading platform, no empty columns / gaps between candles
       ever. The slot width is chosen so the most-recent candles span the full
       width, clamped to a readable thickness. step == candleW so body N ends
       exactly where body N+1 begins. */
    var total = this.candles.length;

    /* The slot is clamped from BOTH sides now, and the lower clamp is the one
       that matters on a phone.

       Fitting all 100 candles used to win unconditionally: on a 360px screen
       the plot is about 244px, so the slot came out at 2.4px and the body at
       TWO PIXELS. A 2px body under a full-height wick is a vertical hair — you
       cannot tell a body from a wick, or green from red, and the chart reads as
       a comb. More history on screen is worth nothing if none of it is legible.

       So the BODY width is what stays roughly constant (~6px) across devices
       and the NUMBER of visible candles is what varies, which is how every real
       trading app behaves: a phone shows ~30 candles, a desktop all 100, both
       readable. The older ones are still there — scrollRight reaches them. */
    var MIN_SLOT = 8;
    var MAX_SLOT = 14;
    var fitsAtMin = Math.max(1, Math.floor(cw / MIN_SLOT));
    var showN = Math.max(1, Math.min(total, fitsAtMin));
    var slot  = Math.min(cw / showN, MAX_SLOT);
    var step  = slot;                                      // fractional is fine on canvas
    this.candleW = Math.max(1, Math.round(step * 0.72));   // body ~72% of slot → small gap
    this.gap     = step - this.candleW;

    /* Visible candles: ALL of them (right-aligned, newest on the right). */
    var maxVis  = showN;
    var endIdx  = total - clamp(this.scrollRight, 0, total - 1);
    var startIdx = Math.max(0, endIdx - maxVis);
    var vis = this.candles.slice(startIdx, endIdx);
    if (!vis.length) return;

    /* Y range */
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < vis.length; i++) {
      if (vis[i].l < lo) lo = vis[i].l;
      if (vis[i].h > hi) hi = vis[i].h;
    }
    var pad = (hi - lo) * 0.08 || 0.001;
    lo -= pad; hi += pad;

    /* Right-align so the NEWEST candle sits on the right edge: a short series
       fills from the right (like the broker platform) instead of leaving an
       empty gap on the right. */
    var xOff = cl + Math.max(0, cw - vis.length * step);   // right-align by pixels; fills fully when candles span cw
    function py(p) { return cb - ((p - lo) / (hi - lo)) * ch; }
    function cx(i) { return xOff + i * step + step / 2; }

    this._vis = vis; this._startIdx = startIdx;
    this._py = py; this._cx = cx;
    this._cl = cl; this._cr = cr; this._ct = ct; this._cb = cb;
    this._lo = lo; this._hi = hi; this._ch = ch; this._step = step;

    var last = this.candles[this.candles.length - 1];
    var dec = last ? autoDec(last.c) : decimals(this.symbol);

    /* Candle countdown timer — pure wall-clock, same formula as signal_engine.dart:
       secsLeft = cs - (nowSec % cs)   → matches Flutter exactly */
    var cs2 = candleSec(this.interval);
    var nowSec2 = Math.floor(Date.now() / 1000);
    var secsLeft = cs2 - (nowSec2 % cs2);
    var minsLeft = Math.floor(secsLeft / 60);
    var secsPart = secsLeft % 60;
    var countdownStr = minsLeft > 0
      ? minsLeft + ':' + (secsPart < 10 ? '0' : '') + secsPart
      : secsPart + 's';

    /* Grid + Y labels */
    ctx.font = '11px Outfit,sans-serif';
    var ticks = niceTicks(lo, hi, 5);
    for (var ti = 0; ti < ticks.length; ti++) {
      var tv = ticks[ti];
      if (tv < lo || tv > hi) continue;
      var gy = py(tv);
      ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.setLineDash([3,4]);
      ctx.beginPath(); ctx.moveTo(cl, gy); ctx.lineTo(cr, gy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = TEXT; ctx.textAlign = 'right';
      ctx.fillText(tv.toFixed(dec), W - 4, gy + 4);
    }
    /* Y axis border */
    ctx.strokeStyle = BORDER; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cr, ct); ctx.lineTo(cr, H); ctx.stroke();

    /* X axis */
    ctx.strokeStyle = BORDER;
    ctx.beginPath(); ctx.moveTo(cl, cb); ctx.lineTo(cr, cb); ctx.stroke();
    ctx.fillStyle = TEXT; ctx.textAlign = 'center';
    var lastCX = vis.length > 0 ? cx(vis.length - 1) : -999;
    for (var li = 0; li < vis.length; li++) {
      if (showLabel(vis[li].t, this.interval)) {
        var lx = cx(li);
        // Skip label if it overlaps the countdown badge slot at the last candle
        if (secsLeft > 0 && Math.abs(lx - lastCX) < 28) continue;
        ctx.fillText(fmtShort(vis[li].t, this.interval), lx, cb + 18);
      }
    }

    /* ── Candle countdown badge on X axis (below last candle) ── */
    /* OTC market-closed is shown via the _marketClosedNote overlay, not this
       countdown badge — so the badge only ever shows the live countdown. */
    var noTickYet    = false;
    var marketClosed = false;
    if (!noTickYet && last && lastCX >= cl && lastCX <= cr && (secsLeft > 0 || marketClosed)) {
      var badgeLabel = marketClosed ? 'CLOSED' : countdownStr;
      var bW = marketClosed ? 58 : 46, bH = 18, bX = lastCX - bW / 2, bY = cb + 4;
      ctx.fillStyle = marketClosed ? 'rgba(255,60,60,0.15)' : 'rgba(0,255,240,0.15)';
      ctx.fillRect(bX, bY, bW, bH);
      ctx.strokeStyle = marketClosed ? 'rgba(255,60,60,0.5)' : 'rgba(0,255,240,0.45)';
      ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.strokeRect(bX, bY, bW, bH);
      ctx.fillStyle = marketClosed ? 'rgba(255,100,100,0.9)' : CROSS;
      ctx.font = 'bold 10px Outfit,monospace'; ctx.textAlign = 'center';
      ctx.fillText(badgeLabel, lastCX, bY + 13);
    }

    /* Candles */
    var halfW = Math.max(1, Math.floor(this.candleW / 2));
    for (var ci = 0; ci < vis.length; ci++) {
      var c     = vis[ci];
      var x     = cx(ci);
      var color = c.c >= c.o ? BULL : BEAR;
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, py(c.h)); ctx.lineTo(x, py(c.l)); ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillRect(x - halfW, py(Math.max(c.o,c.c)), this.candleW,
                   Math.max(1, py(Math.min(c.o,c.c)) - py(Math.max(c.o,c.c))));
    }

    /* Current price line */
    if (last) {
      var lpy = py(last.c);
      if (lpy >= ct && lpy <= cb) {
        ctx.strokeStyle = DASH; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
        ctx.beginPath(); ctx.moveTo(cl, lpy); ctx.lineTo(cr, lpy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = DASH;
        ctx.fillRect(cr, lpy - 10, RM, 20);
        ctx.fillStyle = BG; ctx.textAlign = 'center'; ctx.font = '11px Outfit,sans-serif';
        ctx.fillText(last.c.toFixed(dec), cr + RM / 2, lpy + 4);
        /* Countdown timer badge above price tag — hidden when no tick yet or market closed */
        if (!noTickYet && !marketClosed && secsLeft > 0 && secsLeft <= cs2) {
          ctx.fillStyle = 'rgba(30,20,60,0.85)';
          ctx.fillRect(cr, lpy - 28, RM, 16);
          ctx.fillStyle = CROSS; ctx.font = 'bold 10px Outfit,monospace';
          ctx.fillText(countdownStr, cr + RM / 2, lpy - 17);
        }
      }
    }

    /* Entry line */
    this._drawEntryLine(py, cl, cr, ct, cb, dec, last ? last.c : null);
    this._drawEntryMarker();

    /* State 6: market-closed note near the top (candles stay visible). */
    if (this._marketClosedNote) {
      ctx.fillStyle = '#F0C040';
      ctx.font = 'bold 12px Outfit,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('السوق مغلق حالياً', (cl + cr) / 2, ct + 14);
    }

    /* OTC transient overlay (self-repair / reconnecting): keep the last candles
       visible and show a calm translucent banner on top — not a full takeover. */
    if (this._otcOverlay) {
      ctx.fillStyle = 'rgba(10,7,20,0.74)';
      ctx.fillRect(cl, ct, cr - cl, 30);
      ctx.fillStyle = this._otcOverlay.color || '#F0C040';
      ctx.font = 'bold 12px Outfit,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(this._otcOverlay.text, (cl + cr) / 2, ct + 19);
    }

    /* Crosshair */
    if (this.mouse) this._crosshair(vis, dec, py, cx, cl, cr, ct, cb, lo, hi, ch);
  };

  Chart.prototype._crosshair = function(vis, _dec, py, cx, cl, cr, ct, cb, lo, hi, ch) {
    var dec = _dec; // passed from _draw (autoDec-based)
    var ctx = this.ctx;
    var mx  = this.mouse.x, my = this.mouse.y;
    var step = this._step;
    var W    = this.W;

    var li = clamp(Math.round((mx - cx(0)) / step), 0, vis.length - 1);
    var c  = vis[li];
    if (!c) return;
    var x  = cx(li);
    var cursorPrice = hi - ((my - ct) / ch) * (hi - lo);

    /* Lines */
    ctx.strokeStyle = CROSS; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(x, ct); ctx.lineTo(x, cb); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cl, my); ctx.lineTo(cr, my); ctx.stroke();
    ctx.setLineDash([]);

    /* Y label */
    ctx.fillStyle = CROSS;
    ctx.fillRect(cr, my - 10, RM, 20);
    ctx.fillStyle = BG; ctx.textAlign = 'center'; ctx.font = '11px Outfit,sans-serif';
    ctx.fillText(cursorPrice.toFixed(dec), cr + RM/2, my + 4);

    /* X label */
    var lw = 84;
    ctx.fillStyle = CROSS;
    ctx.fillRect(x - lw/2, cb, lw, BM);
    ctx.fillStyle = BG; ctx.textAlign = 'center';
    ctx.fillText(fmtFull(c.t, this.interval), x, cb + 18);

    /* OHLC tooltip */
    var isUp = c.c >= c.o;
    var txL  = (x + 14 + 170 < W - RM) ? x + 14 : x - 184;
    var tyL  = ct + 8;
    ctx.fillStyle = 'rgba(10,7,20,0.92)';
    ctx.fillRect(txL, tyL, 170, 84);
    ctx.strokeStyle = isUp ? BULL : BEAR; ctx.lineWidth = 1;
    ctx.strokeRect(txL, tyL, 170, 84);
    var rows = ['O  '+c.o.toFixed(dec),'H  '+c.h.toFixed(dec),'L  '+c.l.toFixed(dec),'C  '+c.c.toFixed(dec)];
    ctx.fillStyle = TEXT; ctx.textAlign = 'left'; ctx.font = '11px "Courier New",monospace';
    for (var ri = 0; ri < rows.length; ri++) ctx.fillText(rows[ri], txL+10, tyL+20+ri*17);
  };

  /* ── Mouse events ────────────────────────────────────────────── */
  Chart.prototype._onMM = function(e) {
    var r = this.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    this._draw();
  };

  /* ── Public methods ──────────────────────────────────────────── */
  Chart.prototype.update = function(symbol, interval, mode) {
    if (mode !== undefined) this.mode = mode;
    this.symbol      = symbol;
    this.interval    = interval;
    this.scrollRight  = 0;
    this.candles      = [];
    this._resolvedSym = null;
    this._stopAnim();
    this._animTarget = null;
    /* Guaranteed-win state is PER-PAIR: a residual bias/trade must never bleed
       onto the next pair (a BTC-scale offset applied to EUR/USD freezes it). */
    this._gwinBias = 0;
    this._trade    = null;
    /* Reset status-timing windows for the new symbol/interval. */
    this._loadStartedAt    = 0;
    this._sawEmptyResponse = false;
    this._marketClosedNote = false;

    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    if (this._priceTimer)   { clearInterval(this._priceTimer);   this._priceTimer   = null; }
    if (this._ws)        { try { this._ws.close(); } catch(_) {} this._ws = null; }
    clearTimeout(this._wsTimer); this._wsTimer = null;
    clearTimeout(this._retryTimer); this._retryTimer = null;
    if (this._otcHistTimer)  { clearInterval(this._otcHistTimer);  this._otcHistTimer  = null; }
    if (this._otcPriceTimer) { clearInterval(this._otcPriceTimer); this._otcPriceTimer = null; }
    this._otcProblem = null;
    this._otcOverlay = null;
    this._otcHistLoaded = false;   // new pair → next successful fetch batch-renders

    var self = this;
    if (this.mode === 'otc') {
      clearTimeout(this._simFallbackTimer);
      this._draw();   // loading screen until Supabase data arrives
      this._fetchOtcCandles();
      this._startOtcStream();
    } else {
      this.candles = buildHistory(this.symbol, this.interval, simCandleCount(self.interval));
      this._startTick();
      this._draw();
    }
  };

  Chart.prototype.destroy = function() {
    this._destroyed = true;
    this._stopAnim();
    if (this._tickTimer) clearInterval(this._tickTimer);
    if (this._priceTimer)   clearInterval(this._priceTimer);
    if (this._otcHistTimer)  clearInterval(this._otcHistTimer);
    if (this._otcPriceTimer) clearInterval(this._otcPriceTimer);
    if (this._ws)        { try { this._ws.close(); } catch(_) {} this._ws = null; }
    clearTimeout(this._wsTimer);
    clearTimeout(this._simFallbackTimer);
    clearTimeout(this._retryTimer);
    if (this._ro)        this._ro.disconnect();
    this.canvas.removeEventListener('mousemove',  this._mm);
    this.canvas.removeEventListener('mouseleave', this._ml);
    if (this._ctx_menu) this.canvas.removeEventListener('contextmenu', this._ctx_menu);
    if (this._drag)     this.canvas.removeEventListener('dragstart',   this._drag);
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  };

  /* ── Entry line (drawn when trade is active) ────────────────── */
  Chart.prototype._drawEntryLine = function(py, cl, cr, ct, cb, dec, lastClose) {
    if (!this._entryLine) return;
    var ctx    = this.ctx;
    var ep     = this._entryLine.price;
    var isCall = this._entryLine.direction === 'CALL';
    var winning = lastClose != null ? (isCall ? lastClose > ep : lastClose < ep) : isCall;
    var color  = winning ? BULL : BEAR;
    var epy    = py(ep);
    if (epy < ct || epy > cb) return;

    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
    ctx.beginPath(); ctx.moveTo(cl, epy); ctx.lineTo(cr, epy); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = color;
    ctx.fillRect(cr, epy - 10, RM, 20);
    ctx.fillStyle = BG; ctx.textAlign = 'center';
    ctx.font = 'bold 10px Outfit,sans-serif';
    ctx.fillText(ep.toFixed(autoDec(ep)), cr + RM / 2, epy + 4);
  };

  /* ── Entry marker (BUY/SELL arrow on the candle the signal started from) ──
     CALL → green "BUY" arrow BELOW the candle low (pointing up).
     PUT  → red   "SELL" arrow ABOVE the candle high (pointing down).
     Anchored to the entry candle by time so it tracks as candles scroll. */
  Chart.prototype._drawEntryMarker = function() {
    var el = this._entryLine;
    if (!el || el.t == null) return;
    var vis = this._vis, cx = this._cx, py = this._py;
    if (!vis || !cx || !py) return;

    var vi = -1;
    for (var i = 0; i < vis.length; i++) {
      if (vis[i].t === el.t) { vi = i; break; }
    }
    if (vi < 0) return;                 // entry candle scrolled off-screen

    var c = vis[vi];
    var x = cx(vi);
    var isCall = el.direction === 'CALL';
    var color = isCall ? BULL : BEAR;
    var label = isCall ? 'BUY' : 'SELL';
    var ctx = this.ctx;

    function roundRect(c2, rx, ry, rw, rh, r) {
      c2.beginPath();
      c2.moveTo(rx + r, ry);
      c2.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
      c2.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
      c2.arcTo(rx, ry + rh, rx, ry, r);
      c2.arcTo(rx, ry, rx + rw, ry, r);
      c2.closePath();
    }

    ctx.save();
    ctx.font = 'bold 9px Outfit,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var tw = ctx.measureText(label).width;
    var pw = Math.ceil(tw) + 12, ph = 15;
    var gap = 5, ah = 9, aw = 6;        // gap, arrow height, arrow half-width

    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = color;

    if (isCall) {
      // Below the candle low, arrow points UP toward the candle.
      var ay = py(c.l) + gap;           // arrow tip
      ctx.beginPath();
      ctx.moveTo(x, ay);
      ctx.lineTo(x - aw, ay + ah);
      ctx.lineTo(x + aw, ay + ah);
      ctx.closePath();
      ctx.fill();
      roundRect(ctx, x - pw / 2, ay + ah, pw, ph, 3);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = BG;
      ctx.fillText(label, x, ay + ah + ph / 2 + 0.5);
    } else {
      // Above the candle high, arrow points DOWN toward the candle.
      var by = py(c.h) - gap;           // arrow tip
      ctx.beginPath();
      ctx.moveTo(x, by);
      ctx.lineTo(x - aw, by - ah);
      ctx.lineTo(x + aw, by - ah);
      ctx.closePath();
      ctx.fill();
      roundRect(ctx, x - pw / 2, by - ah - ph, pw, ph, 3);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = BG;
      ctx.fillText(label, x, by - ah - ph / 2 + 0.5);
    }
    ctx.restore();
  };

  Chart.prototype._setTradeState = function(active, direction, entryPrice, secondsLeft, gwin) {
    if (!active) { this._trade = null; return; }
    var prev = this._trade;
    var t = { direction: direction, entryPrice: entryPrice, secondsLeft: secondsLeft, gwin: gwin };
    if (gwin) {
      // Reuse the win path while the SAME trade keeps ticking; (re)initialise it
      // only for a fresh trade (new entry/direction) so every trade wins by a
      // different, realistic amount.
      var same = prev && prev.gwin && prev.gwinTarget != null &&
                 prev.direction === direction && prev.entryPrice === entryPrice;
      if (same) {
        t.gwinTarget = prev.gwinTarget;
        t.gwinTotal  = Math.max(prev.gwinTotal, secondsLeft);
        t.gwinJit    = prev.gwinJit;
      } else {
        var isCall = direction === 'CALL';
        var margin = entryPrice * (0.00006 + Math.random() * 0.00040); // ~0.6–4.6 pip, varied
        t.gwinTarget = isCall ? entryPrice + margin : entryPrice - margin;
        t.gwinTotal  = Math.max(secondsLeft, 1);
        t.gwinJit    = entryPrice * 0.00002;            // micro-jitter on corrected ticks
      }
    }
    this._trade = t;
  };

  /* ── Public API ──────────────────────────────────────────────── */
  var instances = {};

  function _tryInit(id, sym, iv, mode, tries) {
    var el = document.getElementById(id);
    if (!el) {
      if (tries < 100) setTimeout(function() { _tryInit(id, sym, iv, mode, tries+1); }, 20);
      return;
    }
    if (instances[id]) { instances[id].destroy(); delete instances[id]; }
    instances[id] = new Chart(el, sym, iv, mode);
  }

  return {
    init:    function(id, sym, iv, mode) { _tryInit(id, sym, iv, mode || 'sim', 0); },
    update:  function(id, sym, iv, mode) {
      var i = instances[id];
      if (i) i.update(sym, iv, mode);
      else _tryInit(id, sym, iv, mode || 'sim', 0);
    },
    destroy: function(id) { if (instances[id]) { instances[id].destroy(); delete instances[id]; } },
    getLastPrice: function(id) {
      var inst = instances[id];
      if (!inst || !inst.candles.length) return 0;
      return inst.candles[inst.candles.length - 1].c;
    },
    setEntryLine: function(id, price, direction) {
      var inst = instances[id];
      if (!inst) return;
      if (price && direction) {
        var t = inst.candles.length ? inst.candles[inst.candles.length - 1].t : null;
        inst._entryLine = { price: price, direction: direction, t: t };
      } else {
        inst._entryLine = null;
      }
      inst._draw();
    },
    setTradeState: function(id, active, direction, entryPrice, secondsLeft, gwin) {
      var inst = instances[id];
      if (inst) inst._setTradeState(active, direction, entryPrice, secondsLeft, gwin);
    },
    /* Called directly from Dart signal engine — draws/clears entry line on ALL instances */
    setGlobalEntryLine: function(price, direction) {
      var hasLine = price != null && price !== 'null' && direction && direction !== 'null';
      Object.keys(instances).forEach(function(id) {
        var inst = instances[id];
        if (!inst) return;
        if (hasLine) {
          var t = inst.candles.length ? inst.candles[inst.candles.length - 1].t : null;
          inst._entryLine = { price: Number(price), direction: String(direction), t: t };
        } else {
          inst._entryLine = null;
        }
        inst._draw();
      });
    },
    /* Sync a sim price to ALL sim-mode instances — used by guaranteed-win nudge */
    updateAllSimPrice: function(price) {
      var p = Number(price);
      if (!p) return;
      Object.keys(instances).forEach(function(id) {
        var inst = instances[id];
        if (!inst || !inst.candles.length) return;
        var last = inst.candles[inst.candles.length - 1];
        last.c = p;
        if (p > last.h) last.h = p;
        if (p < last.l) last.l = p;
        inst._draw();
      });
    },
    /* Point data at a new proxy base URL (admin server switch). Reconnects EVERY
       live chart so the switch takes effect within seconds — no reload. Since the
       OTC data path now flows through the same proxy (/api/otc/* + /ws), OTC
       charts MUST be reconnected too — otherwise they stay pinned to the old
       proxy and their live price freezes. */
    setProxy: function(url) {
      if (!url || typeof url !== 'string') return;
      var clean = url.trim().replace(/\/+$/, '');
      if (!clean || clean === PROXY) return;
      PROXY = clean;
      Object.keys(instances).forEach(function(id) {
        var inst = instances[id];
        if (!inst) return;
        // Tear down all live connections/timers for this chart.
        try { if (inst._ws) inst._ws.close(); } catch (_) {}
        inst._ws = null;
        clearTimeout(inst._retryTimer);
        clearTimeout(inst._wsTimer);
        if (inst._priceTimer)      { clearInterval(inst._priceTimer);      inst._priceTimer = null; }
        if (inst._otcHistTimer) { clearInterval(inst._otcHistTimer); inst._otcHistTimer = null; }
        if (inst._otcPriceTimer){ clearInterval(inst._otcPriceTimer);inst._otcPriceTimer = null; }

        if (inst.mode === 'otc') {
          // Re-pull history + status + WS tick from the new proxy. Resetting
          // _otcHistLoaded lets the first fresh load batch-render and (re)start
          // the live WS tick via _startPriceTick().
          inst._otcHistLoaded = false;
          inst._otcPolling = false;
          inst._fetchOtcCandles();
          inst._startOtcStream();
        }
      });
    },
  };
})();

window.setUserBroker = function(broker) {
  window.userBroker = broker;
};
