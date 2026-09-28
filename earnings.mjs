// =====================================================================
//  EARNINGS BOT — roz 2:00 PM ET pe Telegram
//  Aaj market band hone ke baad (after-hours) jin companies ki earnings hai,
//  har ek ka 3 mahine ka check karke CALL-side (🟢) / PUT-side (🔴) / Neutral (⚪) lean.
//  Data (free): Nasdaq earnings calendar + earnings history, Yahoo price/news/options.
//  ⚠️ Earnings ka direction koi pakka nahi bata sakta — ye sirf data ka jhukav hai.
// =====================================================================

const env = process.env;
const MODE = (env.RUN_MODE || 'normal').toLowerCase();        // normal | force | test
const MIN_MCAP = Number(env.MIN_MCAP || 2e9);                  // $2B se chhoti companies skip
const MAX_STOCKS = parseInt(env.MAX_STOCKS || '8', 10);        // sabse badi 8 companies
const SEND_AT = 14 * 3600;                                     // 2:00 PM ET
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', Accept: 'application/json, text/plain, */*' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (s) => { const v = parseFloat(String(s ?? '').replace(/[$,()%]/g, '')); return Number.isFinite(v) ? (String(s).includes('(') ? -v : v) : null; };

// ---------- time ----------
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function nyParts(d = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;
  return { weekday: p.weekday, date: `${p.year}-${p.month}-${p.day}`, secOfDay: h * 3600 + parseInt(p.minute, 10) * 60 + parseInt(p.second, 10) };
}
const nyDate = (sec) => nyParts(new Date(sec * 1000)).date;

// ---------- telegram ----------
async function tg(text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

async function getJSON(url, headers = {}, tries = 3) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { headers: { ...UA, ...headers } });
      if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(1500 * (a + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; await sleep(1000 * (a + 1)); }
  }
  throw last;
}
const NASDAQ_H = { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };

// ---------- data sources ----------
async function earningsToday(date) {
  const j = await getJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, NASDAQ_H);
  const rows = j?.data?.rows || [];
  return rows
    .filter(r => /after/i.test(r.time || ''))
    .map(r => ({ sym: String(r.symbol || '').toUpperCase().trim(), name: r.name || '', mcap: num(r.marketCap) || 0,
      epsEst: r.epsForecast || '', nEst: r.noOfEsts || '', lastYrEps: r.lastYearEPS || '' }))
    .filter(r => r.sym && !r.sym.includes('.') && r.mcap >= MIN_MCAP)
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, MAX_STOCKS);
}

async function earningsHistory(sym) {
  try {
    const j = await getJSON(`https://api.nasdaq.com/api/company/${sym}/earnings-surprise`, NASDAQ_H, 2);
    const rows = j?.data?.earningsSurpriseTable?.rows || [];
    return rows.map(r => {
      const [m, d, y] = String(r.dateReported || '').split('/').map(Number);
      return { date: y ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null,
        eps: num(r.eps), est: num(r.consensusForecast), surprise: num(r.percentageSurprise) };
    }).filter(r => r.date).slice(0, 4);
  } catch { return []; }
}

async function daily(sym, range = '1y') {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`);
  const r = j?.chart?.result?.[0]; if (!r?.timestamp) throw new Error(`${sym}: no price data`);
  const q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((t, i) => { if (q.close[i] != null) out.push({ t, d: nyDate(t), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
  const live = r.meta?.regularMarketPrice;
  return { bars: out, price: live || out.at(-1).c };
}

async function news(sym) {
  try {
    const j = await getJSON(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=0&newsCount=15`, {}, 2);
    return (j.news || []).map(n => ({ title: n.title || '', t: n.providerPublishTime || 0 }));
  } catch { return []; }
}

// Options expected move (straddle) — Yahoo crumb chahiye; na mile to skip
let CRUMB = null;
async function yahooCrumb() {
  if (CRUMB !== null) return CRUMB;
  try {
    const r = await fetch('https://fc.yahoo.com', { headers: UA, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    const cookie = sc.map(c => c.split(';')[0]).filter(Boolean).join('; ');
    const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, Cookie: cookie } });
    const crumb = (await c.text()).trim();
    CRUMB = (c.ok && crumb && !crumb.includes('<')) ? { cookie, crumb } : false;
  } catch { CRUMB = false; }
  return CRUMB;
}
async function expectedMove(sym, price, today) {
  const cr = await yahooCrumb(); if (!cr) return null;
  try {
    const base = `https://query2.finance.yahoo.com/v7/finance/options/${sym}?crumb=${encodeURIComponent(cr.crumb)}`;
    let j = await getJSON(base, { Cookie: cr.cookie }, 2);
    let res = j?.optionChain?.result?.[0]; if (!res) return null;
    const exp = (res.expirationDates || []).find(e => nyDate(e) > today);   // earnings ke baad wali pehli expiry
    if (!exp) return null;
    if (res.options?.[0]?.expirationDate !== exp) {
      j = await getJSON(`${base}&date=${exp}`, { Cookie: cr.cookie }, 2);
      res = j?.optionChain?.result?.[0];
    }
    const o = res?.options?.[0]; if (!o) return null;
    const mid = (x) => (x && x.bid > 0 && x.ask > 0) ? (x.bid + x.ask) / 2 : (x?.lastPrice || 0);
    const near = (arr) => arr.reduce((b, x) => (!b || Math.abs(x.strike - price) < Math.abs(b.strike - price)) ? x : b, null);
    const c = near(o.calls || []), p = near(o.puts || []);
    if (!c || !p) return null;
    const straddle = mid(c) + mid(p);
    if (!(straddle > 0)) return null;
    return { pct: straddle / price, exp: nyDate(exp), iv: ((c.impliedVolatility || 0) + (p.impliedVolatility || 0)) / 2 };
  } catch { return null; }
}

// ---------- indicators ----------
const sma = (c, n) => c.length >= n ? avg(c.slice(-n)) : null;
function rsi(c, p = 14) {
  if (c.length <= p) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

// pichhli earnings pe stock ka reaction (report din ka close → agle din ka close)
function reactions(bars, hist) {
  const out = [];
  for (const h of hist) {
    const i = bars.findIndex(b => b.d >= h.date);
    if (i < 0 || i + 1 >= bars.length) continue;
    const onDay = bars[i].d === h.date;
    const before = onDay ? bars[i] : bars[i - 1], after = onDay ? bars[i + 1] : bars[i];
    if (!before || !after) continue;
    out.push(after.c / before.c - 1);
  }
  return out;
}

const BULL = /upgrade|beats?\b|raises|raised|record|approv|partnership|contract|buyback|surge|soar|jump|rall(y|ies)|outperform|strong|growth|wins?\b/i;
const BEAR = /downgrade|miss(es|ed)?\b|cuts?\b|lawsuit|sued|probe|investigat|recall|plunge|tumble|slump|sink|warn|delay|layoff|fraud|underperform|weak|decline|falls?\b/i;

// ---------- analysis ----------
async function analyze(e, spy3m, today) {
  const { bars, price } = await daily(e.sym, '1y');
  const past = bars.filter(b => b.d < today);
  const closes = past.map(b => b.c);
  const c63 = past.length > 63 ? past.at(-64).c : past[0].c;
  const r3m = price / c63 - 1;
  const r5d = past.length > 5 ? price / past.at(-6).c - 1 : 0;
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const R = rsi([...closes, price]);

  const hist = await earningsHistory(e.sym);
  const beats = hist.filter(h => h.surprise != null && h.surprise > 0).length;
  const misses = hist.filter(h => h.surprise != null && h.surprise < 0).length;
  const reacts = reactions(bars, hist);
  const ups = reacts.filter(x => x > 0).length, downs = reacts.length - ups;
  const avgMove = avg(reacts.map(Math.abs));

  const nw = (await news(e.sym)).filter(n => n.t >= Date.now() / 1000 - 90 * 86400);
  let nb = 0, nr = 0; for (const n of nw) { if (BULL.test(n.title)) nb++; if (BEAR.test(n.title)) nr++; }

  const em = await expectedMove(e.sym, price, today);

  // --- score (−1..+1 har factor) ---
  const F = [];
  const add = (label, w, s, show) => F.push({ label, w, s: clamp(s), show });
  add('Trend (20/50 din avg)', 1, s20 && s50 ? ((price > s20 ? 0.5 : -0.5) + (price > s50 ? 0.5 : -0.5)) : 0);
  add('3 mahine vs SPY', 1, (r3m - spy3m) / 0.10);
  add('EPS beat history', 1.5, hist.length ? (beats - misses) / hist.length : 0);
  add('Pichhli earnings reaction', 1, reacts.length ? (ups - downs) / reacts.length : 0);
  add('News', 1, nw.length ? (nb - nr) / Math.max(3, nw.length / 2) : 0);
  add('Momentum (RSI)', 0.5, R == null ? 0 : (R - 50) / 25);
  const W = F.reduce((a, f) => a + f.w, 0);
  const score = F.reduce((a, f) => a + f.w * f.s, 0) / W;
  const lean = score >= 0.25 ? 'BULL' : score <= -0.25 ? 'BEAR' : 'NEUTRAL';

  // --- warnings ---
  const warn = ['IV crush: earnings ke baad option premium tezi se girta hai — direction sahi hone pe bhi loss ho sakta hai'];
  if (em && reacts.length && em.pct > avgMove * 1.2) warn.push(`Options mehenge: market ±${(em.pct * 100).toFixed(1)}% move maan raha hai, jabki pichhli baar avg ±${(avgMove * 100).toFixed(1)}% hi hua`);
  if (r5d > 0.08) warn.push(`Earnings se pehle ${pct(r5d)} chal chuka hai — "sell the news" ka risk`);
  if (r5d < -0.08) warn.push(`Earnings se pehle ${pct(r5d)} gir chuka hai — bounce ka risk`);
  if (R != null && R > 75) warn.push(`RSI ${R.toFixed(0)} — bahut overbought`);
  if (R != null && R < 25) warn.push(`RSI ${R.toFixed(0)} — bahut oversold`);
  if (lean === 'NEUTRAL') warn.push('Data mein saaf jhukav nahi — skip karna bhi ek option hai');

  return { e, price, r3m, r5d, R, hist, beats, misses, reacts, ups, downs, avgMove, nw, nb, nr, em, score, lean, warn, F };
}

function message(a, spy3m) {
  const { e } = a;
  const tag = a.lean === 'BULL' ? '🟢 BULLISH' : a.lean === 'BEAR' ? '🔴 BEARISH' : '⚪ NEUTRAL';
  const L = [
    `<b>🔔 ${esc(e.sym)}</b>  ${esc(e.name.replace(/,? Inc\.?$|,? Corp(oration)?\.?$/i, ''))}`,
    `<b>Price: $${a.price.toFixed(2)}</b>`,
    `<b>${tag}</b>  (score ${a.score >= 0 ? '+' : ''}${a.score.toFixed(2)})`,
    '',
    ...a.warn.map(w => `⚠️ ${esc(w)}`),
    '',
    `📅 Earnings: aaj market band hone ke baad${e.epsEst ? ` | EPS est ${esc(e.epsEst)}${e.nEst ? ` (${esc(e.nEst)} analysts)` : ''}` : ''}`,
    `📈 3 mahine: ${pct(a.r3m)} (SPY ${pct(spy3m)}) | 5 din: ${pct(a.r5d)}${a.R != null ? ` | RSI ${a.R.toFixed(0)}` : ''}`,
  ];
  if (a.hist.length) L.push(`🎯 Pichhli ${a.hist.length} earnings: ${a.beats} beat, ${a.misses} miss${a.reacts.length ? ` | Agle din: ⬆️${a.ups} ⬇️${a.downs}, avg ±${(a.avgMove * 100).toFixed(1)}%` : ''}`);
  if (a.em) L.push(`💰 Options expected move: ±${(a.em.pct * 100).toFixed(1)}% (expiry ${a.em.exp})`);
  L.push(`📰 News (3 mahine): ${a.nw.length} | 📈${a.nb} 📉${a.nr}${a.nw[0] ? `\n   "${esc(a.nw[0].title.slice(0, 100))}"` : ''}`);
  L.push('', '<i>Not financial advice — earnings pe koi pakka direction nahi hota.</i>');
  return L.join('\n');
}

async function main() {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error('Telegram secrets missing');
  if (MODE === 'test') { await tg('✅ Test — <b>Earnings bot</b> connected hai!'); return console.log('sent'); }

  const n = nyParts();
  let today = env.EARN_DATE || n.date;
  if (MODE !== 'force') {
    if (n.weekday === 'Sat' || n.weekday === 'Sun') return console.log('weekend');
    if (n.secOfDay < SEND_AT - 45 * 60) return console.log('DST ka doosra run — skip');
    if (n.secOfDay > SEND_AT + 60 * 60) return console.log('bahut late — skip');
    if (n.secOfDay < SEND_AT) { console.log(`2:00 PM tak ruk rahe (${SEND_AT - n.secOfDay}s)`); await sleep((SEND_AT - n.secOfDay) * 1000); }
  }

  let list;
  try { list = await earningsToday(today); }
  catch (e) { await tg(`⚠️ Earnings bot: calendar nahi mila (${esc(String(e).slice(0, 100))})`); throw e; }
  if (!list.length) { await tg(`📅 ${today}: aaj market ke baad koi badi (>$${MIN_MCAP / 1e9}B) earnings nahi.`); return; }

  const spy = await daily('SPY', '6mo');
  const sp = spy.bars.filter(b => b.d < today);
  const spy3m = spy.price / (sp.length > 63 ? sp.at(-64).c : sp[0].c) - 1;

  await tg(`📅 <b>Aaj market band hone ke baad earnings (${list.length}):</b>\n${list.map(x => `• <b>${esc(x.sym)}</b> — ${esc(x.name)}`).join('\n')}\n\nHar ek ki detail neeche 👇`);

  for (const e of list) {
    try {
      const a = await analyze(e, spy3m, today);
      await tg(message(a, spy3m));
      console.log(e.sym, a.lean, a.score.toFixed(2));
    } catch (err) {
      console.error(e.sym, err);
      await tg(`<b>🔔 ${esc(e.sym)}</b>\n⚠️ Iska data nahi mil paaya (${esc(String(err).slice(0, 80))})`);
    }
    await sleep(800);
  }
}

main().catch(async (e) => { console.error(e); process.exit(1); });
