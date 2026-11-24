// 回測 + 10,000 次蒙地卡羅模擬
// 用法：node stock-journal/scripts/backtest.js      （約 3～6 分鐘，產生 data/backtest.json）
//
// 做法：用過去約兩年的日 K，假裝每天早上執行一次「今日 10 檔」（和每日選股用同一套程式），
//      再用之後的真實走勢，照頁面上寫的進出場規則模擬每一筆交易的結果。
//
// 交易規則（和頁面上的說明一致）：
//   當沖：只在選出的隔天交易。突破型（dt1/dt3）價格穿過進場價才進場；回測型（dt2/dt4）碰到進場價才進場。
//         開盤就跳過進場價 → 不追，不交易。進場後：碰停損全出；到停利 1 出一半、剩下的停損移到成本；到停利 2 全出；
//         都沒碰到就收盤出場。
//         日 K 看不出同一天先碰停損還是停利，所以同時算「悲觀」（先碰停損）和「樂觀」（先碰停利）兩種，真實結果在兩者之間；
//         最近 60 天另外用 5 分 K 精算。
//   短線：掛單 3 天有效。進場後收盤跌破停損出場；到停利 1 出一半、停損移到成本；到停利 2 全出；
//         出一半後收盤跌破 10 日線出場；最多持有 20 個交易日。
//   成本：手續費 0.1425%（不打折，保守估計）× 2，證交稅 當沖 0.15% / 短線 0.3%。未計融資融券利息。
//
// 已知限制：
//   - 股票池用「現在」成交金額前 600 名，再每天依當時的 20 日均成交金額取前 300 名；已下市的股票不在裡面（倖存者偏差）
//   - 沒有歷史處置股、當沖資格資料
//   - 每天 10 筆交易視為依序發生（蒙地卡羅用固定 1% 風險複利）

const fs = require('fs');
const path = require('path');
const Core = require('../plan-core.js');
const L = require('./daily-picks.js');

const POOL = 600;
const UNIVERSE = 300;
const RANGE = '2y';
const ORDER_DAYS = 3;
const MAX_HOLD = 20;
// 手續費：國泰證券電子下單 2.8 折（可用 FEE_DISCOUNT=1 改回不打折）
const FEE_DISCOUNT = process.env.FEE_DISCOUNT ? +process.env.FEE_DISCOUNT : 0.28;
const FEE = 0.001425 * FEE_DISCOUNT, TAX_DT = 0.0015, TAX_SW = 0.003;
const RISK = 0.01;
const MC_RUNS = 10000;
const MC_TRADES = 100; // 每次模擬 100 筆交易（短線同時持有很多檔，用「一年」依序複利會高估）
let out_swingSide = null;
const OUT = path.join(__dirname, '..', 'data', 'backtest.json');

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const r2 = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d));

// ---------- 交易結算 ----------
function settle(p, entry, exits, tax, reason) {
  const long = p.side === 'long';
  let pnl = 0;
  for (const [x, w] of exits) {
    const sell = long ? x : entry;
    pnl += w * ((long ? x - entry : entry - x) - FEE * (entry + x) - tax * sell);
  }
  const risk = Math.abs(p.entry - p.stop);
  // fill = 實際進場價；exits = 每一次出場的價格和比例（例如停利 1 出一半、停利 2 出一半）
  return { status: 'filled', R: pnl / risk, ret: pnl / entry, reason, fill: entry,
    exits: exits.map(([x, w]) => ({ px: +x.toFixed(2), w })), exitPx: +exits.reduce((s2, [x, w]) => s2 + x * w, 0).toFixed(2) };
}

