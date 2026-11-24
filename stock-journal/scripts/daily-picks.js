// 每日選股：每天早上 7:40（美股收盤後、台股開盤前）執行，產生
//   data/picks.json    今日 10 檔 + 美股夜盤與台股開盤預測
//   data/snapshot.json 熱門股指標快照（給「查價格」用）
// 用法：node stock-journal/scripts/daily-picks.js        （Node.js 18 以上，不用安裝套件）
//
// 流程：
//   1. 從證交所 / 櫃買中心 OpenAPI 取得全部上市櫃股票的成交金額，取前 UNIVERSE 名，排除處置股
//   2. 從 Yahoo Finance 抓每檔近 6 個月日 K，計算均線、ATR、RSI…
//   3. 抓美股（費半、那斯達克、標普、道瓊、台積電 ADR），用過去一年資料算出「美股漲跌 → 台股開盤跳空」的關係，
//      預測今天台股開盤方向
//   4. 篩出適合當沖、短線的股票並評分（和美股方向一致的加分），取當沖 5 檔 + 短線 5 檔

const fs = require('fs');
const path = require('path');
const Core = require('../plan-core.js');

const UNIVERSE = 300;
// 禁空令：金管會 2026/11/23 起全面禁止平盤以下融券、借券賣出。期間內不推薦進場價低於昨收的做空。
// 解除後改成 false（或執行時加 SHORT_BAN=0）
const SHORT_BAN = process.env.SHORT_BAN ? process.env.SHORT_BAN !== '0' : true;
const N_DAYTRADE = 5;
const N_SWING = 5;
const OUT_DIR = process.env.PICKS_OUT_DIR || path.join(__dirname, '..', 'data'); // 測試時可指定別的資料夾
// 測試用：ASOF=2026-11-19 node daily-picks.js 會假裝現在是那天，只印結果不寫檔
const ASOF = process.env.ASOF || null;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; stock-journal/1.0)' };
const US_SYMBOLS = [
  ['^SOX', '費城半導體'],
  ['^IXIC', '那斯達克'],
  ['^GSPC', '標普 500'],
  ['^DJI', '道瓊'],
  ['TSM', '台積電 ADR'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => parseFloat(String(s ?? '').replace(/,/g, ''));
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;

async function getJson(url, tries = 3, timeout = 30000) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${url} → ${e.message}`);
      await sleep(1000 * i);
    }
  }
}

// ---------- 1. 股票池 ----------
let ALL_STOCKS = []; // 全部上市櫃股票的代號和名稱（給「查價格」用名稱搜尋）
async function loadUniverse(n = UNIVERSE) {
  const [twse, tpex] = (await Promise.allSettled([
    getJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', 3, 90000),
    getJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', 3, 90000),
  ])).map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`${i ? '上櫃' : '上市'}清單讀取失敗：`, r.reason.message);
    return [];
  });
  if (!twse.length && !tpex.length) throw new Error('上市、上櫃股票清單都讀取失敗');
  const list = [
    ...twse.map((r) => ({ code: r.Code, name: r.Name, market: '上市', value: num(r.TradeValue), close: num(r.ClosingPrice) })),
    ...tpex.map((r) => ({ code: r.SecuritiesCompanyCode, name: r.CompanyName, market: '上櫃', value: num(r.TransactionAmount), close: num(r.Close) })),
  ];
  // 一般股票（4 碼）和 ETF（00 開頭），排除權證等
  const valid = list.filter((s) => /^(\d{4}|00\d{2,4}[A-Z]?)$/.test(s.code));
  ALL_STOCKS = valid.map((s) => ({ c: s.code, n: String(s.name).trim(), m: s.market === '上市' ? 1 : 2 }));
  return valid
    .filter((s) => s.value > 0 && s.close > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

async function loadDisposal() {
  const set = new Set();
  const tasks = [
    getJson('https://openapi.twse.com.tw/v1/announcement/punish').then((a) => a.forEach((r) => set.add(String(r.Code).trim()))),
    getJson('https://www.tpex.org.tw/openapi/v1/tpex_disposal_information').then((a) => a.forEach((r) => set.add(String(r.SecuritiesCompanyCode).trim()))),
  ];
  for (const r of await Promise.allSettled(tasks)) if (r.status === 'rejected') console.warn('處置股清單讀取失敗：', r.reason.message);
  return set;
}

// ---------- 2. 歷史日 K（Yahoo）----------
// date 一律用台北時間：美股 date = 美東交易日（開盤 21:30/22:30 台北仍是同一天），
// 所以「美股 date d 的交易」發生在「台股 date d 收盤之後」
async function loadBars(symbol, range = '6mo') {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`);
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) return [];
  const q = res.indicators.quote[0];
  const bars = [];
  res.timestamp.forEach((t, i) => {
    const [o, h, l, c, v] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]];
    if ([o, h, l, c].some((x) => x == null || !(x > 0))) return;
    const date = new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10);
    const r = (x) => +x.toFixed(2);
    bars.push({ date, open: r(o), high: r(h), low: r(l), close: r(c), vol: Math.round((v || 0) / 1000) });
  });
  // Yahoo 偶爾最新一根 K 棒是空的（例如 2026-11-23 台積電 ADR），美股、匯率改用同一份回應的「最新成交」補上；台股不補
  const n = res.timestamp.length - 1, m = res.meta || {};
  if (!/\.(TW|TWO)$|^\^TWII$/.test(symbol) && n >= 0 && q.close[n] == null && m.regularMarketPrice > 0 && m.regularMarketTime >= res.timestamp[n]) {
    const date = new Date((res.timestamp[n] + 8 * 3600) * 1000).toISOString().slice(0, 10);
    if (!bars.length || bars[bars.length - 1].date < date) {
      const px = +m.regularMarketPrice.toFixed(2);
      bars.push({ date, open: +(q.open[n] || px).toFixed(2), high: +(m.regularMarketDayHigh || px).toFixed(2), low: +(m.regularMarketDayLow || px).toFixed(2), close: px, vol: Math.round((m.regularMarketVolume || 0) / 1000), patched: true });
    }
  }
  // 台股盤中（台北 13:35 收盤前）還沒收完的今天這根 K 棒不能用，否則會用半天的資料選股
  const nowTpe = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  const partialToday = /\.(TW|TWO)$|^\^TWII$/.test(symbol) && nowTpe.slice(11, 16) < '13:35' ? nowTpe.slice(0, 10) : null;
  return bars.filter((b, i) => (i === bars.length - 1 || bars[i + 1].date !== b.date) && (!ASOF || b.date <= ASOF) && b.date !== partialToday);
}

