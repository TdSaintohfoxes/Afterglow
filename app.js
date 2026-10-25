/* Afterglow app: TMDB fetching, screens, feedback loop. The ranking lives in engine.js. */
(() => {
"use strict";

const E = globalThis.AfterglowEngine;
const IMG = "https://image.tmdb.org/t/p/";
const REGIONS = { NG: "Nigeria", GH: "Ghana", KE: "Kenya", ZA: "South Africa", GB: "United Kingdom", US: "United States", CA: "Canada", AU: "Australia", IN: "India", JP: "Japan" };
const NOW_YEAR = new Date().getFullYear();

const DEFAULT_SEEDS = [
  { title: "Cowboy Bebop", year: 1998, type: "tv", w: 1.6 },
  { title: "Monster", year: 2004, type: "tv", w: 1 },
  { title: "Berserk", year: 1997, type: "tv", w: 1 },
  { title: "Neon Genesis Evangelion", year: 1995, type: "tv", w: 1 },
  { title: "Blade Runner", year: 1982, type: "movie", w: 1.6 },
  { title: "In the Mood for Love", year: 2000, type: "movie", w: 1 },
  { title: "Chungking Express", year: 1994, type: "movie", w: 1 },
  { title: "Se7en", year: 1995, type: "movie", w: 1 },
  { title: "Zodiac", year: 2007, type: "movie", w: 1 },
  { title: "Pulp Fiction", year: 1994, type: "movie", w: 1 }
];

// Moods resolve to TMDB keyword ids at runtime, then the taste model ranks what comes back.
const MOODS = [
  { id: "neon", label: "Neon & rain", terms: ["cyberpunk", "neo-noir", "dystopia"] },
  { id: "ache", label: "Slow ache", terms: ["melancholy", "loneliness", "unrequited love"] },
  { id: "gray", label: "Morally gray", terms: ["anti hero", "moral ambiguity", "corruption"] },
  { id: "steel", label: "Steel & honor", terms: ["samurai", "ronin", "feudal japan"] },
  { id: "mind", label: "Mind bend", terms: ["mind bending", "surrealism", "psychological thriller"] },
  { id: "cold", label: "Cold trail", terms: ["serial killer", "detective", "investigation"] },
  { id: "rites", label: "Dark rites", terms: ["cult", "occult", "folk horror"] },
  { id: "revenge", label: "Revenge", terms: ["revenge", "vigilante", "hitman"] }
];

const STARTERS = [
  ["Samurai Champloo", 2004, "tv", "Cowboy Bebop's director, hip-hop and ronin."],
  ["Paranoia Agent", 2004, "tv", "Satoshi Kon's unraveling city."],
  ["Serial Experiments Lain", 1998, "tv", "Identity dissolving into the network."],
  ["Mindhunter", 2017, "tv", "Fincher's patience, stretched across seasons."],
  ["Memories of Murder", 2003, "movie", "Unsolved case, moral fog."],
  ["Blade Runner 2049", 2017, "movie", "Slow, gorgeous, lonely."],
  ["2046", 2004, "movie", "Wong Kar-wai with science fiction as memory."],
  ["Vinland Saga", 2019, "tv", "Berserk-level violence, an argument about strength."]
];

const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e;
};
const svgIcon = (d) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p); return s; };

// ---------- storage ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};
const defaults = { key: "", region: "NG", type: "all", anime: "include", minRating: 6.5, since: 1970, adv: 0.35, lib: "watch", seeds: DEFAULT_SEEDS.map((s) => ({ ...s })), fb: {}, watch: {} };
const state = Object.assign({}, defaults, LS.get("ag.state", {}));
state.view = ["discover", "library", "taste"].includes(new URLSearchParams(location.search).get("view")) ? new URLSearchParams(location.search).get("view") : "discover";
const persist = () => { const { view, ...rest } = state; LS.set("ag.state", rest); };

let dc = LS.get("ag.dc", {});
let dcTimer;
function saveDC() {
  clearTimeout(dcTimer);
  dcTimer = setTimeout(() => {
    const keys = Object.keys(dc);
    if (keys.length > 1400) for (const k of keys.slice(0, keys.length - 1100)) delete dc[k];
    if (!LS.set("ag.dc", dc)) { for (const k of Object.keys(dc).slice(0, Math.floor(Object.keys(dc).length * 0.6))) delete dc[k]; LS.set("ag.dc", dc); }
  }, 900);
}

const S = { cands: LS.get("ag.cands", []), rows: [], busy: false, progress: null, mood: null, moodRows: {}, provCache: new Map(), vidCache: new Map(), deferred: null };

// ---------- TMDB ----------
async function tmdb(path, params = {}) {
  const url = new URL("https://api.themoviedb.org/3" + path);
  const headers = {};
  if (state.key.length > 40) headers.Authorization = "Bearer " + state.key;
  else url.searchParams.set("api_key", state.key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers });
  if (r.status === 401) throw new Error("auth");
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}
async function runPool(items, n, fn, tick) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { if (e.message === "auth") throw e; out[k] = null; }
      done++; if (tick) tick(done, items.length);
    }
  }));
  return out;
}
const yearOf = (x) => Number(String(x.release_date || x.first_air_date || "").slice(0, 4)) || 0;