// 當沖（日 K）：mode = 'pess' 先碰停損 / 'opt' 先碰停利
function evalDayDaily(p, b, mode) {
  const long = p.side === 'long', E = p.entry, S = p.stop;
  const stopOrder = p.id === 'dt1' || p.id === 'dt3';
  if (long ? (stopOrder ? b.open >= E : b.open <= E) : (stopOrder ? b.open <= E : b.open >= E)) return { status: 'gap' };
  if (long ? (stopOrder ? b.high < E : b.low > E) : (stopOrder ? b.low > E : b.high < E)) return { status: 'nofill' };
  const adverse = long ? b.low <= S : b.high >= S;
  const fav = (v) => (long ? b.high >= v : b.low <= v);
  const beyond = long ? b.close > E : b.close < E;
  if (mode === 'pess') {
    if (adverse) return settle(p, E, [[S, 1]], TAX_DT, 'stop');
    if (fav(p.t2)) return settle(p, E, [[p.t1, 0.5], [p.t2, 0.5]], TAX_DT, 't2');
    if (fav(p.t1)) return settle(p, E, [[p.t1, 0.5], [beyond ? b.close : E, 0.5]], TAX_DT, 't1');
    return settle(p, E, [[b.close, 1]], TAX_DT, 'close');
  }
  if (fav(p.t2)) return settle(p, E, [[p.t1, 0.5], [p.t2, 0.5]], TAX_DT, 't2');
  if (fav(p.t1)) return settle(p, E, [[p.t1, 0.5], [adverse || !beyond ? E : b.close, 0.5]], TAX_DT, 't1');
  if (adverse) return settle(p, E, [[S, 1]], TAX_DT, 'stop');
  return settle(p, E, [[b.close, 1]], TAX_DT, 'close');
}

// 當沖（5 分 K 精算）
function evalDayIntraday(p, bars5) {
  const long = p.side === 'long', E = p.entry;
  const stopOrder = p.id === 'dt1' || p.id === 'dt3';
  const open = bars5[0].open;
  if (long ? (stopOrder ? open >= E : open <= E) : (stopOrder ? open <= E : open >= E)) return { status: 'gap' };
  let filled = false, half = false, stop = p.stop;
  const exits = [];
  const adverse = (b) => (long ? b.low <= stop : b.high >= stop);
  const fav = (b, v) => (long ? b.high >= v : b.low <= v);
  for (let k = 0; k < bars5.length; k++) {
    const b = bars5[k];
    if (!filled) {
      const hit = stopOrder ? (long ? b.high >= E : b.low <= E) : (long ? b.low <= E : b.high >= E);
      if (!hit) continue;
      filled = true;
      // 進場的那根 K 棒：只有收盤已經跌破停損才算停損（避免把進場前的低點算進去）
      if (long ? b.close <= stop : b.close >= stop) return settle(p, E, [[stop, 1]], TAX_DT, 'stop');
      continue;
    }
    if (adverse(b)) { exits.push([stop, half ? 0.5 : 1]); return settle(p, E, exits, TAX_DT, half ? 'breakeven' : 'stop'); }
    if (!half && fav(b, p.t1)) { exits.push([p.t1, 0.5]); half = true; stop = E; }
    if (half && fav(b, p.t2)) { exits.push([p.t2, 0.5]); return settle(p, E, exits, TAX_DT, 't2'); }
  }
  if (!filled) return { status: 'nofill' };
  exits.push([bars5[bars5.length - 1].close, half ? 0.5 : 1]);
  return settle(p, E, exits, TAX_DT, half ? 't1' : 'close');
}

// 短線（日 K）
function evalSwing(p, bars, jn) {
  const long = p.side === 'long', E = p.entry, S = p.stop;
  const limitOrder = p.id === 'sw1' || p.id === 'sw3';
  let f = -1, fill = null;
  for (let k = jn; k < Math.min(bars.length, jn + ORDER_DAYS); k++) {
    const b = bars[k];
    if (limitOrder) {
      if (long ? b.open <= E : b.open >= E) fill = b.open;
      else if (long ? b.low <= E : b.high >= E) fill = E;
    } else {
      if (long ? b.open >= E : b.open <= E) fill = b.open;
      else if (long ? b.high >= E : b.low <= E) fill = E;
    }
    if (fill != null) { f = k; break; }
  }
  if (f < 0) return bars.length < jn + ORDER_DAYS ? { status: 'waiting' } : { status: 'nofill' };
  // 跳空直接越過停損或停利：不進場
  if (long ? fill <= S || fill >= p.t1 : fill >= S || fill <= p.t1) return { status: 'gap' };
  const closes = bars.map((b) => b.close);
  const ma10 = (k) => (k >= 9 ? avg(closes.slice(k - 9, k + 1)) : null);
  let half = false, stop = S;
  const exits = [];
  for (let k = f; k < bars.length; k++) {
    const b = bars[k];
    if (k > f) {
      if (!half && (long ? b.high >= p.t1 : b.low <= p.t1)) {
        exits.push([long ? Math.max(b.open, p.t1) : Math.min(b.open, p.t1), 0.5]); half = true; stop = fill;
      }
      if (half && (long ? b.high >= p.t2 : b.low <= p.t2)) {
        exits.push([long ? Math.max(b.open, p.t2) : Math.min(b.open, p.t2), 0.5]);
        return { ...settle(p, fill, exits, TAX_SW, 't2'), hold: k - f };
      }
    }
    const rest = half ? 0.5 : 1;
    if (long ? b.close < stop : b.close > stop) {
      exits.push([b.close, rest]);
      return { ...settle(p, fill, exits, TAX_SW, half ? 'breakeven' : 'stop'), hold: k - f };
    }
    const m = ma10(k);
    if (half && m && (long ? b.close < m : b.close > m)) {
      exits.push([b.close, 0.5]);
      return { ...settle(p, fill, exits, TAX_SW, 'ma10'), hold: k - f };
    }
    if (k === f + MAX_HOLD) {
      exits.push([b.close, rest]);
      return { ...settle(p, fill, exits, TAX_SW, 'time'), hold: k - f };
    }
  }
  // 資料還沒走完：持有中，用最新收盤價估算未實現損益（回測統計不計入）
  const last = bars[bars.length - 1];
  return { ...settle(p, fill, [...exits, [last.close, half ? 0.5 : 1]], TAX_SW, 'open'), status: 'open', fill, half, lastClose: last.close, hold: bars.length - 1 - f };
}

