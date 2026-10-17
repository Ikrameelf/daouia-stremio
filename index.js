const fs = require('fs');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

global.SCRAPER_SETTINGS = global.SCRAPER_SETTINGS || {};

// --- Relais optionnel pour les sites qui bloquent l'IP de Render ---
const PROXY_URL = (process.env.PROXY_URL || '').replace(/\/+$/, '');
const PROXY_KEY = process.env.PROXY_KEY || '';
const PROXIED_HOSTS = (process.env.PROXIED_HOSTS || 'french-stream.net,french-stream.one,flemmix.me')
  .split(',').map(s => s.trim()).filter(Boolean);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const realFetch = global.fetch.bind(global);

function hostMatches(url, list) {
  try {
    const h = new URL(url).hostname;
    return list.some(d => h === d || h.endsWith('.' + d));
  } catch { return false; }
}
const viaProxy = url => !!PROXY_URL && hostMatches(url, PROXIED_HOSTS);

global.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  if (!viaProxy(url)) return realFetch(input, init);
  return realFetch(
    `${PROXY_URL}/?key=${encodeURIComponent(PROXY_KEY)}&url=${encodeURIComponent(url)}`,
    init
  );
};

// --- Providers ---
const ENABLED = ['webflix', 'flemmix', 'frenchstream', 'voiranime'];
const BASE = 'https://raw.githubusercontent.com/Gowaru/gowaru-nuvio-providers/refs/heads/main/providers/';
const providers = [];

async function loadProviders() {
  fs.mkdirSync('./providers', { recursive: true });
  for (const id of ENABLED) {
    const path = `./providers/${id}.js`;
    try {
      try {
        const r = await realFetch(`${BASE}${id}.js`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        fs.writeFileSync(path, await r.text());
      } catch (err) {
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
  version: '1.3.0',
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
  const j = await (await realFetch(url)).json();
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
  promise.then(v => { if (!v.length) cache.delete(k); });
  return promise;
}

// Rend la main dès qu'un provider a des flux (+ délai de grâce), ou au bout de "max" ms.
function runProviders(tmdbId, mediaType, season, episode, opts = {}) {
  const max = opts.max || 20000;
  const grace = opts.grace || 2500;
  const key = `${mediaType}:${tmdbId}:${season}:${episode}`;
  const results = new Array(providers.length).fill(null);

  return new Promise(resolve => {
    let finished = false;
    let graceTimer = null;
    let remaining = providers.length;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      clearTimeout(graceTimer);
      resolve(results);
    };
    const hardTimer = setTimeout(finish, max);

    if (!providers.length) return finish();

    providers.forEach((p, i) => {
      runProvider(p, key, [String(tmdbId), mediaType, season, episode]).then(list => {
        results[i] = list;
        remaining--;
        if (list.length && !graceTimer) graceTimer = setTimeout(finish, grace);
        if (remaining === 0) finish();
      });
    });
  });
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

  return { streams, cacheMaxAge: pending ? 30 : 1800 };
});

const app = express();

// Debug des providers :
//   /debug/movie/550          -> film (TMDB 550)
//   /debug/tv/1399/1/1        -> série TMDB 1399, S1E1
app.get('/debug/:mediaType/:tmdbId/:season?/:episode?', async (req, res) => {
  const { mediaType, tmdbId, season, episode } = req.params;
  const results = await runProviders(
    tmdbId, mediaType, season ? +season : null, episode ? +episode : null,
    { max: 90000, grace: 90000 }
  );
  res.json(results.map((list, i) => ({
    provider: providers[i].id,
    status: list === null ? 'pending' : 'done',
    count: list ? list.length : 0,
    sample: list ? list.slice(0, 2) : undefined
  })));
});

// Ce que reçoit le serveur depuis un site (domaines autorisés seulement) :
//   /probe?url=https://french-stream.net/            -> via le relais s'il est configuré
//   /probe?url=https://french-stream.net/&direct=1   -> directement depuis Render
app.get('/probe', async (req, res) => {
  const url = String(req.query.url || '');
  if (!hostMatches(url, [...PROXIED_HOSTS, 'webflix.art'])) {
    return res.status(403).send('domaine non autorisé');
  }
  try {
    const direct = !!req.query.direct;
    const f = direct ? realFetch : global.fetch;
    const r = await f(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json' } });
    const body = await r.text();
    res.json({
      status: r.status,
      via: direct ? 'direct' : (viaProxy(url) ? 'relais' : 'direct'),
      contentType: r.headers.get('content-type'),
      protection: /just a moment|cf-chl|attention required|ddos-guard/i.test(body),
      debut: body.slice(0, 300)
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/', (_, res) => res.redirect('/manifest.json'));
app.use(getRouter(builder.getInterface()));

loadProviders().then(() => {
  console.log('providers chargés:', providers.map(p => p.id).join(', '));
  app.listen(process.env.PORT || 7000, () => console.log('addon prêt'));
});