function slimDetails(x, type) {
  const kw = type === "tv" ? (x.keywords && x.keywords.results) || [] : (x.keywords && x.keywords.keywords) || [];
  const crew = (x.credits && x.credits.crew) || [], cast = (x.credits && x.credits.cast) || [];
  let dirs = type === "tv" ? (x.created_by || []).map((p) => [p.id, p.name]) : [];
  if (!dirs.length) dirs = crew.filter((p) => p.job === "Director").slice(0, 2).map((p) => [p.id, p.name]);
  return {
    key: type + ":" + x.id, id: x.id, type, title: x.title || x.name || "Untitled", year: yearOf(x),
    poster: x.poster_path || "", backdrop: x.backdrop_path || "", rating: x.vote_average || 0, votes: x.vote_count || 0,
    overview: x.overview || "", genres: (x.genres || []).map((g) => g.id), kw: kw.slice(0, 22).map((k) => [k.id, k.name]),
    dir: dirs.slice(0, 2), cast: cast.slice(0, 5).map((p) => [p.id, p.name]), lang: x.original_language || "",
    runtime: type === "tv" ? (x.episode_run_time && x.episode_run_time[0]) || 0 : x.runtime || 0, seasons: x.number_of_seasons || 0
  };
}
async function getDetails(type, id) {
  const key = type + ":" + id;
  if (dc[key]) return dc[key];
  const x = await tmdb(`/${type}/${id}`, { append_to_response: "keywords,credits" });
  const d = slimDetails(x, type);
  dc[key] = d; saveDC();
  return d;
}
async function resolveSeed(s) {
  if (s.d) return s;
  const d = await tmdb("/search/multi", { query: s.title, include_adult: "false" });
  let r = (d.results || []).filter((x) => x.media_type === "movie" || x.media_type === "tv");
  if (s.type) { const p = r.filter((x) => x.media_type === s.type); if (p.length) r = p; }
  if (s.year) { const p = r.filter((x) => Math.abs(yearOf(x) - s.year) <= 1); if (p.length) r = p; }
  if (!r[0]) return null;
  s.d = await getDetails(r[0].media_type, r[0].id);
  s.title = s.d.title; s.type = s.d.type;
  return s;
}
const isAnime = (d) => (d.genres || []).includes(16) && d.lang === "ja";
const kindOf = (d) => (d.type === "tv" ? (isAnime(d) ? "Anime series" : "Series") : isAnime(d) ? "Anime film" : "Film");

// ---------- taste ----------
function entries() {
  const out = [];
  for (const s of state.seeds) if (s.d) out.push({ d: s.d, w: s.w || 1, title: s.d.title });
  const wt = { love: 1.6, seen: 0.4, skip: -0.7 };
  for (const f of Object.values(state.fb)) if (f.it) out.push({ d: f.it, w: wt[f.s], title: f.it.title });
  for (const [k, it] of Object.entries(state.watch)) if (!state.fb[k]) out.push({ d: it, w: 0.3, title: it.title });
  return out;
}
function excluded() {
  const ex = new Set(Object.keys(state.fb));
  Object.keys(state.watch).forEach((k) => ex.add(k));
  state.seeds.forEach((s) => s.d && ex.add(s.d.key));
  return ex;
}
const lambda = () => 0.7 - 0.2 * state.adv;

// ---------- the pipeline ----------
function setProgress(label, p) { S.progress = label ? { label, p } : null; paintProgress(); }