// 加權指數：以證交所官方資料為主（Yahoo 偶爾會缺資料，例如 2026-11-23 收盤價是空的），Yahoo 補缺的日子
async function loadTaiex(range = '1y') {
  const months = { '1mo': 2, '3mo': 4, '6mo': 7, '1y': 13, '2y': 25 }[range] || 13;
  const byDate = new Map();
  try { for (const b of await loadBars('^TWII', range)) byDate.set(b.date, b); } catch (e) { console.warn('Yahoo 加權指數讀取失敗', e.message); }
  let twseOk = 0;
  const d = new Date(); d.setDate(1);
  for (let k = 0; k < months; k++) {
    const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
    try {
      const j = await getJson(`https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?response=json&date=${ds}`);
      if (j.stat === 'OK' && j.data) {
        twseOk++;
        for (const row of j.data) {
          const [y, m, dd] = row[0].trim().split('/');
          const date = `${+y + 1911}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}`;
          const [o, h, l, c] = row.slice(1, 5).map(num);
          if ([o, h, l, c].every((v) => v > 0)) byDate.set(date, { date, open: o, high: h, low: l, close: c, vol: (byDate.get(date) || {}).vol || 0 });
        }
      }
    } catch (e) { console.warn(`證交所加權指數 ${ds} 讀取失敗`, e.message); }
    await sleep(300);
    d.setMonth(d.getMonth() - 1);
  }
  if (!twseOk) console.warn('證交所加權指數全部讀取失敗，只用 Yahoo 資料');
  const nowTpe = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  const partialToday = nowTpe.slice(11, 16) < '13:35' ? nowTpe.slice(0, 10) : null;
  return [...byDate.values()].filter((b) => (!ASOF || b.date <= ASOF) && b.date !== partialToday).sort((a, b) => a.date.localeCompare(b.date));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (e) { out[i] = null; console.warn(items[i].code || items[i], e.message); }
    }
  }));
  return out;
}

// ---------- 3. 美股 → 台股開盤預測 ----------
function linreg(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const beta = sxx ? sxy / sxx : 0;
  return { n, beta, alpha: my - beta * mx, r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0 };
}
// 美股在「台股前一交易日收盤後 → 台股某交易日開盤前」之間的累積漲跌
function usMoveBetween(usBars, prevTwDate, twDate) {
  const before = (d) => { let b = null; for (const x of usBars) { if (x.date < d) b = x; else break; } return b; };
  const a = before(prevTwDate), b = before(twDate);
  if (!a || !b) return null;
  return b.close / a.close - 1;
}

