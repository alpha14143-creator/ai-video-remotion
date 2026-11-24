// 台股進出場價格計算核心：網頁（瀏覽器）和每日選股腳本（Node.js）共用
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const isEtf = (code) => /^00/.test(code);

  // 台股升降單位（2024 起 ETF 50 元以上為 0.05）
  function tickOf(p, etf) {
    if (etf) return p < 50 ? 0.01 : 0.05;
    return p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
  }
  function roundTick(p, etf, mode = 'near') {
    const t = tickOf(p, etf);
    const f = mode === 'up' ? Math.ceil : mode === 'down' ? Math.floor : Math.round;
    return +(f(+(p / t).toFixed(6)) * t).toFixed(2);
  }
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const r2 = (v) => (v == null ? null : +v.toFixed(2));

  // bars: [{date, open, high, low, close, vol(張)}]，舊到新
  function indicators(bars) {
    const C = bars.map((b) => b.close), n = bars.length;
    const ma = (k, end = n) => (end >= k ? avg(C.slice(end - k, end)) : null);
    const tr = bars.map((b, i) => i
      ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
      : b.high - b.low);
    let gain = 0, loss = 0;
    for (let i = Math.max(1, n - 14); i < n; i++) { const d = C[i] - C[i - 1]; d > 0 ? (gain += d) : (loss -= d); }
    const hi = (k, end = n) => Math.max(...bars.slice(Math.max(0, end - k), end).map((b) => b.high));
    const lo = (k, end = n) => Math.min(...bars.slice(Math.max(0, end - k), end).map((b) => b.low));
    const pick = (b) => b && { date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, vol: b.vol };
    return {
      n,
      last: pick(bars[n - 1]), prev: pick(bars[n - 2]),
      ma5: r2(ma(5)), ma10: r2(ma(10)), ma20: r2(ma(20)), ma60: r2(ma(60)), ma20Prev: r2(ma(20, n - 5)),
      atr: r2(avg(tr.slice(-14))),
      rsi: +(gain + loss ? (gain / (gain + loss)) * 100 : 50).toFixed(1),
      hh20: hi(20), ll20: lo(20), hh10: hi(10), ll10: lo(10),
      hh20Prev: n > 20 ? hi(20, n - 1) : null, ll20Prev: n > 20 ? lo(20, n - 1) : null, // 不含今天的 20 日高低
      vol5: Math.round(avg(bars.slice(-5).map((b) => b.vol))),
      vol20: Math.round(avg(bars.slice(-20).map((b) => b.vol))),
      value20: Math.round(avg(bars.slice(-20).map((b) => b.vol * b.close * 1000))), // 20 日平均成交金額（元）
    };
  }

  function trendOf(x) {
    if (!x.ma20 || !x.ma60) return { key: 'mid', text: '資料不足' };
    const c = x.last.close;
    if (c > x.ma20 && x.ma20 > x.ma60 && x.ma20 >= x.ma20Prev) return { key: 'up', text: '多頭（收盤 > 月線 > 季線，月線向上）' };
    if (c < x.ma20 && x.ma20 < x.ma60 && x.ma20 <= x.ma20Prev) return { key: 'down', text: '空頭（收盤 < 月線 < 季線，月線向下）' };
    return { key: 'mid', text: '盤整（均線糾結）' };
  }

  function limits(x, code) {
    const etf = isEtf(code), C = x.last.close;
    return { up: roundTick(C * 1.1, etf, 'down'), down: roundTick(C * 0.9, etf, 'up') };
  }

  function pivots(x) {
    const L = x.last, P = (L.high + L.low + L.close) / 3;
    return { P, R1: 2 * P - L.low, S1: 2 * P - L.high, R2: P + (L.high - L.low), S2: P - (L.high - L.low) };
  }

  function finalize(p, etf, lim) {
    const up = p.side === 'long';
    const clamp = (v) => (lim ? Math.min(Math.max(v, lim.down), lim.up) : v);
    p.entry = clamp(roundTick(p.entry, etf));
    p.stop = clamp(roundTick(p.stop, etf, up ? 'down' : 'up'));
    p.t1 = clamp(roundTick(p.t1, etf, up ? 'down' : 'up'));
    p.t2 = clamp(roundTick(p.t2, etf, up ? 'down' : 'up'));
    p.valid = up ? p.stop < p.entry && p.t1 > p.entry : p.stop > p.entry && p.t1 < p.entry;
    p.rr = p.valid ? +(Math.abs(p.t1 - p.entry) / Math.abs(p.entry - p.stop)).toFixed(2) : null;
    return p;
  }

  // 當沖：樞紐點決定進場位置，ATR 決定停損 / 停利距離
  function dayTradePlans(x, code) {
    const etf = isEtf(code), A = x.atr, C = x.last.close, lim = limits(x, code);
    const { P, R1, S1, R2, S2 } = pivots(x);
    const tr = trendOf(x);
    const bias = tr.key === 'up' ? 'long' : tr.key === 'down' ? 'short' : null;
    const rec = (side) => (!bias ? 'mid' : side === bias ? 'good' : 'bad');
    const f = (v) => roundTick(v, etf).toLocaleString('zh-TW', { minimumFractionDigits: 2 });
    const d = 0.3 * A, g1 = 0.5 * A, g2 = 1.0 * A;
    const warnings = [];
    if (x.vol20 != null && x.vol20 < 1000) warnings.push('日均量不到 1000 張，流動性差，不建議當沖');
    if (A / C < 0.015) warnings.push('每日波動小於 1.5%，扣掉成本後利潤很薄');
    const plans = [
      { id: 'dt1', label: '做多・突破', side: 'long', when: `價格站上 ${f(R1)}（壓力位）並且量增時買進`, entry: R1, stop: R1 - d, t1: R1 + g1, t2: Math.max(R1 + g2, R2) },
      { id: 'dt2', label: '做多・回測支撐', side: 'long', when: `拉回到 ${f(S1)}（支撐位）附近止跌、出現紅 K 時買進`, entry: S1, stop: S1 - d, t1: S1 + g1, t2: Math.max(S1 + g2, P) },
      { id: 'dt3', label: '做空・跌破', side: 'short', when: `價格跌破 ${f(S1)}（支撐位）並且量增時先賣（需有先賣後買資格）`, entry: S1, stop: S1 + d, t1: S1 - g1, t2: Math.min(S1 - g2, S2) },
      { id: 'dt4', label: '做空・反彈遇壓', side: 'short', when: `反彈到 ${f(R1)}（壓力位）過不去、出現黑 K 時先賣`, entry: R1, stop: R1 + d, t1: R1 - g1, t2: Math.min(R1 - g2, P) },
    ].map((p) => finalize({ ...p, type: 'daytrade', rec: rec(p.side) }, etf, lim));
    return {
      bias, warnings, plans,
      pivots: { R2: roundTick(R2, etf), R1: roundTick(R1, etf), P: roundTick(P, etf), S1: roundTick(S1, etf), S2: roundTick(S2, etf) },
    };
  }

  // 短線：均線趨勢 + 近期高低點 + ATR
  function swingPlans(x, code) {
    if (!x.ma60) return null;
    const etf = isEtf(code), A = x.atr, C = x.last.close, tick = tickOf(C, etf);
    const tr = trendOf(x);
    const rec = (side) => (tr.key === 'mid' ? 'mid' : (tr.key === 'up') === (side === 'long') ? 'good' : 'bad');
    const f = (v) => (+v).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // 停損距離：1～3 個 ATR，且最多不超過進場價的 8%
    const build = (id, label, side, when, e, structStop) => {
      const dir = side === 'long' ? 1 : -1;
      const hi = Math.min(3 * A, e * 0.08), lo = Math.min(A, hi);
      const R = Math.min(Math.max(Math.abs(e - structStop), lo), hi);
      return finalize({ id, label, side, type: 'swing', rec: rec(side), when, entry: e, stop: e - dir * R, t1: e + dir * 2 * R, t2: e + dir * 3 * R }, etf, null);
    };
    const far = (lvl) => (Math.abs(lvl - C) > 2 * A ? '（離現價較遠，先觀察）' : '');
    const pbL = x.ma10 < C ? Math.max(x.ma10, C - 1.5 * A) : C;
    const pbS = x.ma10 > C ? Math.min(x.ma10, C + 1.5 * A) : C;
    const warnings = [];
    if (x.rsi > 75) warnings.push('RSI 過熱，追價要小心');
    if (x.rsi < 25) warnings.push('RSI 超賣，追空要小心');
    if (A / C > 0.04) warnings.push('近期每日波動超過 4%，停損已限制在 8%，建議部位減半');
    return {
      trend: tr, warnings,
      plans: [
        build('sw1', '做多・拉回買', 'long', x.ma10 < C
          ? `拉回到 10 日線附近 ${f(roundTick(pbL, etf))} 不破時分批買進`
          : `目前在 10 日線（${f(x.ma10)}）下方，等收盤站回 10 日線再買；價格是用現價算的參考`, pbL, x.ll10 - tick),
        build('sw2', '做多・突破買', 'long', `收盤站上 20 日高點 ${f(x.hh20)} 時買進${far(x.hh20)}`, x.hh20 + tickOf(x.hh20, etf), x.ll10 - tick),
        build('sw3', '做空・反彈空', 'short', x.ma10 > C
          ? `反彈到 10 日線附近 ${f(roundTick(pbS, etf))} 過不去時融券賣出`
          : `目前在 10 日線（${f(x.ma10)}）上方，等收盤跌破 10 日線再空；價格是用現價算的參考`, pbS, x.hh10 + tick),
        build('sw4', '做空・跌破空', 'short', `收盤跌破 20 日低點 ${f(x.ll20)} 時融券賣出${far(x.ll20)}`, x.ll20 - tickOf(x.ll20, etf), x.hh10 + tick),
      ],
    };
  }

  return { isEtf, tickOf, roundTick, indicators, trendOf, limits, pivots, dayTradePlans, swingPlans };
});