async function findPicks() {
  if (S.busy) return;
  if (!state.key) { go("discover"); toast("Add your TMDB key to get live picks."); return; }
  if (!navigator.onLine) { toast("You're offline. Showing your last picks."); return; }
  S.busy = true; $("#refreshBtn").classList.add("spin"); setProgress("Reading your taste", 0.05); render();
  try {
    await runPool(state.seeds, 6, resolveSeed);
    const before = state.seeds.length;
    state.seeds = state.seeds.filter((s) => s.d);
    if (state.seeds.length < before) toast("Some titles couldn't be matched and were skipped.");
    persist();
    const ent = entries();
    if (!ent.some((e) => e.w > 0)) throw new Error("noseeds");

    setProgress("Finding what people with your taste watched", 0.15);
    const anchors = ent.filter((e) => e.w >= 1);
    const jobs = anchors.flatMap((a) => [["recommendations", 1, a], ["similar", 0.5, a]]);
    const res = await runPool(jobs, 8, ([k, , a]) => tmdb(`/${a.d.type}/${a.d.id}/${k}`));
    const map = new Map();
    const add = (x, type, score, src) => {
      const key = type + ":" + x.id;
      let e = map.get(key);
      if (!e) { e = { key, type, collab: 0, src: new Set(), d: { key, id: x.id, type, title: x.title || x.name || "", year: yearOf(x), genres: x.genre_ids || [], rating: x.vote_average || 0, votes: x.vote_count || 0, poster: x.poster_path || "" } }; map.set(key, e); }
      e.collab += score; e.src.add(src);
    };
    jobs.forEach(([, w, a], j) => ((res[j] && res[j].results) || []).forEach((x, i) => add(x, a.d.type, w * a.w * (1 - i / 40), "rec")));

    setProgress("Searching for the same moods and directors", 0.35);
    const ds = E.discoverSeeds(ent);
    const tg = E.buildTaste(ent).g;
    const topG = Object.entries(tg).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([g]) => Number(g)).slice(0, 3);
    const since = new Date(Date.now() - 548 * 864e5).toISOString().slice(0, 10);
    const dj = [];
    for (const type of ["movie", "tv"]) {
      if (ds.keywords.length) {
        const kw = ds.keywords.slice(0, 3).join("|");
        dj.push([type, "kw", { with_keywords: kw, sort_by: "popularity.desc", "vote_count.gte": 200 }]);
        dj.push([type, "kw", { with_keywords: kw, sort_by: "vote_average.desc", "vote_count.gte": 400 }]);
      }
      const gs = [...new Set(topG.map((g) => (type === "tv" ? ({ 878: 10765, 14: 10765, 28: 10759, 12: 10759, 10752: 10768 }[g] || g) : g)))];
      if (gs.length) dj.push([type, "fresh", { with_genres: gs.join("|"), sort_by: "popularity.desc", "vote_count.gte": 120, [type === "tv" ? "first_air_date.gte" : "primary_release_date.gte"]: since }]);
    }
    ds.people.slice(0, 3).forEach((id) => dj.push(["movie", "dir", { with_crew: id, sort_by: "vote_average.desc", "vote_count.gte": 300 }]));
    const dres = await runPool(dj, 6, ([type, , p]) => tmdb(`/discover/${type}`, { include_adult: "false", ...p }));
    dj.forEach(([type, src], j) => ((dres[j] && dres[j].results) || []).forEach((x, i) => add(x, type, src === "fresh" ? 0.12 : 0.28 * (1 - i / 30), src)));

    const ex = excluded();
    const all = [...map.values()].filter((e) => !ex.has(e.key) && e.d.votes >= 40);
    const maxC = Math.max(...all.map((e) => e.collab), 1e-6);
    const scored = all.map((e) => { const c = { d: e.d, collab: e.collab / maxC, src: [...e.src] }; c.pre = E.preScore(c, tg); return c; }).sort((a, b) => b.pre - a.pre);
    const pick = scored.slice(0, 80);
    const freshExtra = scored.filter((c) => c.src.includes("fresh") && !pick.includes(c) && c.d.year >= NOW_YEAR - 1).slice(0, 14);
    const chosen = pick.concat(freshExtra);

    setProgress("Reading each candidate's moods, directors and cast", 0.5);
    const full = await runPool(chosen, 8, (c) => getDetails(c.d.type, c.d.id), (n, t) => setProgress("Reading each candidate's moods, directors and cast", 0.5 + 0.45 * n / t));
    S.cands = chosen.map((c, i) => (full[i] ? { d: full[i], collab: c.collab, src: c.src } : null)).filter(Boolean);
    LS.set("ag.cands", S.cands);
    if (!S.cands.length) toast("TMDB returned nothing. Try adding a few more titles.");
  } catch (e) {
    if (e.message === "auth") { toast("TMDB rejected that key. Check it in Taste."); }
    else if (e.message === "noseeds") toast("Couldn't match your titles. Try adding the year, like Dark (2017).");
    else toast("Couldn't reach TMDB. Showing your last picks.");
  } finally {
    S.busy = false; $("#refreshBtn").classList.remove("spin"); setProgress(null);
    rerank();
  }
}

function rerank() {
  S.rows = E.rank(S.cands, { entries: entries(), adv: state.adv, exclude: excluded() });
  render();
  updateAmbient();
}

// ---------- moods ----------
async function loadMood(m) {
  state.mood = m.id; render();
  if (S.moodRows[m.id]) return;
  if (!state.key || !navigator.onLine) { toast("Moods need a connection and your TMDB key."); state.mood = null; render(); return; }
  S.busy = true; setProgress(`Tuning to "${m.label}"`, 0.1); render();
  try {
    const kwCache = LS.get("ag.kw", {});
    const ids = [];
    await runPool(m.terms, 3, async (t) => {
      if (!kwCache[t]) { const r = await tmdb("/search/keyword", { query: t }); kwCache[t] = (r.results || []).slice(0, 2).map((k) => k.id); }
      ids.push(...kwCache[t]);
    });
    LS.set("ag.kw", kwCache);
    const kw = [...new Set(ids)].join("|");
    if (!kw) throw new Error("nokw");
    const jobs = [];
    for (const type of ["movie", "tv"]) for (const sort of ["popularity.desc", "vote_average.desc"]) jobs.push([type, sort]);
    const res = await runPool(jobs, 4, ([type, sort]) => tmdb(`/discover/${type}`, { with_keywords: kw, sort_by: sort, "vote_count.gte": sort.startsWith("vote") ? 300 : 120, include_adult: "false" }));
    const map = new Map();
    jobs.forEach(([type], j) => ((res[j] && res[j].results) || []).forEach((x) => {
      const key = type + ":" + x.id;
      if (!map.has(key)) map.set(key, { key, id: x.id, type, rating: x.vote_average || 0, votes: x.vote_count || 0 });
    }));
    const ex = excluded();
    const list = [...map.values()].filter((e) => !ex.has(e.key) && e.votes >= 60).sort((a, b) => (b.rating * Math.log10(b.votes + 10)) - (a.rating * Math.log10(a.votes + 10))).slice(0, 44);
    setProgress(`Tuning to "${m.label}"`, 0.4);
    const full = await runPool(list, 8, (e) => getDetails(e.type, e.id), (n, t) => setProgress(`Tuning to "${m.label}"`, 0.4 + 0.55 * n / t));
    S.moodRows[m.id] = full.filter(Boolean).map((d) => ({ d, collab: 0, src: ["mood"] }));
  } catch (e) {
    toast(e.message === "auth" ? "TMDB rejected that key." : "Couldn't build that mood right now.");
    state.mood = null;
  } finally { S.busy = false; setProgress(null); render(); }
}
function moodList() {
  const cs = S.moodRows[state.mood] || [];
  return E.rank(cs, { entries: entries(), adv: state.adv, exclude: excluded() });
}