const US_WINDOW = 60; // 用最近 60 個交易日建模型（市場特性會變，近期資料比較準）

async function usOutlook(twii) {
  const series = {};
  await mapLimit(US_SYMBOLS, 3, async ([sym]) => { series[sym] = await loadBars(sym, '1y'); });
  let fx = null;
  try { const f = await loadBars('TWD=X', '1mo'); fx = f[f.length - 1].close; } catch (e) { console.warn('匯率讀取失敗', e.message); }
  return usPredict(twii, series, fx);
}

// 純計算（回測也用這個）：twii = 到台股最新交易日的日 K；series = 各美股日 K（只能包含下一個台股交易日之前的資料）
function usPredict(twii, series, fx = null) {
  const twLast = twii[twii.length - 1];
  const indices = [], models = [];
  for (const [sym, name] of US_SYMBOLS) {
    const bars = series[sym];
    if (!bars || bars.length < 30) continue;
    const L = bars[bars.length - 1], P = bars[bars.length - 2];
    indices.push({ sym, name, date: L.date, close: L.close, chg: +((L.close / P.close - 1) * 100).toFixed(2) });
    if (sym === '^DJI') continue; // 道瓊和標普高度重複，只顯示不建模
    // 台股每天開盤跳空 vs 前一晚美股漲跌
    const xs = [], ys = [], days = {};
    for (let i = Math.max(1, twii.length - US_WINDOW); i < twii.length; i++) {
      const m = usMoveBetween(bars, twii[i - 1].date, twii[i].date);
      if (m == null) continue;
      xs.push(m); ys.push(twii[i].open / twii[i - 1].close - 1); days[twii[i].date] = m;
    }
    if (xs.length < 40) continue;
    const fit = linreg(xs, ys);
    // 這次要預測的美股漲跌：台股最新收盤之後的美股變化
    const move = L.date >= twLast.date ? L.close / usMoveBase(bars, twLast.date) - 1 : null;
    models.push({ sym, name, ...fit, days, move, latest: L.date, pred: move == null ? null : fit.alpha + fit.beta * move });
  }
  const out = {
    indices, fx, twDate: twLast.date, window: US_WINDOW,
    models: models.map((m) => ({ sym: m.sym, name: m.name, beta: +m.beta.toFixed(3), r: +m.r.toFixed(2), n: m.n,
      move: m.move == null ? null : +(m.move * 100).toFixed(2), pred: m.pred == null ? null : +(m.pred * 100).toFixed(2) })),
  };
  const usable = models.filter((m) => m.pred != null && m.r > 0);
  if (!usable.length) {
    return { ...out, available: false, reason: `美股 ${twLast.date} 的交易還沒收盤，早上 7:40 更新後才有預測` };
  }
  // 以 r² 加權平均各模型的預測
  const w = usable.map((m) => m.r * m.r), W = w.reduce((a, b) => a + b, 0);
  const predGap = usable.reduce((s2, m, i) => s2 + m.pred * w[i], 0) / W;
  const preds = usable.map((m) => m.pred);
  // 過去 60 天方向命中率：開盤跳空超過 ±0.2% 的日子，預測方向是否正確
  let hit = 0, tot = 0;
  for (let i = Math.max(1, twii.length - US_WINDOW); i < twii.length; i++) {
    const d = twii[i].date, actual = twii[i].open / twii[i - 1].close - 1;
    const ms = usable.filter((m) => m.days[d] != null);
    if (!ms.length || Math.abs(actual) < 0.002) continue;
    const ww = ms.map((m) => m.r * m.r), WW = ww.reduce((a, b) => a + b, 0);
    const p = ms.reduce((s2, m, k) => s2 + (m.alpha + m.beta * m.days[d]) * ww[k], 0) / WW;
    tot++; if (Math.sign(p) === Math.sign(actual)) hit++;
  }
  return {
    ...out, available: true,
    predGap: +(predGap * 100).toFixed(2),
    predLow: +(Math.min(...preds) * 100).toFixed(2), predHigh: +(Math.max(...preds) * 100).toFixed(2),
    predIndex: Math.round(twLast.close * (1 + predGap)),
    hitRate: tot ? Math.round((hit / tot) * 100) : null, hitN: tot,
    avgR: +(usable.reduce((s2, m, i) => s2 + m.r * w[i], 0) / W).toFixed(2),
  };
}
function usMoveBase(usBars, twDate) {
  let b = null;
  for (const x of usBars) { if (x.date < twDate) b = x; else break; }
  return b ? b.close : usBars[usBars.length - 2].close;
}

