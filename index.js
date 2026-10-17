const fs = require('fs');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

global.SCRAPER_SETTINGS = global.SCRAPER_SETTINGS || {};

// Providers actifs (noms des fichiers dans le repo de Gowaru)
const ENABLED = ['webflix', 'flemmix', 'frenchstream', 'voiranime'];

const BASE = 'https://raw.githubusercontent.com/Gowaru/gowaru-nuvio-providers/refs/heads/main/providers/';

const providers = [];

async function loadProviders() {
  fs.mkdirSync('./providers', { recursive: true });
  for (const id of ENABLED) {
    const path = `./providers/${id}.js`;
    try {
      try {
        const r = await fetch(`${BASE}${id}.js`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        fs.writeFileSync(path, await r.text());
      } catch (err) {
        // Si le téléchargement échoue, on utilise la copie locale si elle existe
        if (!fs.existsSync(path)) throw err;
        console.error(`[${id}] téléchargement échoué (${err.message}), copie locale utilisée`);
      }

      delete global.getStreams;
      const m = require(path);
      const fn = m.getStreams || (m.default && m.default.getStreams) || global.getStreams;
      if (typeof fn === 'function') providers.push({ id, fn });
      else console.error(`[${id}] getStreams introuvable`);
    } catch (err) {
      console.error(`[${id}] échec:`, err.message);
    }
  }
}

const builder = new addonBuilder({
  id: 'community.fr-providers',
  version: '1.1.0',
  name: 'FR Providers',
  description: 'Webflix, Flemmix, FrenchStream, VoirAnime',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
});

// IMDb -> TMDB
async function toTmdb(imdb, type) {
  const url = `https://api.themoviedb.org/3/find/${imdb}?external_source=imdb_id&api_key=${process.env.TMDB_KEY}`;
  const j = await (await fetch(url)).json();
  return (type === 'movie' ? j.movie_results : j.tv_results)?.[0]?.id;
}

// Cache : un provider lent continue en arrière-plan, son résultat est gardé
const cache = new Map();
const TTL = 30 * 60 * 1000;

function runProvider(p, key, args) {
  const k = p.id + '|' + key;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.t < TTL) return hit.promise;

  const promise = Promise.resolve()
    .then(() => p.fn(...args))
    .then(v => (Array.isArray(v) ? v : []))
    .catch(e => {
      console.error(`[${p.id}]`, e && e.message);
      return [];
    });

  cache.set(k, { t: Date.now(), promise });
  // Un résultat vide n'est pas gardé en cache
  promise.then(v => { if (!v.length) cache.delete(k); });
  return promise;
}

const soft = (promise, ms) =>
  Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);

// Pour chaque provider : un tableau (terminé) ou null (encore en cours)
function runProviders(tmdbId, mediaType, season, episode, ms = 22000) {
  const key = `${mediaType}:${tmdbId}:${season}:${episode}`;
  return Promise.all(
    providers.map(p =>
      soft(runProvider(p, key, [String(tmdbId), mediaType, season, episode]), ms)
    )
  );
}

builder.defineStreamHandler(async ({ type, id }) => {
  const [imdb, s, e] = id.split(':');
  const tmdbId = await toTmdb(imdb, type);
  if (!tmdbId) return { streams: [] };
  const mediaType = type === 'movie' ? 'movie' : 'tv';

  const results = await runProviders(tmdbId, mediaType, s ? +s : null, e ? +e : null);

  const streams = [];
  let pending = false;

  results.forEach((list, i) => {
    if (list === null) { pending = true; return; }
    for (const st of list) {
      if (!st || !st.url) continue;
      streams.push({
        name: providers[i].id,
        title: [st.name, st.title || st.quality].filter(Boolean).join('\n'),
        url: st.url,
        behaviorHints: {
          notWebReady: true,
          ...(st.headers ? { proxyHeaders: { request: st.headers } } : {})
        }
      });
    }
  });

  // Si un provider est encore en cours, Stremio redemandera vite
  return { streams, cacheMaxAge: pending ? 30 : 1800 };
});

const app = express();

// Debug depuis le navigateur :
//   /debug/movie/550          -> film (TMDB 550)
//   /debug/tv/1399/1/1        -> série TMDB 1399, S1E1
app.get('/debug/:mediaType/:tmdbId/:season?/:episode?', async (req, res) => {
  const { mediaType, tmdbId, season, episode } = req.params;
  const results = await runProviders(
    tmdbId, mediaType, season ? +season : null, episode ? +episode : null, 90000
  );
  res.json(results.map((list, i) => ({
    provider: providers[i].id,
    status: list === null ? 'pending' : 'done',
    count: list ? list.length : 0,
    sample: list ? list.slice(0, 2) : undefined
  })));
});

app.get('/', (_, res) => res.redirect('/manifest.json'));
app.use(getRouter(builder.getInterface()));

loadProviders().then(() => {
  console.log('providers chargés:', providers.map(p => p.id).join(', '));
  app.listen(process.env.PORT || 7000, () => console.log('addon prêt'));
});