// ---------- filters ----------
function passes(r) {
  const d = r.d;
  if (state.type !== "all" && d.type !== state.type) return false;
  const a = isAnime(d);
  if (state.anime === "only" && !a) return false;
  if (state.anime === "none" && a) return false;
  if (d.rating < state.minRating) return false;
  if (d.year && d.year < state.since) return false;
  return true;
}

// ---------- pieces ----------
function posterEl(d, w = "w342") {
  const ph = () => h("div", { class: "ph" }, d.title);
  if (!d.poster) return ph();
  const img = h("img", { src: IMG + w + d.poster, alt: "Poster for " + d.title, loading: "lazy", crossorigin: "anonymous", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(ph()));
  return img;
}
const metaLine = (d) => h("div", { class: "meta" }, h("b", {}, kindOf(d)), d.year ? h("span", {}, String(d.year)) : null, d.rating ? h("span", {}, "★ " + d.rating.toFixed(1)) : null,
  d.runtime ? h("span", {}, d.type === "tv" ? d.runtime + " min/ep" : Math.floor(d.runtime / 60) + "h " + (d.runtime % 60) + "m") : null,
  d.seasons ? h("span", {}, d.seasons + (d.seasons === 1 ? " season" : " seasons")) : null);

function pc(r) {
  const d = r.d;
  return h("button", { class: "pc", type: "button", onclick: () => openSheet(r) },
    h("div", { class: "pimg" }, posterEl(d), r.match ? h("span", { class: "mb" }, r.match + "%") : null),
    h("div", { class: "pt" }, d.title),
    h("div", { class: "ps" }, [d.year || "", d.type === "tv" ? "Series" : "Film"].filter(Boolean).join(" · ")));
}
const sectionHead = (t, note) => h("div", { class: "sec-h" }, h("h2", {}, t), note ? h("p", {}, note) : null);
function becauseLine(r) {
  if (r.because && r.because.length) return h("p", { class: "because" }, "Because you like ", h("b", {}, r.because.join(" + ")));
  return null;
}
function whyTags(r) { return r.why && r.why.length ? h("div", { class: "tags" }, r.why.map((w) => h("span", { class: "tag" }, w.name))) : null; }

function paintProgress() {
  const box = $("#progressBox");
  if (!box) return;
  if (!S.progress) { box.hidden = true; return; }
  box.hidden = false;
  $("#progressLabel", box).textContent = S.progress.label + "...";
  $("#progressBar", box).style.width = Math.round(S.progress.p * 100) + "%";
}

// ---------- screens ----------
function discoverView() {
  const v = h("div", { class: "view" });
  if (!state.key) { v.append(onboarding()); return v; }

  v.append(h("div", { class: "glass progress", id: "progressBox", hidden: true }, h("div", { class: "lbl", id: "progressLabel" }, ""), h("div", { class: "bar" }, h("i", { id: "progressBar" }))));

  // chips
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Moods" },
    h("button", { class: "chip glass", type: "button", "aria-pressed": String(!state.mood), onclick: () => { state.mood = null; render(); } }, "All picks"),
    MOODS.map((m) => h("button", { class: "chip glass", type: "button", "aria-pressed": String(state.mood === m.id), onclick: () => loadMood(m) }, m.label)));

  // controls
  const typeSeg = h("div", { class: "seg glass", role: "group", "aria-label": "Format" },
    [["all", "Both"], ["movie", "Films"], ["tv", "Series"]].map(([val, lab]) => h("button", { type: "button", "aria-pressed": String(state.type === val), onclick: () => { state.type = val; persist(); render(); } }, lab)));
  const adv = h("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(state.adv), "aria-label": "Familiar to adventurous" });
  let raf = 0;
  adv.addEventListener("input", () => { state.adv = Number(adv.value); cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { persist(); rerankListsOnly(); }); });
  const controls = h("div", { class: "controls glass" }, typeSeg, h("label", { class: "adv" }, h("span", {}, "Familiar"), adv, h("span", {}, "Adventurous")));

  const rows = state.mood ? moodList() : S.rows;
  const list = rows.filter(passes);
  const slot = h("div", { id: "lists", class: "view" });
  v.append(chips, controls, slot);
  fillLists(slot, list);
  return v;
}

