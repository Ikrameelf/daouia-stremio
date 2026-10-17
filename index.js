const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

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

builder.defineStreamHandler(async ({ type, id }) => {
  const [imdb, s, e] = id.split(':');
  const tmdbId = await toTmdb(imdb, type);
  if (!tmdbId) return { streams: [] };
  const mediaType = type === 'movie' ? 'movie' : 'tv';

  const results = await Promise.allSettled(
    providers.map(p => timeout(Promise.resolve(p.fn(tmdbId, mediaType, s ? +s : undefined, e ? +e : undefined)), 20000))
  );

  const streams = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      console.error(`[${providers[i].id}]`, r.reason && r.reason.message);
      return;
    }
    for (const st of Array.isArray(r.value) ? r.value : []) {
      if (!st || !st.url) continue;
      streams.push({
        name: `${providers[i].id}${st.name ? ' · ' + st.name : ''}`,
        title: st.title || st.quality || '',
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

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
