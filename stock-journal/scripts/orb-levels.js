// 開盤 30 分鐘突破法：自動抓今天當沖選股 09:00～09:30 的最高價、最低價，產生 data/orb.json
// 用法：node stock-journal/scripts/orb-levels.js
// 資料來源：Yahoo 5 分 K（約延遲 20 分鐘），所以要在台北 09:52 以後執行，09:30 以前的 K 棒才會完整
// 網頁讀到 data/orb.json 後，會自動把最高價、最低價填進「今日10檔」的當沖卡片

const fs = require('fs');
const path = require('path');
const L = require('./daily-picks.js');

const DATA = path.join(__dirname, '..', 'data');
const OPEN_BARS = 6; // 09:00、09:05 … 09:25 共 6 根 5 分 K = 09:00～09:30

(async () => {
  const picks = JSON.parse(fs.readFileSync(path.join(DATA, 'picks.json'), 'utf8'));
  const dt = picks.picks.filter((p) => p.kind === 'daytrade');
  const nowTpe = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  const today = nowTpe.slice(0, 10);
  const levels = {};
  await L.mapLimit(dt, 4, async (pk) => {
    const sym = `${pk.code}.${pk.market === '上市' ? 'TW' : 'TWO'}`;
    const j = await L.getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`);
    const res = j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.timestamp) return;
    const q = res.indicators.quote[0];
    // 只取今天 09:00～09:25 開始的 6 根 K 棒
    const bars = [];
    res.timestamp.forEach((t, i) => {
      const d = new Date((t + 8 * 3600) * 1000).toISOString();
      if (d.slice(0, 10) !== today || q.high[i] == null || q.low[i] == null) return;
      const hm = d.slice(11, 16);
      if (hm >= '09:00' && hm < '09:30') bars.push({ hm, high: q.high[i], low: q.low[i] });
    });
    if (bars.length < OPEN_BARS) { console.log(`${pk.code} ${pk.name}：09:00～09:30 的 K 棒還不完整（${bars.length}/${OPEN_BARS} 根）`); return; }
    const H = Math.max(...bars.map((b) => b.high)), Lo = Math.min(...bars.map((b) => b.low));
    levels[pk.code] = { name: pk.name, H: +H.toFixed(2), L: +Lo.toFixed(2) };
    console.log(`${pk.code} ${pk.name}：最高 ${levels[pk.code].H}、最低 ${levels[pk.code].L}`);
  });
  fs.writeFileSync(path.join(DATA, 'orb.json'), JSON.stringify({ date: today, picksDate: picks.date, generatedAt: new Date().toISOString(), source: 'Yahoo 5 分 K（約延遲 20 分鐘）', levels }, null, 1));
  console.log(`完成：${Object.keys(levels).length}／${dt.length} 檔有開盤區間`);
})().catch((e) => { console.error(e); process.exit(1); });