function fillLists(slot, list) {
  slot.replaceChildren();
  if (!list.length) {
    if (S.busy) slot.append(h("div", { class: "grid" }, Array.from({ length: 8 }, () => h("div", { class: "pimg sk" }))));
    else slot.append(h("p", { class: "empty" }, S.cands.length || state.mood ? "Nothing left with these filters. Loosen the rating or year in Taste." : "Pull to refresh with the button at the top to build your first list."));
    return;
  }
  const main = E.diversify(list, 24, lambda());
  const shown = new Set(main.slice(0, 12).map((r) => r.d.key));

  if (!state.mood) {
    const hero = main[0];
    slot.append(heroEl(hero));
    const heroKey = hero.d.key;
    const gems = list.filter((r) => !shown.has(r.d.key) && r.d.votes >= 80 && r.d.votes <= 2800 && r.d.rating >= 7.2).slice(0, 12);
    const fresh = list.filter((r) => !shown.has(r.d.key) && (r.src || []).includes("fresh") && r.d.year >= NOW_YEAR - 1).slice(0, 12);
    slot.append(h("section", {}, sectionHead("For you", "Ranked by fit, then diversified"), h("div", { class: "grid" }, main.filter((r) => r.d.key !== heroKey).map(pc))));
    if (gems.length) slot.append(h("section", {}, sectionHead("Hidden gems", "Loved by few, tuned to you"), h("div", { class: "rail" }, gems.map(pc))));
    if (fresh.length) slot.append(h("section", {}, sectionHead("Fresh in your lane", "Last 18 months"), h("div", { class: "rail" }, fresh.map(pc))));
  } else {
    const m = MOODS.find((x) => x.id === state.mood);
    slot.append(h("section", {}, sectionHead(m.label, "Ranked against your taste"), h("div", { class: "grid" }, main.map(pc))));
  }
}
function rerankListsOnly() {
  S.rows = E.rank(S.cands, { entries: entries(), adv: state.adv, exclude: excluded() });
  const slot = $("#lists");
  if (slot && state.view === "discover") fillLists(slot, (state.mood ? moodList() : S.rows).filter(passes));
}

function heroEl(r) {
  const d = r.d;
  const bg = d.backdrop ? h("img", { class: "hero-bg", src: IMG + "w780" + d.backdrop, alt: "", crossorigin: "anonymous", decoding: "async" }) : null;
  if (bg) bg.addEventListener("error", () => bg.remove());
  const where = h("div", { class: "where" });
  providers(d).then((p) => {
    if (!p) return;
    const names = p.flat.length ? p.flat : p.rent;
    if (names.length) { where.append(p.flat.length ? "Stream on " : "Rent on "); names.slice(0, 3).forEach((n) => where.append(h("span", { class: "tag" }, n))); }
  }).catch(() => {});
  return h("section", { class: "hero" }, bg,
    h("div", { class: "hero-info glass" },
      h("div", { class: "row", style: "justify-content:space-between;flex-wrap:nowrap" },
        h("div", { class: "eyebrow" }, "Tonight's pick"),
        h("div", { class: "ring", style: `--p:${r.match || 90}`, "aria-label": r.match + " percent match" }, h("span", {}, String(r.match || 90)))),
      h("h2", {}, d.title), metaLine(d), whyTags(r), becauseLine(r), where,
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", onclick: () => openSheet(r) }, "See why it fits"),
        h("button", { class: "btn glass", type: "button", onclick: () => toggleWatch(d) }, state.watch[d.key] ? "On watchlist" : "+ Watchlist"))));
}

function onboarding() {
  const input = h("input", { type: "password", placeholder: "Paste TMDB key or token", "aria-label": "TMDB key", autocomplete: "off", id: "keyInput" });
  const wrap = h("div", { class: "view" },
    h("section", { class: "card glass" },
      h("h3", {}, "One-time setup"),
      h("p", {}, "Afterglow pulls live data from TMDB, a free movie database. You need your own key, about two minutes:"),
      h("ol", { class: "steps" },
        h("li", {}, "Make a free account at ", h("a", { href: "https://www.themoviedb.org/signup", target: "_blank", rel: "noopener" }, "themoviedb.org")),
        h("li", {}, "Open Settings, then API, and request a developer key"),
        h("li", {}, "Paste the \"API Read Access Token\" or \"API Key\" below")),
      h("div", { class: "row" }, h("div", { class: "grow" }, input),
        h("button", { class: "btn primary", type: "button", onclick: () => { const v = input.value.trim(); if (!v) return; state.key = v; persist(); toast("Key saved."); render(); findPicks(); } }, "Save & find picks"))),
    h("section", {}, sectionHead("Starter picks", "Hand-picked from what you love"),
      h("div", { class: "rail" }, STARTERS.map(([title, year, type, why]) => h("div", { class: "pc" },
        h("div", { class: "pimg" }, h("div", { class: "ph" }, title)),
        h("div", { class: "pt" }, title), h("div", { class: "ps" }, `${year} · ${why}`))))));
  return wrap;
}

function libraryView() {
  const tabs = [["watch", "Watchlist"], ["love", "Loved"], ["seen", "Seen"], ["skip", "Skipped"]];
  const items = (k) => k === "watch" ? Object.values(state.watch) : Object.values(state.fb).filter((f) => f.s === k).sort((a, b) => b.t - a.t).map((f) => f.it);
  const cur = items(state.lib);
  const v = h("div", { class: "view" },
    h("div", { class: "chips", role: "group", "aria-label": "Library sections" }, tabs.map(([k, lab]) => h("button", { class: "chip glass", type: "button", "aria-pressed": String(state.lib === k), onclick: () => { state.lib = k; persist(); render(); } }, `${lab} ${items(k).length || ""}`.trim()))));
  if (!cur.length) {
    const msg = { watch: "Nothing saved yet. Tap + Watchlist on anything that looks good.", love: "Titles you mark Loved it teach the model what to find more of.", seen: "Titles you've watched live here and stop showing up in picks.", skip: "Titles marked Not for me. They also steer the model away from similar ones." }[state.lib];
    v.append(h("p", { class: "empty" }, msg)); return v;
  }
  v.append(h("div", { class: "list" }, cur.map((d) => h("button", { class: "lrow glass", type: "button", onclick: () => openSheet({ d, why: [], because: [] }) },
    h("div", { class: "thumb2" }, posterEl(d, "w185")), h("div", { style: "min-width:0" }, h("h3", {}, d.title), metaLine(d)),
    h("span", { class: "muted" }, "›")))));
  return v;
}