// 個股對大盤的 beta（近 60 日）
function stockBeta(bars, twii) {
  const idx = new Map(twii.map((b, i) => [b.date, i]));
  const xs = [], ys = [];
  for (let i = Math.max(1, bars.length - 60); i < bars.length; i++) {
    const j = idx.get(bars[i].date);
    if (j == null || j < 1 || twii[j - 1].date !== bars[i - 1].date) continue;
    xs.push(twii[j].close / twii[j - 1].close - 1);
    ys.push(bars[i].close / bars[i - 1].close - 1);
  }
  if (xs.length < 30) return 1;
  return Math.min(Math.max(linreg(xs, ys).beta, 0.3), 3);
}

// ---------- 4. 篩選與評分 ----------
const fmtYi = (v) => `${(v / 1e8).toFixed(v >= 1e10 ? 0 : 1)} 億`;

function screen(s, x, usBias) {
  const out = [];
  if (Core.isEtf(s.code) || !x.ma60 || x.n < 61) return out;
  const C = x.last.close, A = x.atr, atrPct = (A / C) * 100;
  const tr = Core.trendOf(x);
  const volRatio = x.vol20 ? x.last.vol / x.vol20 : 1;
  if (C < 10) return out;
  const align = (side) => (!usBias ? 0 : (usBias > 0) === (side === 'long') ? 1 : -1);

  // 當沖：流動性高、波動適中、方向明確
  if (x.value20 >= 5e8 && atrPct >= 2.5 && atrPct <= 8 && tr.key !== 'mid' && !s.disposal) {
    const { P } = Core.pivots(x);
    const up = tr.key === 'up';
    // 美股大幅反向時，改用「等回測 / 等反彈」的情境，不追突破
    const strongAgainst = usBias && Math.abs(usBias) >= 1 && (usBias > 0) !== up;
    const planId = up ? (C >= P && !strongAgainst ? 'dt1' : 'dt2') : (C <= P && !strongAgainst ? 'dt3' : 'dt4');
    let score = 2 + Math.min(Math.abs(C - x.ma20) / A, 3) * 0.5 + Math.log10(x.value20 / 5e8)
      + (x.vol5 > x.vol20 * 1.2 ? 0.5 : 0) + (atrPct >= 3 && atrPct <= 6 ? 0.5 : 0)
      - (x.rsi > 80 || x.rsi < 20 ? 1 : 0) + 0.8 * align(up ? 'long' : 'short');
    if (!up) score *= 0.9; // 做空需有先賣後買資格，略降權重
    out.push({ kind: 'daytrade', planId, score, reasons: [
      up ? '多頭趨勢，月線向上' : '空頭趨勢，月線向下',
      `每日波動 ${atrPct.toFixed(1)}%`,
      `20 日均成交 ${fmtYi(x.value20)}`,
      ...(x.vol5 > x.vol20 * 1.2 ? [`近 5 日量增 ${(x.vol5 / x.vol20).toFixed(1)} 倍`] : []),
    ] });
  }

  // 短線：趨勢中的拉回或帶量突破
  if (x.value20 >= 2e8) {
    const d10 = (C - x.ma10) / A;
    if (tr.key === 'up') {
      if (d10 >= -0.3 && d10 <= 1.0 && x.rsi >= 40 && x.rsi <= 68 && C > x.ma20) {
        out.push({ kind: 'swing', planId: 'sw1', score: 3 - Math.abs(d10 - 0.3) + (x.ma5 > x.ma10 && x.ma10 > x.ma20 ? 0.5 : 0) + 0.3 * align('long'),
          reasons: ['多頭趨勢中拉回', `距 10 日線 ${d10 >= 0 ? '+' : ''}${d10.toFixed(1)} 個 ATR`, `RSI ${x.rsi.toFixed(0)}`] });
      }
      if (x.hh20Prev && C > x.hh20Prev && volRatio >= 1.5 && x.rsi < 80) {
        out.push({ kind: 'swing', planId: 'sw2', score: 3 + Math.min(volRatio, 4) * 0.3 + 0.3 * align('long'),
          reasons: ['帶量突破 20 日高點', `成交量為均量 ${volRatio.toFixed(1)} 倍`, `RSI ${x.rsi.toFixed(0)}`] });
      }
    } else if (tr.key === 'down') {
      if (-d10 >= -0.3 && -d10 <= 1.0 && x.rsi >= 32 && x.rsi <= 60 && C < x.ma20) {
        out.push({ kind: 'swing', planId: 'sw3', score: (3 - Math.abs(-d10 - 0.3) + 0.3 * align('short')) * 0.85,
          reasons: ['空頭趨勢中反彈', `距 10 日線 ${(-d10).toFixed(1)} 個 ATR`, `RSI ${x.rsi.toFixed(0)}`, '需融券'] });
      }
      if (x.ll20Prev && C < x.ll20Prev && volRatio >= 1.5 && x.rsi > 20) {
        out.push({ kind: 'swing', planId: 'sw4', score: (3 + Math.min(volRatio, 4) * 0.3 + 0.3 * align('short')) * 0.85,
          reasons: ['帶量跌破 20 日低點', `成交量為均量 ${volRatio.toFixed(1)} 倍`, `RSI ${x.rsi.toFixed(0)}`, '需融券'] });
      }
    }
  }
  return out;
}

