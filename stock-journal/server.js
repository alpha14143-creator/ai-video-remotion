// 台股交易助手 本機伺服器
// 用法：node server.js   然後用瀏覽器打開 http://localhost:3000
// 需要 Node.js 18 以上（內建 fetch），不用安裝任何套件。
//
// 功能：
//   1. 提供 index.html 頁面
//   2. /api/history?code=2330  抓近 5 個月日 K（先查證交所上市，查不到再查櫃買中心上櫃）

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const MONTHS = 5;
const cache = new Map(); // code -> { time, data }
const CACHE_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => parseFloat(String(s).replace(/,/g, ""));
const rocToIso = (s) => {
  const [y, m, d] = s.trim().split("/");
  return `${+y + 1911}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
};

function monthList(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    out.unshift(new Date(d));
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function toBar(date, o, h, l, c, vol) {
  [o, h, l, c] = [o, h, l, c].map(num);
  if ([o, h, l, c].some(isNaN)) return null; // 無成交日顯示 "--"
  return { date: rocToIso(date), open: o, high: h, low: l, close: c, vol };
}

// 上市：成交股數 → 換算成張
async function fetchTwse(code) {
  let name = "";
  const bars = [];
  for (const m of monthList(MONTHS)) {
    const ds = `${m.getFullYear()}${String(m.getMonth() + 1).padStart(2, "0")}01`;
    const j = await getJson(
      `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ds}&stockNo=${code}`
    );
    await sleep(350);
    if (j.stat !== "OK" || !j.data) continue;
    name = name || (j.title || "").split(/\s+/)[2] || "";
    for (const row of j.data) {
      const b = toBar(row[0], row[3], row[4], row[5], row[6], Math.round(num(row[1]) / 1000));
      if (b) bars.push(b);
    }
  }
  return bars.length ? { code, name, market: "上市", bars } : null;
}

// 上櫃：成交張數
async function fetchTpex(code) {
  let name = "";
  const bars = [];
  for (const m of monthList(MONTHS)) {
    const ds = `${m.getFullYear()}/${String(m.getMonth() + 1).padStart(2, "0")}/01`;
    const j = await getJson(
      `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${ds}&response=json`
    );
    await sleep(350);
    const t = j.tables && j.tables[0];
    if (!t || !t.data || !t.data.length) continue;
    name = name || j.name || "";
    for (const row of t.data) {
      const b = toBar(row[0], row[3], row[4], row[5], row[6], num(row[1]));
      if (b) bars.push(b);
    }
  }
  return bars.length ? { code, name, market: "上櫃", bars } : null;
}

async function history(code) {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.data;
  const data = (await fetchTwse(code)) || (await fetchTpex(code));
  if (data) cache.set(code, { time: Date.now(), data });
  return data;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/history") {
    const code = (url.searchParams.get("code") || "").trim().toUpperCase();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (!/^[0-9A-Z]{4,6}$/.test(code)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "股票代號格式不正確" }));
    }
    try {
      const data = await history(code);
      if (!data) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: `上市、上櫃都查不到 ${code}` }));
      }
      return res.end(JSON.stringify(data));
    } catch (e) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "資料來源連線失敗：" + e.message }));
    }
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
  }

  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`台股交易助手已啟動：http://localhost:${PORT}`);
});