// ---------- 統計 ----------
function stats(list) {
  const all = list.length;
  const f = list.filter((t) => t.status === 'filled');
  const n = f.length;
  if (!n) return { signals: all, n: 0 };
  const wins = f.filter((t) => t.R > 0), losses = f.filter((t) => t.R <= 0);
  const sumW = wins.reduce((s, t) => s + t.R, 0), sumL = losses.reduce((s, t) => s + t.R, 0);
  return {
    signals: all, n, fillRate: r2((n / all) * 100, 0),
    winRate: r2((wins.length / n) * 100, 1),
    avgWinR: wins.length ? r2(sumW / wins.length) : null,
    avgLossR: losses.length ? r2(sumL / losses.length) : null,
    expR: r2((sumW + sumL) / n, 3),
    expRet: r2(avg(f.map((t) => t.ret)) * 100, 3),
    pf: sumL ? r2(sumW / -sumL) : null,
    hold: f[0].hold != null ? r2(avg(f.map((t) => t.hold || 0)), 1) : undefined,
  };
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pctl = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))];

// 蒙地卡羅：從回測交易中隨機抽（可重複）100 筆交易，每筆冒 1% 本金風險，重複 10,000 次
function monteCarlo(Rs, seed = 42) {
  if (Rs.length < 20) return null;
  const rnd = mulberry32(seed);
  const finals = [], mdds = [], means = [];
  const n = MC_TRADES;
  for (let r = 0; r < MC_RUNS; r++) {
    let eq = 1, peak = 1, mdd = 0, sum = 0;
    for (let k = 0; k < n; k++) {
      const R = Rs[Math.floor(rnd() * Rs.length)];
      sum += R;
      eq *= Math.max(0, 1 + RISK * R);
      if (eq > peak) peak = eq;
      mdd = Math.max(mdd, 1 - eq / peak);
    }
    finals.push(eq - 1); mdds.push(mdd); means.push(sum / n);
  }
  finals.sort((a, b) => a - b); mdds.sort((a, b) => a - b);
  // 優勢機率：用「實際交易筆數」重抽 10,000 次，平均 R > 0 的比例（自助法），越接近 100% 越不像運氣
  let edge = 0;
  for (let r = 0; r < MC_RUNS; r++) {
    let sum = 0;
    for (let k = 0; k < Rs.length; k++) sum += Rs[Math.floor(rnd() * Rs.length)];
    if (sum > 0) edge++;
  }
  const P = (v) => r2(v * 100, 1);
  return {
    runs: MC_RUNS, trades: n,
    ret: { p5: P(pctl(finals, 5)), p25: P(pctl(finals, 25)), p50: P(pctl(finals, 50)), p75: P(pctl(finals, 75)), p95: P(pctl(finals, 95)) },
    mdd: { p50: P(pctl(mdds, 50)), p95: P(pctl(mdds, 95)) },
    probLoss: P(finals.filter((x) => x < 0).length / MC_RUNS),
    probDD20: P(mdds.filter((x) => x > 0.2).length / MC_RUNS),
    probEdge: P(edge / MC_RUNS), sampleN: Rs.length,
  };
}