function choose(cands) {
  const byScore = (a, b) => b.score - a.score;
  const dt = cands.filter((c) => c.kind === 'daytrade').sort(byScore);
  const sw = cands.filter((c) => c.kind === 'swing').sort(byScore);
  const total = N_DAYTRADE + N_SWING;
  const picked = [], used = new Set();
  const take = (list, n) => {
    for (const c of list) {
      if (picked.length >= total || n <= 0) break;
      if (used.has(c.code)) continue;
      picked.push(c); used.add(c.code); n--;
    }
  };
  take(dt, N_DAYTRADE);
  take(sw, N_SWING);
  take([...dt, ...sw].sort(byScore), total - picked.length); // 某一類不夠時，用另一類補滿
  return picked;
}

// 依預估開盤價，提醒當沖進場價是否已被跳空越過
function usNote(plan, estOpen, usBias) {
  const notes = [];
  if (usBias) {
    const same = (usBias > 0) === (plan.side === 'long');
    notes.push(same ? '✅ 和美股方向一致' : '⚠️ 和美股方向相反，部位減半');
  }
  if (plan.type === 'daytrade' && estOpen) {
    if (plan.side === 'long' && estOpen >= plan.entry) notes.push('預估開盤就在進場價之上，開盤不追，等拉回進場價再買');
    if (plan.side === 'short' && estOpen <= plan.entry) notes.push('預估開盤就在進場價之下，開盤不追空，等反彈到進場價再空');
  }
  return notes;
}

// ---------- 主程式 ----------
module.exports = { getJson, loadUniverse, loadDisposal, loadBars, loadTaiex, mapLimit, linreg, usPredict, stockBeta, screen, choose, US_SYMBOLS };

