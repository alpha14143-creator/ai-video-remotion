// 每日選股：收盤後執行，產生 data/picks.json（今日 5 檔）和 data/snapshot.json（熱門股指標快照）
// 用法：node stock-journal/scripts/daily-picks.js        （Node.js 18 以上，不用安裝套件）
//
// 流程：
//   1. 從證交所 / 櫃買中心 OpenAPI 取得全部上市櫃股票的成交金額，取前 UNIVERSE 名
//   2. 排除處置股
//   3. 從 Yahoo Finance 抓每檔近 6 個月日 K，計算均線、ATR、RSI…
//   4. 篩出適合當沖、短線的股票並評分，取當沖 2 檔 + 短線 3 檔

const fs = require('fs');
const path = require('path');
const Core = require('../plan-core.js');

const UNIVERSE = 300;
const N_DAYTRADE = 2;
const N_SWING = 3;
const OUT_DIR = path.join(__dirname, '..', 'data');
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; stock-journal/1.0)' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => parseFloat(String(s ?? '').replace(/,/g, ''));

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
async function loadUniverse() {
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
  return list
    .filter((s) => /^(\d{4}|00\d{2,4}[A-Z]?)$/.test(s.code) && s.value > 0 && s.close > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, UNIVERSE);
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

// ---------- 2. 歷史日 K ----------
async function loadBars(symbol) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`);
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) return [];
  const q = res.indicators.quote[0];
  const bars = [];
  res.timestamp.forEach((t, i) => {
    const [o, h, l, c, v] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]];
    if ([o, h, l, c].some((x) => x == null || !(x > 0))) return;
    const date = new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10); // 台北時間
    const r = (x) => +x.toFixed(2);
    bars.push({ date, open: r(o), high: r(h), low: r(l), close: r(c), vol: Math.round((v || 0) / 1000) });
  });
  // 同一天重複的資料只留最後一筆
  return bars.filter((b, i) => i === bars.length - 1 || bars[i + 1].date !== b.date);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (e) { out[i] = null; console.warn(items[i].code, e.message); }
    }
  }));
  return out;
}

// ---------- 3. 篩選與評分 ----------
const fmtYi = (v) => `${(v / 1e8).toFixed(v >= 1e10 ? 0 : 1)} 億`;

function screen(s, x) {
  const out = [];
  if (Core.isEtf(s.code) || !x.ma60 || x.n < 61) return out;
  const C = x.last.close, A = x.atr, atrPct = (A / C) * 100;
  const tr = Core.trendOf(x);
  const volRatio = x.vol20 ? x.last.vol / x.vol20 : 1;
  if (C < 10) return out;

  // 當沖：流動性高、波動適中、方向明確
  if (x.value20 >= 5e8 && atrPct >= 2.5 && atrPct <= 8 && tr.key !== 'mid' && !s.disposal) {
    const { P } = Core.pivots(x);
    const up = tr.key === 'up';
    const planId = up ? (C >= P ? 'dt1' : 'dt2') : (C <= P ? 'dt3' : 'dt4');
    let score = 2 + Math.min(Math.abs(C - x.ma20) / A, 3) * 0.5 + Math.log10(x.value20 / 5e8)
      + (x.vol5 > x.vol20 * 1.2 ? 0.5 : 0) + (atrPct >= 3 && atrPct <= 6 ? 0.5 : 0)
      - (x.rsi > 80 || x.rsi < 20 ? 1 : 0);
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
        out.push({ kind: 'swing', planId: 'sw1', score: 3 - Math.abs(d10 - 0.3) + (x.ma5 > x.ma10 && x.ma10 > x.ma20 ? 0.5 : 0),
          reasons: ['多頭趨勢中拉回', `距 10 日線 ${d10 >= 0 ? '+' : ''}${d10.toFixed(1)} 個 ATR`, `RSI ${x.rsi.toFixed(0)}`] });
      }
      if (x.hh20Prev && C > x.hh20Prev && volRatio >= 1.5 && x.rsi < 80) {
        out.push({ kind: 'swing', planId: 'sw2', score: 3 + Math.min(volRatio, 4) * 0.3,
          reasons: ['帶量突破 20 日高點', `成交量為均量 ${volRatio.toFixed(1)} 倍`, `RSI ${x.rsi.toFixed(0)}`] });
      }
    } else if (tr.key === 'down') {
      if (-d10 >= -0.3 && -d10 <= 1.0 && x.rsi >= 32 && x.rsi <= 60 && C < x.ma20) {
        out.push({ kind: 'swing', planId: 'sw3', score: (3 - Math.abs(-d10 - 0.3)) * 0.85,
          reasons: ['空頭趨勢中反彈', `距 10 日線 ${(-d10).toFixed(1)} 個 ATR`, `RSI ${x.rsi.toFixed(0)}`, '需融券'] });
      }
      if (x.ll20Prev && C < x.ll20Prev && volRatio >= 1.5 && x.rsi > 20) {
        out.push({ kind: 'swing', planId: 'sw4', score: (3 + Math.min(volRatio, 4) * 0.3) * 0.85,
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
  const picked = [], used = new Set();
  const take = (list, n) => {
    for (const c of list) {
      if (picked.length >= N_DAYTRADE + N_SWING || n <= 0) break;
      if (used.has(c.code)) continue;
      picked.push(c); used.add(c.code); n--;
    }
  };
  take(dt, N_DAYTRADE);
  take(sw, N_SWING);
  // 某一類不夠時，用另一類補滿 5 檔
  const rest = [...dt, ...sw].sort(byScore);
  take(rest, N_DAYTRADE + N_SWING - picked.length);
  return picked;
}

// ---------- 主程式 ----------
(async () => {
  const t0 = Date.now();
  const [universe, disposal] = await Promise.all([loadUniverse(), loadDisposal()]);
  console.log(`股票池 ${universe.length} 檔，處置股 ${disposal.size} 檔`);

  const results = await mapLimit(universe, 6, async (s) => {
    const bars = await loadBars(`${s.code}.${s.market === '上市' ? 'TW' : 'TWO'}`);
    if (bars.length < 20) return null;
    return { ...s, disposal: disposal.has(s.code), x: Core.indicators(bars) };
  });
  const stocks = results.filter(Boolean);
  console.log(`取得歷史資料 ${stocks.length} 檔`);

  // 以多數股票的最新交易日為資料日期，排除停牌等資料過舊的股票
  const dates = {};
  stocks.forEach((s) => (dates[s.x.last.date] = (dates[s.x.last.date] || 0) + 1));
  const date = Object.entries(dates).sort((a, b) => b[1] - a[1])[0][0];
  const fresh = stocks.filter((s) => s.x.last.date === date);

  // 大盤
  let market = null;
  try {
    const twii = Core.indicators(await loadBars('^TWII'));
    const chg = ((twii.last.close - twii.prev.close) / twii.prev.close) * 100;
    market = { close: twii.last.close, chg: +chg.toFixed(2), trend: Core.trendOf(twii).text, date: twii.last.date };
  } catch (e) { console.warn('大盤資料讀取失敗', e.message); }
  const upCnt = fresh.filter((s) => s.x.last.close > s.x.prev.close).length;
  const downCnt = fresh.filter((s) => s.x.last.close < s.x.prev.close).length;
  const upTrend = fresh.filter((s) => Core.trendOf(s.x).key === 'up').length;

  // 選股
  const cands = [];
  for (const s of fresh) for (const c of screen(s, s.x)) cands.push({ ...c, code: s.code });
  const chosen = choose(cands.filter((c) => {
    const s = fresh.find((t) => t.code === c.code);
    const plans = c.kind === 'daytrade' ? Core.dayTradePlans(s.x, s.code).plans : Core.swingPlans(s.x, s.code).plans;
    const p = plans.find((q) => q.id === c.planId);
    return p && p.valid;
  }));
  const picks = chosen.map((c) => {
    const s = fresh.find((t) => t.code === c.code);
    const plans = c.kind === 'daytrade' ? Core.dayTradePlans(s.x, s.code).plans : Core.swingPlans(s.x, s.code).plans;
    const plan = plans.find((q) => q.id === c.planId);
    return { code: s.code, name: s.name, market: s.market, kind: c.kind, score: +c.score.toFixed(2), reasons: c.reasons, plan, x: s.x };
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_DIR, 'picks.json'), JSON.stringify({
    date, generatedAt,
    market: market && { ...market, up: upCnt, down: downCnt, upTrendPct: Math.round((upTrend / fresh.length) * 100), universe: fresh.length },
    candidates: { daytrade: cands.filter((c) => c.kind === 'daytrade').length, swing: cands.filter((c) => c.kind === 'swing').length },
    picks,
  }, null, 1));
  const snapshot = { date, generatedAt, stocks: {} };
  for (const s of fresh) snapshot.stocks[s.code] = { name: s.name, market: s.market, x: s.x };
  fs.writeFileSync(path.join(OUT_DIR, 'snapshot.json'), JSON.stringify(snapshot));

  console.log(`資料日期 ${date}，候選：當沖 ${cands.filter((c) => c.kind === 'daytrade').length}、短線 ${cands.filter((c) => c.kind === 'swing').length}`);
  for (const p of picks) {
    console.log(`  ${p.kind === 'daytrade' ? '當沖' : '短線'} ${p.code} ${p.name} ${p.plan.label} 進 ${p.plan.entry} 損 ${p.plan.stop} 利 ${p.plan.t1}/${p.plan.t2}  (${p.reasons.join('、')})`);
  }
  console.log(`完成，耗時 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
})().catch((e) => { console.error(e); process.exit(1); });
