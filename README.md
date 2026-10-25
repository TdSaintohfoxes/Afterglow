# Afterglow

Film and series picks tuned to your taste. Installable PWA, liquid-glass UI, works offline with your last picks.

## Deploy (GitHub Pages, free, HTTPS)

A service worker only runs over HTTPS (or localhost), so the app needs a host.

1. Create a repo, e.g. `afterglow`, and put these files at the repo root (not inside a subfolder).
2. Repo Settings > Pages > Build and deployment > Deploy from a branch > `main` / root.
3. Open `https://<you>.github.io/afterglow/` on your phone.
4. Install it:
   - Android / Chrome: menu > Install app (or the download icon in the app header).
   - iPhone / Safari: Share > Add to Home Screen.

Netlify Drop (drag the folder onto app.netlify.com/drop) and Cloudflare Pages work the same way.

To try it on your computer first: `python3 -m http.server 8000` in this folder, then open http://localhost:8000.

## First run

Paste a free TMDB key when asked: themoviedb.org > Settings > API. The "API Read Access Token" or the "API Key" both work. It is stored only in your browser.

## How the picks are made

Every title becomes a feature set: genres, TMDB keywords (the mood tags), directors or creators, top cast, language, decade.

- **Taste fit**: cosine similarity to your taste, rare features weighted up, blended with the closest single favorite.
- **Audience overlap**: how many of your favorites TMDB's audience data points at the title.
- **Quality**: Bayesian-smoothed rating, so a 9.5 from 8 votes does not beat an 8.2 from 40k.
- **Novelty**: the Familiar/Adventurous dial trades safe fits for distance from your usual genres and lesser-known titles.
- **Learning**: Loved it adds a title to your taste, Seen adds a little, Not for me pushes similar titles down. Re-ranking is instant and works offline.
- **Diversity**: the final list is re-ordered so you don't get ten clones of one title.

Moods (Neon & rain, Steel & honor, and so on) search TMDB by mood keyword, then rank the results with the same model.

## Files

`index.html` `styles.css` `app.js` UI and TMDB calls. `engine.js` the ranking model, no DOM, no network. `sw.js` offline caching. `manifest.webmanifest` and `icons/` for install.

Data from TMDB. Streaming availability from JustWatch via TMDB.
