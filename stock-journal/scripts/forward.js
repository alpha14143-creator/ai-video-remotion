// 實盤追蹤（紙上交易）：每天記下「今日10檔」，收盤後用真實走勢評估，連續追蹤 20 個交易日（4 週）
//
// 用法（GitHub Actions 每天自動執行，TRACK_DIR 指向 stock-data 分支的資料夾）：
//   node forward.js save       早上選股後：把 data/picks.json 存成 TRACK_DIR/picks/<資料日期>.json，並備份最新的資料檔
//   node forward.js restore    下午評估時：把早上的 picks / snapshot / backtest 還原到 data/（網頁才會顯示早上的選股）
//   node forward.js evaluate   評估所有已記錄的選股，產生 data/forward.json
//
// 評估規則和回測完全相同（scripts/backtest.js）：
//   當沖用當天 5 分 K 精算；短線掛單 3 天、收盤停損、停利 1 出一半、最多持有 20 天，每天更新直到出場

const fs = require('fs');
const path = require('path');
const L = require('./daily-picks.js');
const B = require('./backtest.js');

const DATA = path.join(__dirname, '..', 'data');
const TRACK = process.env.TRACK_DIR || path.join(__dirname, '..', '..', 'track');
const PICKS_DIR = path.join(TRACK, 'picks');
const LATEST = path.join(TRACK, 'latest');
const WINDOW = 20; // 4 週 = 20 個交易日
const LATEST_FILES = ['picks.json', 'snapshot.json', 'backtest.json'];

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const r2 = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d));

function save() {
  const picks = readJson(path.join(DATA, 'picks.json'));
  fs.mkdirSync(PICKS_DIR, { recursive: true });
  fs.mkdirSync(LATEST, { recursive: true });
  // 以「資料日期」命名：同一份收盤資料（例如週五收盤）在週末、週一早上重跑時會覆蓋成最新一次
  const slim = { date: picks.date, generatedAt: picks.generatedAt, us: picks.us && { available: picks.us.available, predGap: picks.us.predGap },
    picks: picks.picks.map(({ code, name, market, kind, plan, estOpen, reasons }) => ({ code, name, market, kind, plan, estOpen, reasons })) };
  fs.writeFileSync(path.join(PICKS_DIR, `${picks.date}.json`), JSON.stringify(slim, null, 1));
  for (const f of LATEST_FILES) if (fs.existsSync(path.join(DATA, f))) fs.copyFileSync(path.join(DATA, f), path.join(LATEST, f));
  console.log(`已記錄 ${picks.date} 收盤後的 ${picks.picks.length} 檔選股`);
}

function restore() {
  for (const f of LATEST_FILES) {
    const src = path.join(LATEST, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(DATA, f)); console.log('還原', f); }
  }
}

