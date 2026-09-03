/* FX Desks — live data layer.
   Source: Frankfurter (ECB daily reference rates, CORS-open, keyless).
   Fallback: open.er-api.com for latest if Frankfurter is down (no history). */
(function () {
  "use strict";
  const API = "https://api.frankfurter.dev/v1";
  const $ = (id) => document.getElementById(id);

  /* ── currency metadata ─────────────────────────────── */
  const META = {
    EUR: ["Euro", "€", "eur", "majors"],   GBP: ["British Pound", "£", "gbp", "majors"],
    JPY: ["Japanese Yen", "¥", "jpy", "majors"], CHF: ["Swiss Franc", "₣", "chf", "majors"],
    AUD: ["Australian Dollar", "$", "oce", "majors"], CAD: ["Canadian Dollar", "$", "usd", "majors"],
    NZD: ["New Zealand Dollar", "$", "oce", "majors"],
    CNY: ["Chinese Yuan", "¥", "asi", "asia"], HKD: ["Hong Kong Dollar", "$", "asi", "asia"],
    SGD: ["Singapore Dollar", "$", "asi", "asia"], KRW: ["South Korean Won", "₩", "asi", "asia"],
    INR: ["Indian Rupee", "₹", "asi", "asia"], IDR: ["Indonesian Rupiah", "Rp", "asi", "asia"],
    MYR: ["Malaysian Ringgit", "RM", "asi", "asia"], THB: ["Thai Baht", "฿", "asi", "asia"],
    PHP: ["Philippine Peso", "₱", "asi", "asia"],
    SEK: ["Swedish Krona", "kr", "nor", "europe"], NOK: ["Norwegian Krone", "kr", "nor", "europe"],
    DKK: ["Danish Krone", "kr", "nor", "europe"], PLN: ["Polish Złoty", "zł", "eur", "europe"],
    CZK: ["Czech Koruna", "Kč", "eur", "europe"], HUF: ["Hungarian Forint", "Ft", "eur", "europe"],
    RON: ["Romanian Leu", "L", "eur", "europe"], BGN: ["Bulgarian Lev", "лв", "eur", "europe"],
    ISK: ["Icelandic Króna", "kr", "nor", "europe"], TRY: ["Turkish Lira", "₺", "oth", "exotics"],
    MXN: ["Mexican Peso", "$", "oth", "exotics"], BRL: ["Brazilian Real", "R$", "oth", "exotics"],
    ZAR: ["South African Rand", "R", "oth", "exotics"], ILS: ["Israeli Shekel", "₪", "oth", "exotics"],
  };
  const INVERT = new Set(["EUR", "GBP", "AUD", "NZD"]); // quoted CCY/USD by convention
  const CROSSES = [["EUR","GBP"],["EUR","JPY"],["EUR","CHF"],["GBP","JPY"],["AUD","JPY"],["EUR","AUD"]];
  const state = { pairs: [], filter: "all", q: "", sort: "move", page: 0, PAGE: 10, updated: null };

  /* ── formatting (magnitude-aware) ──────────────────── */
  const fmtRate = (v) => {
    if (!isFinite(v)) return "—";
    if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (v >= 100) return v.toFixed(2);
    if (v >= 10) return v.toFixed(3);
    return v.toFixed(4);
  };
  const fmtDelta = (d) => (d == null || !isFinite(d)) ? "—" : `${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(2)}%`;
  const deltaCls = (d) => (d == null || !isFinite(d)) ? "fl" : d >= 0 ? "up" : "dn";

  /* ── sparkline svg ─────────────────────────────────── */
  function spark(points, w, h, big) {
    if (!points || points.length < 2) return "";
    const min = Math.min(...points), max = Math.max(...points), span = (max - min) || 1;
    const up = points[points.length - 1] >= points[0];
    const col = up ? "var(--phos)" : "var(--alert)";
    const xs = points.map((p, i) => [i / (points.length - 1) * w, h - 3 - (p - min) / span * (h - 6)]);
    const line = xs.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
    const gid = "g" + (spark._n = (spark._n || 0) + 1);
    const area = `${line}L${w} ${h}L0 ${h}Z`;
    return `<svg class="fx-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${col}" stop-opacity=".28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="${col}" stroke-width="${big ? 1.8 : 1.4}" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
  }
  const badge = (code) => {
    const m = META[code] || [code, code[0], "oth"];
    return `<span class="fx-badge" data-hue="${m[2]}" aria-hidden="true">${m[1]}</span>`;
  };

  /* ── pair construction ─────────────────────────────── */
  function buildPairs(series, dates) {
    const out = [];
    const seriesOf = (ccy) => dates.map((d) => series[d]?.[ccy]).filter((v) => v != null);
    for (const ccy of Object.keys(META)) {
      let pts = seriesOf(ccy);
      if (pts.length < 2) continue;
      let base = "USD", quote = ccy, code, name;
      if (INVERT.has(ccy)) { pts = pts.map((v) => 1 / v); code = `${ccy}/USD`; name = `${META[ccy][0]} / US Dollar`; }
      else { code = `USD/${ccy}`; name = `US Dollar / ${META[ccy][0]}`; }
      out.push(mk(code, name, ccy, pts, META[ccy][3]));
    }
    for (const [a, b] of CROSSES) {
      const pa = seriesOf(a), pb = seriesOf(b);
      const n = Math.min(pa.length, pb.length);
      if (n < 2) continue;
      const pts = Array.from({ length: n }, (_, i) => pb[pb.length - n + i] / pa[pa.length - n + i]);
      out.push(mk(`${a}/${b}`, `${META[a][0]} / ${META[b][0]}`, a, pts, "crosses"));
    }
    return out;
  }
  function mk(code, name, iconCcy, pts, region) {
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const d1 = prev ? (last / prev - 1) * 100 : null;
    const rets = pts.slice(1).map((v, i) => v / pts[i] - 1);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const vol = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) * 100;
    return { code, name, iconCcy, pts, rate: last, d1, vol, region,
      majors: region === "majors", search: `${code} ${name}`.toLowerCase() };
  }

  /* ── renderers ─────────────────────────────────────── */
  function renderRail(pairs) {
    const items = pairs.filter((p) => p.majors || p.region === "crosses").slice(0, 14);
    const html = items.map((p) =>
      `<span class="fx-tick">${badge(p.iconCcy).replace('fx-badge"', 'fx-badge sm"')}<b>${p.code}</b><span class="v">${fmtRate(p.rate)}</span><span class="${p.d1 >= 0 ? "up" : "dn"}">${fmtDelta(p.d1)}</span></span>`
    ).join('<span class="fx-tick" aria-hidden="true">·</span>');
    $("railTrack").innerHTML = html + '<span class="fx-tick" aria-hidden="true">·</span>' + html; // doubled for seamless loop
  }
  function renderCards(pairs) {
    const bench = pairs.find((p) => p.code === "EUR/USD");
    const volat = [...pairs].sort((a, b) => b.vol - a.vol)[0];
    const mover = [...pairs].sort((a, b) => Math.abs(b.d1) - Math.abs(a.d1))[0];
    const defs = [["Benchmark pair", bench], ["Most volatile (30d)", volat], ["Biggest mover (24h)", mover]];
    $("cards").innerHTML = defs.map(([label, p]) => p ? `
      <div class="fx-card-wrap"><div class="fx-card-label">${label}</div>
        <div class="fx-card">
          <div style="height:80px;width:100%">${spark(p.pts, 300, 80, true)}</div>
          <div class="fx-card-foot">
            <span class="fx-card-name">${badge(p.iconCcy)}<span class="nm">${p.code}</span></span>
            <span class="fx-card-delta ${deltaCls(p.d1)}" style="color:${p.d1 >= 0 ? "var(--phos)" : "var(--alert)"}">${fmtDelta(p.d1)}</span>
          </div>
        </div></div>` : "").join("");
  }
  const CHIPS = [["all","All"],["majors","Majors"],["crosses","Crosses"],["europe","Europe"],["asia","Asia-Pacific"],["exotics","Exotics"]];
  function renderChips() {
    $("chips").innerHTML = CHIPS.map(([k, l]) =>
      `<button type="button" class="fx-chip${state.filter === k ? " on" : ""}" data-f="${k}">${l}</button>`).join("");
    $("chips").querySelectorAll(".fx-chip").forEach((b) =>
      b.addEventListener("click", () => { state.filter = b.dataset.f; state.page = 0; renderChips(); renderTable(); }));
  }
  function visible() {
    let v = state.pairs;
    if (state.filter !== "all") v = v.filter((p) => p.region === state.filter);
    if (state.q) v = v.filter((p) => p.search.includes(state.q));
    const s = state.sort;
    v = [...v].sort((a, b) => s === "name" ? a.code.localeCompare(b.code)
      : s === "rate" ? b.rate - a.rate : s === "vol" ? b.vol - a.vol : Math.abs(b.d1) - Math.abs(a.d1));
    return v;
  }
  function renderTable() {
    const v = visible();
    const maxPage = Math.max(0, Math.ceil(v.length / state.PAGE) - 1);
    state.page = Math.min(state.page, maxPage);
    const slice = v.slice(state.page * state.PAGE, (state.page + 1) * state.PAGE);
    $("tbody").innerHTML = slice.map((p) => `
      <div class="fx-row">
        <span class="fx-pairname">${badge(p.iconCcy)}
          <span style="min-width:0"><span class="nm">${p.code}</span> <span class="tk">${p.name}</span></span>
          <button class="fx-copy" type="button" data-copy="${p.code}" aria-label="Copy pair code" title="Copy">
            <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M10 4V3a1.5 1.5 0 0 0-1.5-1.5h-5A1.5 1.5 0 0 0 2 3v5A1.5 1.5 0 0 0 3.5 9.5H4"/></svg>
          </button></span>
        <span class="fx-r fx-rate">${fmtRate(p.rate)}</span>
        <span class="fx-r fx-delta ${deltaCls(p.d1)}">${fmtDelta(p.d1)}</span>
        <span class="fx-r fx-spark-cell fx-hidemob">${spark(p.pts, 120, 30)}</span>
      </div>`).join("") || `<div class="fx-row"><span class="text-[11.5px] text-muted">No pairs match.</span></div>`;
    const from = v.length ? state.page * state.PAGE + 1 : 0;
    $("pageLabel").textContent = `${from}–${Math.min(v.length, (state.page + 1) * state.PAGE)} of ${v.length}`;
    $("pgPrev").disabled = state.page === 0; $("pgNext").disabled = state.page >= maxPage;
    $("tbody").querySelectorAll(".fx-copy").forEach((b) => b.addEventListener("click", () => {
      navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy).catch(() => {});
    }));
  }
  function renderMovers(pairs) {
    const sorted = [...pairs].filter((p) => p.d1 != null).sort((a, b) => b.d1 - a.d1);
    const row = (p) => `<div class="fx-mover"><span class="l">${badge(p.iconCcy).replace('fx-badge"', 'fx-badge sm"')}<span class="nm">${p.code}</span></span><span class="fx-delta ${deltaCls(p.d1)}">${fmtDelta(p.d1)}</span></div>`;
    $("gainers").innerHTML = sorted.slice(0, 5).map(row).join("");
    $("losers").innerHTML = sorted.slice(-5).reverse().map(row).join("");
  }

  /* ── converter ─────────────────────────────────────── */
  let latestUSD = null; // { CCY: rate per USD }
  function convSetup() {
    const codes = ["USD", ...Object.keys(META)];
    const opts = codes.map((c) => `<option value="${c}">${c} — ${c === "USD" ? "US Dollar" : META[c][0]}</option>`).join("");
    $("cvFrom").innerHTML = opts; $("cvTo").innerHTML = opts;
    $("cvFrom").value = "USD"; $("cvTo").value = "EUR";
    const upd = () => {
      if (!latestUSD) return;
      const amt = parseFloat($("cvAmt").value.replace(/[,\s]/g, ""));
      const f = $("cvFrom").value, t = $("cvTo").value;
      const perUSD = (c) => (c === "USD" ? 1 : latestUSD[c]);
      if (!isFinite(amt) || perUSD(f) == null || perUSD(t) == null) { $("cvOut").textContent = "—"; $("cvRate").textContent = ""; return; }
      const rate = perUSD(t) / perUSD(f);
      $("cvOut").textContent = `${(amt * rate).toLocaleString(undefined, { maximumFractionDigits: rate * amt >= 100 ? 2 : 4 })} ${t}`;
      $("cvRate").textContent = `1 ${f} = ${fmtRate(rate)} ${t} · mid-market`;
    };
    ["cvAmt", "cvFrom", "cvTo"].forEach((id) => $(id).addEventListener("input", upd));
    $("cvSwap").addEventListener("click", () => { const f = $("cvFrom").value; $("cvFrom").value = $("cvTo").value; $("cvTo").value = f; upd(); });
    convSetup.update = upd;
  }

  /* ── wiring ────────────────────────────────────────── */
  $("searchBox").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); state.page = 0; renderTable(); });
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("searchBox").focus(); } });
  $("sortSel").addEventListener("change", (e) => { state.sort = e.target.value; state.page = 0; renderTable(); });
  $("pgPrev").addEventListener("click", () => { state.page--; renderTable(); });
  $("pgNext").addEventListener("click", () => { state.page++; renderTable(); });
  $("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", cur);
    try { localStorage.setItem("fx-theme", cur); } catch (e) {}
  });
  document.querySelectorAll("[data-filter]").forEach((a) => a.addEventListener("click", () => {
    state.filter = a.dataset.filter; state.page = 0; renderChips(); renderTable();
  }));

  /* ── boot ──────────────────────────────────────────── */
  async function boot() {
    const end = new Date(), start = new Date(end.getTime() - 35 * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);
    try {
      const hist = await (await fetch(`${API}/${iso(start)}..${iso(end)}?base=USD`)).json();
      const dates = Object.keys(hist.rates).sort();
      latestUSD = hist.rates[dates[dates.length - 1]];
      state.updated = hist.end_date || dates[dates.length - 1];
      state.pairs = buildPairs(hist.rates, dates);
    } catch (err) {
      try { // fallback: latest only, no history
        const er = await (await fetch("https://open.er-api.com/v6/latest/USD")).json();
        latestUSD = er.rates; state.updated = (er.time_last_update_utc || "").slice(0, 16);
        state.pairs = Object.keys(META).filter((c) => er.rates[c]).map((c) => {
          const v = INVERT.has(c) ? 1 / er.rates[c] : er.rates[c];
          return mk(INVERT.has(c) ? `${c}/USD` : `USD/${c}`, `${META[c][0]}`, c, [v, v], META[c][3]);
        });
      } catch (e2) { $("updated").textContent = "Rates unavailable — retry shortly."; return; }
    }
    renderRail(state.pairs); renderCards(state.pairs); renderChips(); renderTable(); renderMovers(state.pairs);
    convSetup(); convSetup.update();
    $("updated").textContent = `Last updated ${state.updated} · ECB reference fix`;
  }
  boot();
})();