function tasteView() {
  const ent = entries();
  const fp = E.fingerprint(ent);
  const v = h("div", { class: "view" });

  // fingerprint
  const fpCard = h("section", { class: "card glass fp" }, h("h3", {}, "Your taste, decoded"));
  if (!fp.genres.length) fpCard.append(h("p", {}, "Press refresh on Discover once so Afterglow can read your titles."));
  else {
    fpCard.append(h("div", { class: "pairs" },
      h("div", {}, h("div", { class: "lbl", style: "margin-bottom:10px" }, "Genres"), h("div", { class: "bars" }, fp.genres.map((g) => h("div", {}, h("span", {}, g.name), h("i", { style: `width:${Math.max(8, Math.round(g.v * 100))}%` }))))),
      h("div", { style: "display:grid;gap:14px;align-content:start" },
        fp.keywords.length ? h("div", {}, h("div", { class: "lbl", style: "margin-bottom:10px" }, "Moods you keep returning to"), h("div", { class: "tags" }, fp.keywords.map((k) => h("span", { class: "tag" }, k.name)))) : null,
        fp.people.length ? h("div", {}, h("div", { class: "lbl", style: "margin-bottom:10px" }, "Directors & creators"), h("div", { class: "tags" }, fp.people.map((k) => h("span", { class: "tag" }, k.name)))) : null,
        fp.decades.length ? h("div", {}, h("div", { class: "lbl", style: "margin-bottom:10px" }, "Eras"), h("div", { class: "tags" }, fp.decades.map((k) => h("span", { class: "tag" }, k.name)))) : null)));
  }
  v.append(fpCard);

  // anchors
  const form = h("form", { class: "row", style: "flex-wrap:nowrap" }, h("div", { class: "grow" }, h("input", { type: "text", id: "seedInput", placeholder: "Add a title you love, e.g. Dark (2017)", "aria-label": "Add a title", autocomplete: "off" })), h("button", { class: "btn primary", type: "submit" }, "Add"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let t = $("#seedInput").value.trim(); if (!t) return;
    let year = null; const m = t.match(/\s*\((\d{4})\)\s*$/); if (m) { year = Number(m[1]); t = t.slice(0, m.index).trim(); }
    const seed = { title: t, year, w: 1.6 };
    if (state.key && navigator.onLine) { try { if (!(await resolveSeed(seed))) { toast("No match. Check the spelling or add the year."); return; } } catch { toast("Couldn't reach TMDB to check that title."); return; } }
    state.seeds.push(seed); persist(); toast("Added. Refresh Discover to update your picks."); render();
  });
  v.append(h("section", { class: "card glass" }, h("h3", {}, "Your anchors"), h("p", {}, "The titles that define your taste. Tap the star to make one count extra."),
    h("div", { class: "tags", style: "gap:8px" }, state.seeds.map((s, i) => h("span", { class: "anchor glass" }, s.title + (s.year ? ` (${s.year})` : ""),
      h("button", { class: "star", type: "button", "aria-pressed": String((s.w || 1) > 1), "aria-label": "Count " + s.title + " extra", onclick: () => { s.w = (s.w || 1) > 1 ? 1 : 1.6; persist(); rerank(); } }, (s.w || 1) > 1 ? "★" : "☆"),
      h("button", { type: "button", "aria-label": "Remove " + s.title, onclick: () => { state.seeds.splice(i, 1); persist(); rerank(); } }, "×")))), form));

  // dials
  const seg = (label, key, opts) => h("div", { class: "dial" }, h("label", {}, label), h("div", { class: "seg glass", role: "group", "aria-label": label }, opts.map(([val, lab]) => h("button", { type: "button", "aria-pressed": String(state[key] === val), onclick: () => { state[key] = val; persist(); rerank(); } }, lab))));
  const rng = (label, key, min, max, step, fmt) => { const out = h("output", {}, fmt(state[key])); const inp = h("input", { type: "range", min, max, step, value: String(state[key]), "aria-label": label }); inp.addEventListener("input", () => { state[key] = Number(inp.value); out.textContent = fmt(state[key]); persist(); }); inp.addEventListener("change", rerank); return h("div", { class: "dial" }, h("label", {}, label, out), inp); };
  v.append(h("section", { class: "card glass" }, h("h3", {}, "Dials"),
    h("div", { class: "pairs" },
      seg("Format", "type", [["all", "Both"], ["movie", "Films"], ["tv", "Series"]]),
      seg("Anime", "anime", [["include", "Mix in"], ["only", "Only"], ["none", "None"]]),
      rng("Minimum rating", "minRating", 5, 8.5, 0.5, (x) => Number(x).toFixed(1)),
      rng("Released after", "since", 1950, 2025, 5, String),
      rng("Familiar to adventurous", "adv", 0, 1, 0.05, (x) => (x < 0.25 ? "Familiar" : x > 0.7 ? "Adventurous" : "Balanced")))));

  // settings
  const region = h("select", { id: "region", "aria-label": "Streaming region" }, Object.entries(REGIONS).map(([c, n]) => h("option", { value: c, selected: c === state.region }, n)));
  region.addEventListener("change", () => { state.region = region.value; persist(); S.provCache.clear(); toast("Streaming region set to " + REGIONS[state.region] + "."); });
  const keyIn = h("input", { type: "password", value: state.key, "aria-label": "TMDB key", autocomplete: "off" });
  const settings = h("section", { class: "card glass" }, h("h3", {}, "Settings"),
    h("div", { class: "pairs" }, h("div", { class: "dial" }, h("label", {}, "Streaming in"), region),
      h("div", { class: "dial" }, h("label", {}, "TMDB key"), h("div", { class: "row", style: "flex-wrap:nowrap" }, h("div", { class: "grow" }, keyIn), h("button", { class: "btn glass sm", type: "button", onclick: () => { state.key = keyIn.value.trim(); persist(); toast(state.key ? "Key saved." : "Key removed."); if (state.key) findPicks(); else render(); } }, "Save")))),
    h("div", { class: "row" },
      h("button", { class: "btn glass sm", type: "button", onclick: () => { state.fb = {}; state.watch = {}; persist(); rerank(); toast("Learning reset. Your anchors are untouched."); } }, "Reset what I've taught it"),
      h("button", { class: "btn glass sm", type: "button", onclick: async () => { dc = {}; S.cands = []; S.moodRows = {}; LS.set("ag.dc", {}); LS.set("ag.cands", []); try { for (const k of await caches.keys()) await caches.delete(k); } catch {} rerank(); toast("Cache cleared."); } }, "Clear cache")),
    installHint());
  v.append(settings);
  v.append(h("p", { class: "foot" }, "This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability by JustWatch via TMDB. Your key, lists and learning stay in this browser."));
  return v;
}

