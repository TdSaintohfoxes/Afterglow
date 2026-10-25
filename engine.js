/* Afterglow taste engine. Pure functions, no DOM, no network.
 *
 * Model, in plain terms:
 *  1. Every title becomes a feature set: genres, TMDB keywords (the "mood" tags),
 *     directors/creators, top cast, original language, decade.
 *  2. Your taste is a signed, weighted sum of those features across the titles you
 *     love (+), merely watched (+small), saved (+small) or rejected (-).
 *  3. A candidate scores on four signals:
 *       content   weighted cosine to your taste centroid, blended with its closest single favorite
 *       collab    how many of your favorites TMDB's audience data points at it
 *       quality   Bayesian-smoothed rating (a 9.1 from 12 votes does not beat an 8.2 from 40k)
 *       novelty   distance from your usual genres plus obscurity, scaled by the "adventurous" dial
 *  4. The top of the list is re-ordered with MMR so you don't get ten clones of one title.
 */
(function (root) {
  "use strict";

  const GROUPS = ["g", "k", "d", "c", "l", "e"];
  const W = { g: 0.18, k: 0.42, d: 0.2, c: 0.07, l: 0.06, e: 0.07 };
  const PRIORITY = { k: 1.0, d: 1.35, g: 0.55, c: 0.45, l: 0.2, e: 0.15 };

  const GENRE_NAMES = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
    18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
    9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 53: "Thriller", 10752: "War", 37: "Western",
    10759: "Action & Adventure", 10765: "Sci-Fi & Fantasy", 10768: "War & Politics"
  };
  // TV and film use different ids for the same idea. Fold them so features line up.
  const GENRE_FOLD = { 10759: 28, 10765: 878, 10768: 10752 };
  const foldGenre = (id) => GENRE_FOLD[id] || id;

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function feats(d) {
    const f = { g: {}, k: {}, d: {}, c: {}, l: {}, e: {} };
    (d.genres || []).forEach((id) => { f.g[foldGenre(id)] = 1; });
    (d.kw || []).forEach((k) => { f.k[k[0]] = 1; });
    (d.dir || []).forEach((p) => { f.d[p[0]] = 1; });
    (d.cast || []).slice(0, 5).forEach((p) => { f.c[p[0]] = 1; });
    if (d.lang) f.l[d.lang] = 1;
    const y = Number(d.year);
    if (y) f.e[Math.floor(y / 10) * 10] = 1;
    return f;
  }

  function makeIdf(allDetails) {
    const df = { g: {}, k: {}, d: {}, c: {}, l: {}, e: {} };
    let n = 0;
    for (const d of allDetails) {
      n++;
      const f = feats(d);
      for (const g of GROUPS) for (const id in f[g]) df[g][id] = (df[g][id] || 0) + 1;
    }
    return (g, id) => Math.log((n + 1) / ((df[g][id] || 0) + 1)) + 1;
  }

  function addFeats(target, d, w) {
    const f = feats(d);
    for (const g of GROUPS) for (const id in f[g]) target[g][id] = (target[g][id] || 0) + w;
  }

  function buildTaste(entries) {
    const t = { g: {}, k: {}, d: {}, c: {}, l: {}, e: {} };
    for (const e of entries) addFeats(t, e.d, e.w);
    return t;
  }

  // weighted cosine between a signed taste vector `t` and one title's features `f`
  function sim(t, f, idf) {
    let s = 0;
    for (const g of GROUPS) {
      const tv = t[g], cv = f[g];
      let dot = 0, nt = 0, nc = 0;
      for (const id in tv) { const w = tv[id] * idf(g, id); nt += w * w; }
      for (const id in cv) {
        const wi = idf(g, id);
        nc += wi * wi;
        if (tv[id]) dot += tv[id] * wi * wi;
      }
      if (nt > 0 && nc > 0) s += W[g] * dot / Math.sqrt(nt * nc);
    }
    return s;
  }

  const bayes = (rating, votes, m = 400, C = 6.7) => (votes * rating + m * C) / (votes + m);
  const qualityScore = (d) => clamp((bayes(d.rating || 0, d.votes || 0) - 5.5) / 3.5, 0, 1);
  const obscurity = (d) => clamp(1 - Math.log10((d.votes || 0) + 1) / 4.5, 0, 1);

  function nameFor(d, g, id) {
    if (g === "g") return GENRE_NAMES[id] || null;
    if (g === "l") return null;
    const list = g === "k" ? d.kw : g === "d" ? d.dir : d.cast;
    const hit = (list || []).find((x) => String(x[0]) === String(id));
    return hit ? hit[1] : null;
  }

  function explain(d, taste, idf) {
    const f = feats(d);
    const found = [];
    for (const g of ["k", "d", "g", "c"]) {
      for (const id in f[g]) {
        const tw = taste[g][id];
        if (!tw || tw <= 0) continue;
        const nm = nameFor(d, g, id);
        if (!nm) continue;
        found.push({ name: nm, kind: g, v: tw * idf(g, id) * PRIORITY[g] });
      }
    }
    found.sort((a, b) => b.v - a.v);
    const out = [], seen = new Set();
    for (const x of found) {
      if (seen.has(x.name)) continue;
      seen.add(x.name); out.push({ name: x.name, kind: x.kind });
      if (out.length === 4) break;
    }
    return out;
  }

  /**
   * @param cands  [{ d, collab, src }]  d = slim details; collab = raw collaborative score
   * @param ctx    { entries:[{d,w,title}], adv:0..1, exclude:Set<string> }
   */
  function rank(cands, ctx) {
    const entries = ctx.entries || [];
    const adv = clamp(ctx.adv == null ? 0.35 : ctx.adv, 0, 1);
    const all = cands.map((c) => c.d).concat(entries.map((e) => e.d));
    const idf = makeIdf(all);
    const taste = buildTaste(entries);
    const pos = entries.filter((e) => e.w > 0).map((e) => ({ e, f: feats(e.d) }));
    const neg = entries.filter((e) => e.w < 0).map((e) => ({ e, f: feats(e.d) }));
    const tasteGenres = { g: taste.g, k: {}, d: {}, c: {}, l: {}, e: {} };

    const rows = [];
    for (const c of cands) {
      if (ctx.exclude && ctx.exclude.has(c.d.key)) continue;
      const f = feats(c.d);
      const centroid = sim(taste, f, idf);

      // nearest single favorites (item-to-item): catches "this is basically Se7en"
      const near = pos.map(({ e, f: sf }) => ({ e, s: sim(unit(sf), f, idf) * Math.min(e.w, 1.6) }))
        .sort((a, b) => b.s - a.s);
      const top2 = near.slice(0, 2);
      const nearest = top2.length ? top2.reduce((a, b) => a + b.s, 0) / top2.length : 0;
      let content = 0.5 * centroid + 0.5 * nearest;

      let penalty = 0;
      for (const { e, f: sf } of neg) penalty = Math.max(penalty, sim(unit(sf), f, idf) * Math.min(Math.abs(e.w), 1.2));
      content -= 0.8 * penalty;

      const gSim = sim(tasteGenres, f, idf) / W.g;
      const novelty = clamp(0.6 * (1 - clamp(gSim, 0, 1)) + 0.4 * obscurity(c.d), 0, 1);

      rows.push({
        d: c.d, src: c.src || [], contentRaw: content, collabRaw: c.collab || 0,
        q: qualityScore(c.d), novelty, because: near.filter((x) => x.s > 0.07).slice(0, 2).map((x) => x.e.title)
      });
    }
    if (!rows.length) return [];

    const maxC = Math.max(...rows.map((r) => r.contentRaw), 1e-6);
    const maxL = Math.max(...rows.map((r) => r.collabRaw), 1e-6);
    const wC = 0.5 - 0.1 * adv, wL = 0.3 - 0.15 * adv, wQ = 0.12 + 0.08 * adv, wN = 0.08 + 0.17 * adv;
    for (const r of rows) {
      r.content = clamp(r.contentRaw / maxC, -1, 1);
      r.collab = r.collabRaw / maxL;
      r.F = wC * r.content + wL * r.collab + wQ * r.q + wN * r.novelty;
      r.why = explain(r.d, taste, idf);
    }
    rows.sort((a, b) => b.F - a.F);
    const hi = rows[0].F, lo = rows[Math.min(rows.length - 1, 40)].F;
    for (const r of rows) r.match = Math.round(70 + 29 * clamp((r.F - lo) / Math.max(hi - lo, 1e-6), 0, 1));
    return rows;
  }

  function unit(f) { return f; } // a single title's features already act as a 0/1 taste vector

  // Maximal Marginal Relevance: relevance minus similarity to what is already picked.
  function diversify(rows, n, lambda) {
    const sigs = new Map(rows.map((r) => [r, signature(r.d)]));
    const hi = rows.length ? rows[0].F : 1;
    const lo = rows.length ? rows[rows.length - 1].F : 0;
    const rel = (r) => (r.F - lo) / Math.max(hi - lo, 1e-6);
    const left = rows.slice(), out = [];
    while (out.length < n && left.length) {
      let best = null, bestV = -Infinity;
      for (const r of left) {
        let maxSim = 0;
        for (const p of out) maxSim = Math.max(maxSim, jaccard(sigs.get(r), sigs.get(p)));
        const v = lambda * rel(r) - (1 - lambda) * maxSim;
        if (v > bestV) { bestV = v; best = r; }
      }
      out.push(best);
      left.splice(left.indexOf(best), 1);
    }
    return out;
  }
  function signature(d) {
    const s = new Set();
    (d.genres || []).forEach((g) => s.add("g" + foldGenre(g)));
    (d.kw || []).slice(0, 12).forEach((k) => s.add("k" + k[0]));
    (d.dir || []).forEach((p) => s.add("d" + p[0]));
    return s;
  }
  function jaccard(a, b) {
    let i = 0;
    for (const x of a) if (b.has(x)) i++;
    const u = a.size + b.size - i;
    return u ? i / u : 0;
  }

  // Cheap pre-score used to decide whose full details are worth fetching.
  function preScore(c, tasteGenres) {
    const g = new Set((c.d.genres || []).map(foldGenre));
    let overlap = 0, tot = 0;
    for (const id in tasteGenres) { const w = Math.max(tasteGenres[id], 0); tot += w; if (g.has(Number(id))) overlap += w; }
    const go = tot ? overlap / tot : 0;
    const bonus = (c.src || []).some((s) => s === "kw" || s === "dir") ? 0.25 : 0;
    return 0.55 * (c.collab || 0) + 0.25 * go + 0.2 * qualityScore(c.d) + bonus;
  }

  // Human-readable fingerprint for the Taste screen.
  function fingerprint(entries) {
    const pos = entries.filter((e) => e.w > 0);
    if (!pos.length) return { genres: [], keywords: [], people: [], decades: [] };
    const idf = makeIdf(pos.map((e) => e.d));
    const bucket = { g: {}, k: {}, d: {}, e: {} };
    const names = { k: {}, d: {} };
    for (const e of pos) {
      const f = feats(e.d);
      for (const g of ["g", "k", "d", "e"]) for (const id in f[g]) bucket[g][id] = (bucket[g][id] || 0) + e.w;
      (e.d.kw || []).forEach((k) => (names.k[k[0]] = k[1]));
      (e.d.dir || []).forEach((p) => (names.d[p[0]] = p[1]));
    }
    const top = (g, n, scaleIdf) => Object.entries(bucket[g])
      .map(([id, v]) => ({ id, v: v * (scaleIdf ? idf(g, id) : 1) }))
      .sort((a, b) => b.v - a.v).slice(0, n);
    const gmax = Math.max(...Object.values(bucket.g), 1);
    return {
      genres: top("g", 6).map((x) => ({ name: GENRE_NAMES[x.id] || x.id, v: bucket.g[x.id] / gmax })).filter((x) => x.name),
      keywords: top("k", 14, true).filter((x) => bucket.k[x.id] > 1).map((x) => ({ name: names.k[x.id], v: x.v })).filter((x) => x.name).slice(0, 10),
      people: top("d", 5, false).filter((x) => bucket.d[x.id] > 1).map((x) => ({ name: names.d[x.id], v: x.v })).filter((x) => x.name),
      decades: top("e", 4).map((x) => ({ name: x.id + "s", v: x.v }))
    };
  }

  // Which keywords / people are worth querying TMDB's discover endpoint with.
  function discoverSeeds(entries) {
    const pos = entries.filter((e) => e.w > 0);
    const idf = makeIdf(pos.map((e) => e.d));
    const k = {}, d = {};
    for (const e of pos) {
      (e.d.kw || []).forEach(([id]) => { k[id] = (k[id] || 0) + e.w; });
      (e.d.dir || []).forEach(([id]) => { d[id] = (d[id] || 0) + e.w; });
    }
    const topK = Object.entries(k).filter(([, v]) => v >= 2)
      .map(([id, v]) => ({ id: Number(id), v: v * idf("k", id) })).sort((a, b) => b.v - a.v).slice(0, 6).map((x) => x.id);
    const topD = Object.entries(d).map(([id, v]) => ({ id: Number(id), v })).sort((a, b) => b.v - a.v).slice(0, 4).map((x) => x.id);
    return { keywords: topK, people: topD };
  }

  const api = { feats, rank, diversify, preScore, fingerprint, discoverSeeds, qualityScore, foldGenre, GENRE_NAMES, buildTaste };
  root.AfterglowEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