if (require.main === module) (async () => {
  const t0 = Date.now();
  const [universe, disposal, twii] = await Promise.all([loadUniverse(), loadDisposal(), loadTaiex('1y')]);
  console.log(`股票池 ${universe.length} 檔，處置股 ${disposal.size} 檔，加權指數 ${twii.length} 天`);

  const results = await mapLimit(universe, 6, async (s) => {
    const bars = await loadBars(`${s.code}.${s.market === '上市' ? 'TW' : 'TWO'}`);
    if (bars.length < 20) return null;
    return { ...s, disposal: disposal.has(s.code), bars, x: Core.indicators(bars) };
  });
  const stocks = results.filter(Boolean);
  console.log(`取得歷史資料 ${stocks.length} 檔`);

  const dates = {};
  stocks.forEach((s) => (dates[s.x.last.date] = (dates[s.x.last.date] || 0) + 1));
  const date = Object.entries(dates).sort((a, b) => b[1] - a[1])[0][0];
  const fresh = stocks.filter((s) => s.x.last.date === date);
  const twiiUse = twii.filter((b) => b.date <= date);

  // 大盤與美股
  const tx = Core.indicators(twiiUse);
  const market = {
    close: tx.last.close, chg: +(((tx.last.close - tx.prev.close) / tx.prev.close) * 100).toFixed(2),
    trend: Core.trendOf(tx).text, date: tx.last.date,
    up: fresh.filter((s) => s.x.last.close > s.x.prev.close).length,
    down: fresh.filter((s) => s.x.last.close < s.x.prev.close).length,
    upTrendPct: Math.round((fresh.filter((s) => Core.trendOf(s.x).key === 'up').length / fresh.length) * 100),
    universe: fresh.length,
  };
  let us = null;
  try { us = await usOutlook(twiiUse); } catch (e) { console.warn('美股資料讀取失敗', e.message); }
  const tsm = us && us.indices.find((i) => i.sym === 'TSM');
  const tw2330 = fresh.find((s) => s.code === '2330');
  if (us && tsm && us.fx && tw2330) {
    // 1 股 ADR = 5 股台積電
    us.adrPremium = +(((tsm.close / 5) * us.fx / tw2330.x.last.close - 1) * 100).toFixed(1);
  }
  // 預估開盤跳空超過 ±0.3% 才當作有方向
  const usBias = us && us.available && Math.abs(us.predGap) >= 0.3 ? us.predGap : 0;

  // 選股
  const cands = [];
  for (const s of fresh) for (const c of screen(s, s.x, usBias)) cands.push({ ...c, code: s.code });
  const planOf = (c, s) => (c.kind === 'daytrade' ? Core.dayTradePlans(s.x, s.code).plans : Core.swingPlans(s.x, s.code).plans).find((q) => q.id === c.planId);
  const chosen = choose(cands.filter((c) => {
    const s = fresh.find((t) => t.code === c.code), p = planOf(c, s);
    if (!p || !p.valid) return false;
    if (SHORT_BAN && p.side === 'short' && p.entry < s.x.last.close) return false; // 禁空令：平盤以下不能放空
    return true;
  }));
  const picks = chosen.map((c) => {
    const s = fresh.find((t) => t.code === c.code);
    const plan = planOf(c, s);
    const beta = stockBeta(s.bars, twiiUse);
    const estOpen = us && us.available ? Core.roundTick(s.x.last.close * (1 + beta * us.predGap / 100), Core.isEtf(s.code)) : null;
    return { code: s.code, name: s.name, market: s.market, kind: c.kind, score: +c.score.toFixed(2), reasons: c.reasons,
      plan, beta: +beta.toFixed(2), estOpen, usNotes: usNote(plan, estOpen, usBias), x: s.x };
  });

  const WRITE = !ASOF || !!process.env.PICKS_OUT_DIR;
  if (WRITE) fs.mkdirSync(OUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  if (us) us.indices = us.indices.map(({ sym, name, date: d, close, chg }) => ({ sym, name, date: d, close, chg }));
  if (WRITE) fs.writeFileSync(path.join(OUT_DIR, 'picks.json'), JSON.stringify({
    date, generatedAt, market, us, shortBan: SHORT_BAN,
    candidates: { daytrade: cands.filter((c) => c.kind === 'daytrade').length, swing: cands.filter((c) => c.kind === 'swing').length },
    picks,
  }, null, 1));
  const snapshot = { date, generatedAt, stocks: {} };
  for (const s of fresh) snapshot.stocks[s.code] = { name: s.name, market: s.market, x: s.x };
  if (WRITE) fs.writeFileSync(path.join(OUT_DIR, 'snapshot.json'), JSON.stringify(snapshot));
  if (WRITE && ALL_STOCKS.length > 500) fs.writeFileSync(path.join(OUT_DIR, 'names.json'), JSON.stringify({ updated: generatedAt, stocks: ALL_STOCKS }));

  console.log(`資料日期 ${date}，候選：當沖 ${cands.filter((c) => c.kind === 'daytrade').length}、短線 ${cands.filter((c) => c.kind === 'swing').length}`);
  if (us) {
    console.log('美股：' + us.indices.map((i) => `${i.name} ${i.chg}%`).join('、') + (us.adrPremium != null ? `，ADR 溢價 ${us.adrPremium}%` : ''));
    console.log('模型：' + us.models.map((m) => `${m.name} β=${m.beta} r=${m.r}${m.pred != null ? ` 預測 ${m.pred}%` : ''}`).join('、'));
    console.log(us.available ? `預估台股開盤 ${us.predGap}%（${us.predLow}% ~ ${us.predHigh}%，約 ${us.predIndex}），過去 ${us.hitN} 天方向命中 ${us.hitRate}%` : us.reason);
  }
  for (const p of picks) {
    console.log(`  ${p.kind === 'daytrade' ? '當沖' : '短線'} ${p.code} ${p.name} ${p.plan.label} 進 ${p.plan.entry} 損 ${p.plan.stop} 利 ${p.plan.t1}/${p.plan.t2}${p.estOpen ? ` 預估開 ${p.estOpen}` : ''}`);
  }
  console.log(`完成，耗時 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
})().catch((e) => { console.error(e); process.exit(1); });