// 「贏過隨便買」的把握：每筆報酬扣掉同期間隨便買的平均報酬後，用實際筆數重抽 10,000 次，平均仍大於 0 的比例
function probBeat(rets, base, seed = 7) {
  if (rets.length < 20) return null;
  const rnd = mulberry32(seed), ex = rets.map((r) => r - base);
  let win = 0;
  for (let r = 0; r < MC_RUNS; r++) {
    let sum = 0;
    for (let k = 0; k < ex.length; k++) sum += ex[Math.floor(rnd() * ex.length)];
    if (sum > 0) win++;
  }
  return r2((win / MC_RUNS) * 100, 1);
}

// ---------- 主程式 ----------
// 當沖「開盤 30 分鐘突破法」：用 09:00～09:30（前 6 根 5 分 K）的最高、最低價當區間，
// 之後往上突破最高價就做多、往下跌破最低價就做空；停損在區間另一邊，
// 停利 1 = 1 倍區間（出一半，停損移到成本）、停利 2 = 2 倍區間，都沒碰到就收盤出場。
// 區間太寬（> 1.2 個 ATR）或太窄（< 0.15 個 ATR）不做；12:30 以後不再進場。
function evalOrb(bars, atr, n = 6, { longOnly = false } = {}) {
  if (!bars || bars.length < n + 6) return { status: 'waiting' };
  const H = Math.max(...bars.slice(0, n).map((b) => b.high)), L = Math.min(...bars.slice(0, n).map((b) => b.low));
  const range = H - L;
  if (!(atr > 0) || range > 1.2 * atr || range < 0.15 * atr) return { status: 'skip', H, L };
  for (let k = n; k < Math.min(bars.length, 42); k++) {
    const b = bars[k], up = b.high >= H, dn = !longOnly && b.low <= L; // longOnly：禁空令期間只做多
    if (!up && !dn) continue;
    const long = up && (!dn || b.open >= (H + L) / 2);
    const entry = long ? Math.max(b.open, H) : Math.min(b.open, L), stop0 = long ? L : H;
    const p = { side: long ? 'long' : 'short', entry, stop: stop0 };
    const R0 = Math.abs(entry - stop0), t1 = long ? entry + R0 : entry - R0, t2 = long ? entry + 2 * R0 : entry - 2 * R0;
    const exits = []; let half = false, stop = stop0;
    const extra = { side: p.side, H, L, stop: stop0, t1, t2 };
    if (long ? b.close <= stop : b.close >= stop) return { ...settle(p, entry, [[stop, 1]], TAX_DT, 'stop'), ...extra };
    for (let j = k + 1; j < bars.length; j++) {
      const c = bars[j];
      if (long ? c.low <= stop : c.high >= stop) { exits.push([stop, half ? 0.5 : 1]); return { ...settle(p, entry, exits, TAX_DT, half ? 'breakeven' : 'stop'), ...extra }; }
      if (!half && (long ? c.high >= t1 : c.low <= t1)) { exits.push([t1, 0.5]); half = true; stop = entry; }
      if (half && (long ? c.high >= t2 : c.low <= t2)) { exits.push([t2, 0.5]); return { ...settle(p, entry, exits, TAX_DT, 't2'), ...extra }; }
    }
    exits.push([bars[bars.length - 1].close, half ? 0.5 : 1]);
    return { ...settle(p, entry, exits, TAX_DT, half ? 't1' : 'close'), ...extra };
  }
  return { status: 'nofill', H, L };
}

module.exports = { evalDayDaily, evalDayIntraday, evalSwing, evalOrb, stats, monteCarlo, FEE_DISCOUNT };