function installHint() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone) return h("p", { class: "muted" }, "Installed. Nice.");
  if (S.deferred) return h("div", { class: "row" }, h("button", { class: "btn primary sm", type: "button", onclick: installApp }, "Install Afterglow"));
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return h("p", { class: "muted" }, "To install: tap Share, then Add to Home Screen.");
  return null;
}
async function installApp() {
  if (!S.deferred) return;
  S.deferred.prompt(); try { await S.deferred.userChoice; } catch {}
  S.deferred = null; $("#installBtn").hidden = true; render();
}

// ---------- providers / trailers ----------
async function providers(d) {
  const ck = d.key + "|" + state.region;
  if (S.provCache.has(ck)) return S.provCache.get(ck);
  const x = await tmdb(`/${d.type}/${d.id}/watch/providers`);
  const r = (x.results || {})[state.region];
  const v = r ? { link: r.link, flat: (r.flatrate || []).map((p) => p.provider_name), rent: (r.rent || r.buy || []).map((p) => p.provider_name) } : null;
  S.provCache.set(ck, v); return v;
}
async function trailer(d) {
  if (S.vidCache.has(d.key)) return S.vidCache.get(d.key);
  const x = await tmdb(`/${d.type}/${d.id}/videos`);
  const v = (x.results || []).filter((t) => t.site === "YouTube").sort((a, b) => (b.type === "Trailer") - (a.type === "Trailer") || (b.official === true) - (a.official === true))[0];
  const id = v ? v.key : null; S.vidCache.set(d.key, id); return id;
}

// ---------- feedback ----------
function setFb(d, s) {
  const k = d.key;
  if (state.fb[k] && state.fb[k].s === s) delete state.fb[k];
  else { state.fb[k] = { s, t: Date.now(), it: d }; delete state.watch[k]; }
  persist(); closeSheet(); rerank();
  toast(!state.fb[k] ? "Removed." : s === "love" ? "Noted. Finding more like it." : s === "skip" ? "Noted. Steering away from that." : "Marked as seen.");
}
function toggleWatch(d) {
  if (state.watch[d.key]) delete state.watch[d.key]; else { state.watch[d.key] = d; delete state.fb[d.key]; }
  persist(); rerank(); closeSheet();
  toast(state.watch[d.key] ? "Added to your watchlist." : "Removed from watchlist.");
}