async function loadIntraday(code, market) {
  const j = await L.getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.${market === '上市' ? 'TW' : 'TWO'}?interval=5m&range=60d`);
  const res = j.chart.result[0], q = res.indicators.quote[0], byDate = {};
  (res.timestamp || []).forEach((ts, k) => {
    if ([q.open[k], q.high[k], q.low[k], q.close[k]].some((v) => v == null)) return;
    const d = new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
    (byDate[d] = byDate[d] || []).push({ open: q.open[k], high: q.high[k], low: q.low[k], close: q.close[k] });
  });
  return byDate;
}

async function evaluate() {
  const files = fs.existsSync(PICKS_DIR) ? fs.readdirSync(PICKS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
  const twii = await L.loadBars('^TWII', '6mo');
  const tradeDates = twii.map((b) => b.date);
  const days = files.map((f) => {
    const p = readJson(path.join(PICKS_DIR, f));
    return { dataDate: p.date, tradeDate: tradeDates.find((d) => d > p.date) || null, us: p.us, picks: p.picks };
  });
  // 追蹤期間：第一個交易日開始的 20 個交易日
  const started = days.filter((d) => d.tradeDate);
  const window = started.slice(0, WINDOW);

  const codes = new Map();
  for (const d of window) for (const p of d.picks) codes.set(p.code, p.market);
  const daily = {}, intra = {};
  await L.mapLimit([...codes.keys()], 4, async (code) => {
    const sym = `${code}.${codes.get(code) === '上市' ? 'TW' : 'TWO'}`;
    daily[code] = await L.loadBars(sym, '6mo');
    intra[code] = await loadIntraday(code, codes.get(code));
  });

  const results = [];
  for (const d of window) {
    const rows = d.picks.map((pk) => {
      const base = { code: pk.code, name: pk.name, kind: pk.kind, label: pk.plan.label, side: pk.plan.side,
        entry: pk.plan.entry, stop: pk.plan.stop, t1: pk.plan.t1, t2: pk.plan.t2 };
      let r;
      if (pk.kind === 'daytrade') {
        const b5 = intra[pk.code] && intra[pk.code][d.tradeDate];
        r = !b5 || b5.length < 10 ? { status: 'waiting' } : B.evalDayIntraday(pk.plan, b5);
      } else {
        const bars = daily[pk.code] || [];
        const jn = bars.findIndex((b) => b.date === d.tradeDate);
        r = jn < 0 ? { status: 'waiting' } : B.evalSwing(pk.plan, bars, jn);
      }
      return { ...base, status: r.status, R: r2(r.R), ret: r2(r.ret != null ? r.ret * 100 : null), reason: r.reason || null, hold: r.hold ?? null };
    });
    results.push({ dataDate: d.dataDate, tradeDate: d.tradeDate, usPredGap: d.us && d.us.available ? d.us.predGap : null, rows });
  }
  const pending = days.filter((d) => !d.tradeDate).map((d) => ({ dataDate: d.dataDate, n: d.picks.length }));

  const flat = results.flatMap((d) => d.rows.map((r) => ({ ...r, date: d.tradeDate })));
  const statsOf = (kind) => B.stats(flat.filter((r) => r.kind === kind && ['filled', 'nofill', 'gap'].includes(r.status)).map((r) => ({ ...r, ret: r.ret / 100 })));
  const open = flat.filter((r) => r.status === 'open');
  let backtest = null;
  try {
    const bt = readJson(path.join(DATA, 'backtest.json'));
    backtest = { daytradeExpR: bt.intraday ? bt.intraday.exact.expR : null, daytradeWin: bt.intraday ? bt.intraday.exact.winRate : null,
      swingExpR: bt.summary.us.swing.expR, swingWin: bt.summary.us.swing.winRate };
  } catch { /* 沒有回測資料 */ }

  const out = {
    generatedAt: new Date().toISOString(),
    window: WINDOW,
    start: window.length ? window[0].tradeDate : null,
    progress: window.filter((d) => d.tradeDate <= tradeDates[tradeDates.length - 1]).length,
    lastTradeDate: tradeDates[tradeDates.length - 1],
    summary: {
      daytrade: statsOf('daytrade'),
      swing: statsOf('swing'),
      swingOpen: { n: open.length, R: r2(open.reduce((s, r) => s + (r.R || 0), 0)) },
      totalR: r2(flat.filter((r) => r.status === 'filled').reduce((s, r) => s + r.R, 0)),
    },
    backtest,
    days: results.reverse(),
    pending,
  };
  fs.writeFileSync(path.join(DATA, 'forward.json'), JSON.stringify(out, null, 1));
  if (fs.existsSync(TRACK)) { fs.mkdirSync(LATEST, { recursive: true }); fs.copyFileSync(path.join(DATA, 'forward.json'), path.join(LATEST, 'forward.json')); }

  const s = out.summary;
  console.log(`實盤追蹤：第 ${out.progress} / ${WINDOW} 天（從 ${out.start || '-'} 開始），待開始 ${pending.length} 天`);
  console.log(`  當沖 已成交 ${s.daytrade.n || 0} 筆，勝率 ${s.daytrade.winRate ?? '-'}%，期望值 ${s.daytrade.expR ?? '-'}R`);
  console.log(`  短線 已出場 ${s.swing.n || 0} 筆，勝率 ${s.swing.winRate ?? '-'}%，期望值 ${s.swing.expR ?? '-'}R；持有中 ${s.swingOpen.n} 筆（未實現 ${s.swingOpen.R}R）`);
  console.log(`  已實現合計 ${s.totalR}R`);
}

const cmd = process.argv[2];
(async () => {
  if (cmd === 'save') save();
  else if (cmd === 'restore') restore();
  else if (cmd === 'evaluate') await evaluate();
  else { console.log('用法：node forward.js save | restore | evaluate'); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