if (require.main === module) (async () => {
  const t0 = Date.now();
  const universe = await L.loadUniverse(POOL);
  console.log(`下載 ${universe.length} 檔股票 ${RANGE} 日 K…`);
  const loaded = await L.mapLimit(universe, 6, async (s) => {
    const bars = await L.loadBars(`${s.code}.${s.market === '上市' ? 'TW' : 'TWO'}`, RANGE);
    return bars.length >= 150 ? { ...s, bars, idx: new Map(bars.map((b, i) => [b.date, i])) } : null;
  });
  const stocks = loaded.filter(Boolean);
  const twii = await L.loadTaiex(RANGE);
  const us = {};
  for (const [sym] of L.US_SYMBOLS) us[sym] = await L.loadBars(sym, RANGE);
  console.log(`取得 ${stocks.length} 檔，加權指數 ${twii.length} 天（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);

  const START = 130; // 前 130 天只用來算指標
  const trades = [];
  const usPtr = {};
  for (const [sym] of L.US_SYMBOLS) usPtr[sym] = 0;
  let usDays = 0;
  // 基準：同一個股票池「隨便買」，隔天開盤買進、持有 10 天收盤賣出（扣成本）
  const base = { long: [], short: [] };

  for (let i = START; i < twii.length - 1; i++) {
    const D = twii[i].date, N = twii[i + 1].date;
    // 當天收盤時的指標，依 20 日均成交金額取前 300 名
    const day = [];
    for (const s of stocks) {
      const j = s.idx.get(D);
      if (j == null || j < 70) continue;
      day.push({ code: s.code, name: s.name, market: s.market, disposal: false, s, j, x: Core.indicators(s.bars.slice(Math.max(0, j - 129), j + 1)) });
    }
    day.sort((a, b) => b.x.value20 - a.x.value20);
    const top = day.slice(0, UNIVERSE);

    // 美股預測：只用下一個台股交易日之前的美股資料
    const series = {};
    for (const [sym] of L.US_SYMBOLS) {
      const b = us[sym];
      while (usPtr[sym] < b.length && b[usPtr[sym]].date < N) usPtr[sym]++;
      series[sym] = b.slice(Math.max(0, usPtr[sym] - 150), usPtr[sym]);
    }
    const pred = L.usPredict(twii.slice(Math.max(0, i - 80), i + 1), series);
    const bias = pred.available && Math.abs(pred.predGap) >= 0.3 ? pred.predGap : 0;
    if (pred.available) usDays++;

    for (const t of top) {
      const jn = t.s.idx.get(N);
      if (jn == null || jn + 9 >= t.s.bars.length) continue;
      const o = t.s.bars[jn].open, c = t.s.bars[jn + 9].close;
      base.long.push((c - o - FEE * (o + c) - TAX_SW * c) / o);
      base.short.push((o - c - FEE * (o + c) - TAX_SW * o) / o);
    }
    for (const variant of ['us', 'nous']) {
      const b = variant === 'us' ? bias : 0;
      const cands = [];
      for (const t of top) for (const c of L.screen(t, t.x, b)) cands.push({ ...c, code: t.code, t });
      const planOf = (c) => (c.kind === 'daytrade' ? Core.dayTradePlans(c.t.x, c.code).plans : Core.swingPlans(c.t.x, c.code).plans).find((q) => q.id === c.planId);
      const valid = cands.filter((c) => { const p = planOf(c); return p && p.valid; });
      for (const c of L.choose(valid)) {
        const p = planOf(c), s = c.t.s, jn = s.idx.get(N);
        if (jn == null) continue; // 隔天沒交易（停牌）
        const base = { date: N, code: c.code, name: c.t.name, kind: c.kind, setup: p.id, label: p.label, side: p.side, variant, plan: p };
        if (c.kind === 'daytrade') {
          const pe = evalDayDaily(p, s.bars[jn], 'pess'), op = evalDayDaily(p, s.bars[jn], 'opt');
          trades.push({ ...base, ...pe, opt: op });
        } else {
          trades.push({ ...base, ...evalSwing(p, s.bars, jn) });
        }
      }
    }
    if ((i - START) % 50 === 0) console.log(`  模擬到 ${D}，累計 ${trades.length} 個訊號`);
  }
  const from = twii[START + 1].date, to = twii[twii.length - 1].date;
  const years = (twii.length - 1 - START) / 245;
  console.log(`模擬完成：${from} ~ ${to}，${trades.length} 個訊號（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);

  // ---------- 當沖最近 60 天：5 分 K 精算 ----------
  const dtUs = trades.filter((t) => t.variant === 'us' && t.kind === 'daytrade');
  const cutoff = new Date(Date.now() - 57 * 86400000).toISOString().slice(0, 10);
  const recent = dtUs.filter((t) => t.date >= cutoff);
  const intraday = {};
  await L.mapLimit([...new Set(recent.map((t) => t.code))], 4, async (code) => {
    const s = stocks.find((x) => x.code === code);
    const j = await L.getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.${s.market === '上市' ? 'TW' : 'TWO'}?interval=5m&range=60d`);
    const res = j.chart.result[0], q = res.indicators.quote[0], byDate = {};
    res.timestamp.forEach((ts, k) => {
      if ([q.open[k], q.high[k], q.low[k], q.close[k]].some((v) => v == null)) return;
      const d = new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
      (byDate[d] = byDate[d] || []).push({ open: q.open[k], high: q.high[k], low: q.low[k], close: q.close[k] });
    });
    intraday[code] = byDate;
  });
  const intra = [], intraOrb = [];
  for (const t of recent) {
    const b5 = intraday[t.code] && intraday[t.code][t.date];
    if (!b5 || b5.length < 20) continue;
    intra.push({ ...t, ...evalDayIntraday(t.plan, b5) });
    intraOrb.push({ ...t, ...evalOrb(b5, Math.abs(t.plan.entry - t.plan.stop) / 0.3) });
  }
  // 研究用：DUMP_TRADES=檔名 時，把最近 60 天當沖選股和當天 5 分 K 存下來，給其他當沖方法比較
  if (process.env.DUMP_TRADES) {
    fs.writeFileSync(process.env.DUMP_TRADES, JSON.stringify(recent.filter((t) => intraday[t.code] && intraday[t.code][t.date])
      .map((t) => ({ date: t.date, code: t.code, name: t.name, side: t.side, setup: t.setup, plan: t.plan, bars: intraday[t.code][t.date] }))));
  }

  // ---------- 彙整 ----------
  const sel = (o) => trades.filter((t) => Object.entries(o).every(([k, v]) => t[k] === v));
  const asOpt = (list) => list.map((t) => ({ ...t, ...t.opt }));
  const mid = trades.length ? [...new Set(trades.map((t) => t.date))].sort()[Math.floor(new Set(trades.map((t) => t.date)).size / 2)] : null;
  const kinds = ['daytrade', 'swing'];
  const summary = {};
  for (const variant of ['us', 'nous']) {
    summary[variant] = {};
    for (const kind of kinds) {
      const list = sel({ variant, kind });
      summary[variant][kind] = kind === 'daytrade' ? { pess: stats(list), opt: stats(asOpt(list)) } : stats(list);
    }
  }
  const SETUPS = { dt1: '做多・突破', dt2: '做多・回測支撐', dt3: '做空・跌破', dt4: '做空・反彈遇壓', sw1: '做多・拉回買', sw2: '做多・突破買', sw3: '做空・反彈空', sw4: '做空・跌破空' };
  const setups = Object.entries(SETUPS).map(([id, label]) => {
    const list = sel({ variant: 'us', setup: id });
    const kind = id.startsWith('dt') ? 'daytrade' : 'swing';
    const st = stats(list);
    const Rs = list.filter((t) => t.status === 'filled').map((t) => t.R);
    const mc = monteCarlo(Rs);
    return {
      id, label, kind, stats: st, opt: kind === 'daytrade' ? stats(asOpt(list)) : null,
      first: stats(list.filter((t) => t.date < mid)), second: stats(list.filter((t) => t.date >= mid)),
      probEdge: mc ? mc.probEdge : null,
      // 短線：和同期間隨便買（做多用做多基準、做空用做空基準）相比
      probBeat: kind === 'swing' ? probBeat(list.filter((t) => t.status === 'filled').map((t) => t.ret), (list[0] && list[0].side === 'short' ? avg(base.short) : avg(base.long))) : null,
    };
  });
  const mcFor = (list) => { const Rs = list.filter((t) => t.status === 'filled').map((t) => t.R); return monteCarlo(Rs); };
  // 當沖用最近 60 天 5 分 K 精算的結果（日 K 分不出先停損還是先停利）；短線用全部回測
  const swingList = sel({ variant: 'us', kind: 'swing' });
  const montecarlo = {
    daytrade: mcFor(intra),
    swing: mcFor(swingList),
    all: mcFor([...swingList, ...intra]),
  };
  out_swingSide = { long: stats(sel({ variant: 'us', kind: 'swing', side: 'long' })), short: stats(sel({ variant: 'us', kind: 'swing', side: 'short' })) };
  const sameDaily = recent.filter((t) => intra.some((x) => x.code === t.code && x.date === t.date));
  const out = {
    generatedAt: new Date().toISOString(),
    period: { from, to, days: twii.length - 1 - START, years: r2(years), mid, usDays },
    settings: { feeDiscount: FEE_DISCOUNT, pool: POOL, universe: UNIVERSE, fee: +(FEE * 100).toFixed(4), taxDayTrade: +(TAX_DT * 100).toFixed(2), taxSwing: +(TAX_SW * 100).toFixed(2), risk: RISK * 100, mcRuns: MC_RUNS, orderDays: ORDER_DAYS, maxHold: MAX_HOLD },
    summary, setups, montecarlo, swingSide: out_swingSide,
    swingBeat: probBeat(sel({ variant: 'us', kind: 'swing', side: 'long' }).filter((t) => t.status === 'filled').map((t) => t.ret), avg(base.long)),
    baseline: { hold: 10, longRet: r2(avg(base.long) * 100, 3), shortRet: r2(avg(base.short) * 100, 3), longWin: r2(base.long.filter((x) => x > 0).length / base.long.length * 100, 1), n: base.long.length },
    intraday: intra.length ? {
      from: cutoff, n: intra.length,
      exact: stats(intra), dailyPess: stats(sameDaily), dailyOpt: stats(asOpt(sameDaily)),
      exactEdge: (monteCarlo(intra.filter((t) => t.status === 'filled').map((t) => t.R)) || {}).probEdge ?? null,
      orb: stats(intraOrb),
      orbEdge: (monteCarlo(intraOrb.filter((t) => t.status === 'filled').map((t) => t.R)) || {}).probEdge ?? null,
    } : null,
    reasons: Object.fromEntries(kinds.map((k) => [k, sel({ variant: 'us', kind: k }).filter((t) => t.status === 'filled')
      .reduce((m, t) => ((m[t.reason] = (m[t.reason] || 0) + 1), m), {})])),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

  // ---------- 印出重點 ----------
  const line = (name, s) => console.log(`  ${name.padEnd(10)} 訊號 ${s.signals} 成交 ${s.n}（${s.fillRate}%）勝率 ${s.winRate}% 平均賺 ${s.avgWinR}R 平均賠 ${s.avgLossR}R 期望值 ${s.expR}R（${s.expRet}%）PF ${s.pf}`);
  console.log(`\n回測期間 ${from} ~ ${to}（${r2(years)} 年），美股預測可用 ${usDays} 天`);
  for (const v of ['us', 'nous']) {
    console.log(v === 'us' ? '【有美股加權（目前上線的版本）】' : '【不參考美股】');
    line('當沖-悲觀', summary[v].daytrade.pess); line('當沖-樂觀', summary[v].daytrade.opt); line('短線', summary[v].swing);
  }
  console.log('【各情境】');
  for (const s of setups) if (s.stats.n) line(`${s.id} ${s.label}`, s.stats);
  console.log('【前半 vs 後半 期望值 R】');
  for (const s of setups) if (s.stats.n) console.log(`  ${s.id} ${s.label}：${s.first.expR} → ${s.second.expR}（n ${s.first.n} / ${s.second.n}），P(優勢) ${s.probEdge}%，贏過隨便買的把握 ${s.probBeat ?? '-'}%`);
  console.log(`短線做多整體贏過隨便買的把握：${out.swingBeat}%`);
  if (out.intraday) {
    console.log(`【當沖最近 60 天 5 分 K 精算】n=${out.intraday.n}`);
    line('5分K', out.intraday.exact); line('開盤30分突破', out.intraday.orb);
    console.log(`  不是運氣的機率：原本方法 ${out.intraday.exactEdge}%、開盤30分突破 ${out.intraday.orbEdge}%`); line('日K悲觀', out.intraday.dailyPess); line('日K樂觀', out.intraday.dailyOpt);
  }
  console.log(`【基準：隨便買進持有 10 天】做多平均 ${out.baseline.longRet}%（勝率 ${out.baseline.longWin}%），做空平均 ${out.baseline.shortRet}%`);
  console.log('【蒙地卡羅 10,000 次（每筆風險 1%）】');
  for (const [k, m] of Object.entries(montecarlo)) if (m) console.log(`  ${k}：每 ${m.trades} 筆，報酬 中位數 ${m.ret.p50}%（5%~95%：${m.ret.p5}% ~ ${m.ret.p95}%），虧損機率 ${m.probLoss}%，最大回撤 中位 ${m.mdd.p50}% / 最差 5% ${m.mdd.p95}%，P(優勢) ${m.probEdge}%`);
  console.log(`完成，耗時 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
})().catch((e) => { console.error(e); process.exit(1); });