// ---------- detail sheet ----------
function openSheet(r) {
  const d = r.d, sheet = $("#sheet"), panel = $("#sheetPanel");
  const fb = state.fb[d.key] && state.fb[d.key].s;
  const where = h("div", { class: "where" }, "Checking where to watch...");
  const trail = h("span", {});
  const meters = r.content != null ? h("div", { class: "meters" },
    [["Taste fit", Math.max(0, r.content)], ["Audience overlap", r.collab || 0], ["Quality", r.q || 0]].map(([l, v]) => h("div", {}, h("span", {}, l), h("i", {}, h("b", { style: `width:${Math.round(Math.min(1, v) * 100)}%` }))))) : null;
  panel.replaceChildren(
    h("div", { class: "s-back" }, d.backdrop ? h("img", { src: IMG + "w780" + d.backdrop, alt: "", crossorigin: "anonymous" }) : null,
      h("button", { class: "icon-btn glass s-x", type: "button", "aria-label": "Close", onclick: closeSheet }, svgIcon("M6 6l12 12M18 6 6 18"))),
    h("div", { class: "s-body" },
      h("div", { class: "s-top" }, r.match ? h("div", { class: "ring", style: `--p:${r.match}` }, h("span", {}, String(r.match))) : null, h("div", {}, h("div", { class: "eyebrow" }, r.match ? "Match with your taste" : "Details"), metaLine(d))),
      h("h2", {}, d.title),
      r.why && r.why.length ? h("div", {}, h("div", { class: "lbl", style: "margin-bottom:8px" }, "Why it fits"), whyTags(r)) : null,
      becauseLine(r), meters,
      d.overview ? h("p", { class: "overview" }, d.overview) : null,
      where, trail,
      h("div", { class: "acts" },
        h("button", { class: "btn glass" + (fb === "love" ? " on" : ""), type: "button", onclick: () => setFb(d, "love") }, fb === "love" ? "Loved" : "Loved it"),
        h("button", { class: "btn glass" + (state.watch[d.key] ? " on" : ""), type: "button", onclick: () => toggleWatch(d) }, state.watch[d.key] ? "Saved" : "+ Watchlist"),
        h("button", { class: "btn glass" + (fb === "seen" ? " on" : ""), type: "button", onclick: () => setFb(d, "seen") }, "Seen it"),
        h("button", { class: "btn glass" + (fb === "skip" ? " on" : ""), type: "button", onclick: () => setFb(d, "skip") }, "Not for me"))));
  sheet.hidden = false; document.body.classList.add("lock");
  requestAnimationFrame(() => { sheet.classList.add("open"); $(".s-x", panel).focus({ preventScroll: true }); });
  panel.scrollTop = 0;

  if (state.key && navigator.onLine) {
    providers(d).then((p) => {
      where.replaceChildren();
      if (!p) { where.append(`Not listed in ${REGIONS[state.region]}.`); return; }
      const names = p.flat.length ? p.flat : p.rent;
      if (!names.length) { where.append(`Not streaming in ${REGIONS[state.region]}.`); return; }
      where.append(p.flat.length ? "Stream on" : "Rent or buy on"); names.slice(0, 5).forEach((n) => where.append(h("span", { class: "tag" }, n)));
      if (p.link) where.append(h("a", { class: "link", href: p.link, target: "_blank", rel: "noopener" }, "all options"));
    }).catch(() => where.replaceChildren("Streaming info unavailable right now."));
    trailer(d).then((id) => { if (id) trail.replaceWith(h("a", { class: "btn glass sm", href: "https://www.youtube.com/watch?v=" + id, target: "_blank", rel: "noopener", style: "justify-self:start" }, "Watch trailer")); }).catch(() => {});
  } else where.replaceChildren("Connect to see where it streams.");
}
function closeSheet() {
  const sheet = $("#sheet");
  if (sheet.hidden) return;
  sheet.classList.remove("open"); document.body.classList.remove("lock");
  setTimeout(() => { if (!sheet.classList.contains("open")) sheet.hidden = true; }, 380);
}

// ---------- shell ----------
function render() {
  const app = $("#app");
  const view = state.view === "library" ? libraryView() : state.view === "taste" ? tasteView() : discoverView();
  const y = window.scrollY;
  app.replaceChildren(view);
  paintProgress();
  window.scrollTo(0, y);
  const idx = ["discover", "library", "taste"].indexOf(state.view);
  $("#tabbar").style.setProperty("--i", idx);
  document.querySelectorAll("#tabbar button").forEach((b) => b.toggleAttribute("aria-current", b.dataset.view === state.view));
  document.querySelectorAll("#tabbar button[aria-current]").forEach((b) => b.setAttribute("aria-current", "page"));
}
function go(view) { state.view = view; window.scrollTo({ top: 0 }); render(); }

function updateAmbient() {
  const box = $("#ambPosters");
  const rows = (state.mood ? moodList() : S.rows).slice(0, 4).filter((r) => r.d.poster);
  const urls = rows.map((r) => IMG + "w185" + r.d.poster);
  if (box.dataset.sig === urls.join()) return;
  box.dataset.sig = urls.join();
  box.replaceChildren(...urls.map((u) => { const i = h("img", { src: u, alt: "", crossorigin: "anonymous" }); i.addEventListener("load", () => i.classList.add("on")); return i; }));
}

let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3600); }

// ---------- events ----------
document.querySelectorAll("#tabbar button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
$("#refreshBtn").addEventListener("click", findPicks);
$("#scrim").addEventListener("click", closeSheet);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest && e.target.closest(".glass, .pc .pimg");
  if (!t) return;
  const r = t.getBoundingClientRect();
  t.style.setProperty("--mx", e.clientX - r.left + "px"); t.style.setProperty("--my", e.clientY - r.top + "px");
}, { passive: true });
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.deferred = e; $("#installBtn").hidden = false; });
$("#installBtn").addEventListener("click", installApp);
window.addEventListener("appinstalled", () => { S.deferred = null; $("#installBtn").hidden = true; toast("Installed."); });
const netBadge = () => { $("#offline").hidden = navigator.onLine; };
window.addEventListener("online", () => { netBadge(); toast("Back online."); });
window.addEventListener("offline", () => { netBadge(); toast("Offline. Showing what's saved."); });

if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ---------- boot ----------
netBadge();
S.rows = S.cands.length ? E.rank(S.cands, { entries: entries(), adv: state.adv, exclude: excluded() }) : [];
render(); updateAmbient();
const stale = !S.cands.length || Date.now() - (LS.get("ag.t", 0)) > 24 * 36e5;
if (state.key && stale && navigator.onLine) findPicks().then(() => LS.set("ag.t", Date.now()));
else if (!state.key) { /* onboarding is showing */ }
window.__afterglow = { state, S, E, findPicks, rerank };
})();
