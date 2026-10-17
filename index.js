const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

global.SCRAPER_SETTINGS = global.SCRAPER_SETTINGS || {};

const ENABLED = ['webflix', 'flemmix', 'frenchstream', 'voiranime'];

const providers = [];
for (const id of ENABLED) {
  try {
    delete global.getStreams;
    const m = require(`./providers/${id}.js`);
    const fn = m.getStreams || (m.default && m.default.getStreams) || global.getStreams;
    if (typeof fn === 'function') providers.push({ id, fn });
    else console.error(`[${id}] getStreams introuvable`);
  } catch (err) {
    console.error(`[${id}] chargement impossible:`, err.message);
  }
}

const builder = new addonBuilder({
  id: 'community.fr-providers',
  version: '1.0.0',
  name: 'FR Providers',
  description: 'Webflix, Flemmix, FrenchStream, VoirAnime',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
});

async function toTmdb(imdb, type) {
  const url = `https://api.themoviedb.org/3/find/${imdb}?external_source=imdb_id&api_key=${process.env.TMDB_KEY}`;
  const j = await (await fetch(url)).json();
  return (type === 'movie' ? j.movie_results : j.tv_results)?.[0]?.id;
}

const timeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

function runProviders(tmdbId, mediaType, season, episode) {
  return Promise.allSettled(
    providers.map(p => timeout(Promise.resolve(p.fn(String(tmdbId), mediaType, season, episode)), 25000))
  );
}

builder.defineStreamHandler(async ({ type, id }) => {
  const [imdb, s, e] = id.split(':');
  const tmdbId = await toTmdb(imdb, type);
  if (!tmdbId) return { streams: [] };
  const mediaType = type === 'movie' ? 'movie' : 'tv';

  const results = await runProviders(tmdbId, mediaType, s ? +s : null, e ? +e : null);

  const streams = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      console.error(`[${providers[i].id}]`, r.reason && r.reason.message);
      return;
    }
    for (const st of Array.isArray(r.value) ? r.value : []) {
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
  return { streams };
});

const app = express();

// Debug depuis le navigateur :
//   /debug/movie/550            -> film (TMDB 550)
//   /debug/tv/1399/1/1          -> série TMDB 1399, S1E1
app.get('/debug/:mediaType/:tmdbId/:season?/:episode?', async (req, res) => {
  const { mediaType, tmdbId, season, episode } = req.params;
  const results = await runProviders(tmdbId, mediaType, season ? +season : null, episode ? +episode : null);
  res.json(results.map((r, i) => ({
    provider: providers[i].id,
    status: r.status,
    count: r.status === 'fulfilled' && Array.isArray(r.value) ? r.value.length : 0,
    error: r.status === 'rejected' ? String(r.reason && r.reason.message) : undefined,
    sample: r.status === 'fulfilled' && Array.isArray(r.value) ? r.value.slice(0, 2) : undefined
  })));
});

app.get('/', (_, res) => res.redirect('/manifest.json'));
app.use(getRouter(builder.getInterface()));
app.listen(process.env.PORT || 7000, () => console.log('addon prêt'));
