// MCP OMNI Server — PRO Edition (ONE server for everything)
// ✅ CommonJS; binds to process.env.PORT; ready for Railway
// ✅ Handles: Anthropic (Claude), HeyGen, Perplexity, Apify, Apollo, IDX
// ✅ Includes: life-event scoring (relocation/PCS), geo boost, detect-but-drop sensitive signals
// ✅ Endpoints for public records + mortgage events + optional GHL send
// 🚫 Never put API keys in code. Set them in Railway → Variables.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET','POST'],
  allowedHeaders: ['Content-Type','x-auth-token','Authorization']

}));

// ---- Security: shared header ----
app.use((req, res, next) => {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return next(); // dev mode
  const got = req.get('x-auth-token');
  if (got !== expected) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
});

// ---- Health ----
app.get('/', (_req, res) => res.json({ ok:true, service:'MCP OMNI PRO', time:new Date().toISOString() }));
app.get('/health', (_req, res) => res.status(200).send('OK'));

// ---- HTTP client helper (with retries) ----
function makeClient({ baseURL, headers = {} }) {
  const c = axios.create({ baseURL, headers, timeout: 25000 });
  axiosRetry(c, { retries: 3, retryDelay: axiosRetry.exponentialDelay, retryCondition: e => !e.response || e.response.status >= 500 });
  return c;
}

// ---- Providers registry (Bearer vs X-API-Key handled here) ----
const PROVIDERS = {
  anthropic: {
    baseURL: 'https://api.anthropic.com',
    env: 'ANTHROPIC_API_KEY',
    headers: k => ({ 'x-api-key': k, 'anthropic-version':'2023-06-01','content-type':'application/json' })
  },
  heygen: {
    baseURL: 'https://api.heygen.com',
    env: 'HEYGEN_API_KEY',
    headers: k => ({ 'X-API-Key': k, 'content-type':'application/json' })
  },
  perplexity: {
    baseURL: 'https://api.perplexity.ai',
    env: 'PERPLEXITY_API_KEY',
    headers: k => ({ Authorization: `Bearer ${k}`, 'content-type':'application/json' })
  },
  apify: {
    baseURL: 'https://api.apify.com',
    env: 'APIFY_TOKEN',
    headers: k => ({ Authorization: `Bearer ${k}` })
  },
  apollo: {
    baseURL: 'https://api.apollo.io',
    env: 'APOLLO_API_KEY',
    headers: k => ({ 'X-Api-Key': k, 'content-type':'application/json' })
  },
  idx: {
    baseURL: 'https://api.idxbroker.com',
    env: 'IDX_ACCESS_KEY',
    headers: k => ({ accesskey: k, outputtype: 'json' })
  }
};

function client(name) {
  const p = PROVIDERS[name];
  if (!p) return null;
  const key = process.env[p.env];
  if (!key) return null;
  return makeClient({ baseURL: p.baseURL, headers: p.headers(key) });
}
// ---- Route debug (optional) ----
app.get('/routes', (_req, res) => {
  try {
    const list = (app._router.stack || [])
      .filter(r => r.route)
      .map(r => ({ method: Object.keys(r.route.methods)[0].toUpperCase(), path: r.route.path }));
    res.json({ ok: true, routes: list });
  } catch (e) {
    res.json({ ok: false, error: String(e?.message || e) });
  }
});
// ---- Scrape a list of URLs (blocking) ----
app.post('/api/scrape', async (req, res) => {
  try {
    const apify = client('apify'); // uses APIFY_TOKEN if set
    const { urls = [] } = req.body || {};
    const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
    if (!list.length) return res.status(400).json({ ok: false, error: 'urls[] required' });

    // "Hard" hosts (IG/FB) – we’ll pass through with placeholders so your flow keeps geo/url context
    const hardHosts = ['instagram.com', 'm.facebook.com', 'facebook.com'];
    const isHard = u => hardHosts.some(h => (u || '').includes(h));
    const hard = list.filter(isHard);
    const easy = list.filter(u => !isHard(u));

    // If Apify is available, use Web Scraper actor and return dataset items
    if (apify && easy.length) {
      const input = {
        startUrls: easy.map(u => ({ url: u })),
        maxRequestsPerCrawl: easy.length,
        proxyConfiguration: { useApifyProxy: true },
        pageFunction:
`async function pageFunction(context) {
  const { request } = context;
  const title = document.title || '';
  let text = '';
  try { text = document.body ? document.body.innerText : ''; } catch(e){}
  return { url: request.url, title, content: (text || '').slice(0, 20000) };
}`
      };

      // Start run
      const start = await apify.post('/v2/acts/apify~web-scraper/runs', input);
      const runId = start.data?.data?.id;
      if (!runId) throw new Error('No Apify run id from /runs');

      // Poll for completion
      const wait = ms => new Promise(r => setTimeout(r, ms));
      let status = 'RUNNING', datasetId = null, tries = 0;
      while (tries < 25) {
        const st = await apify.get(`/v2/actor-runs/${runId}`);
        status    = st.data?.data?.status;
        datasetId = st.data?.data?.defaultDatasetId;
        if (status === 'SUCCEEDED' && datasetId) break;
        if (['FAILED','ABORTED','TIMED_OUT'].includes(status)) {
          throw new Error(`Apify run ${status}`);
        }
        await wait(1500); tries++;
      }

      let items = [];
      if (status === 'SUCCEEDED' && datasetId) {
        const resp = await apify.get(`/v2/datasets/${datasetId}/items?clean=true&format=json`);
        const raw = Array.isArray(resp.data) ? resp.data : [];
        const seen = new Set();
        items = raw
          .map(r => ({ url: r.url, title: r.title || '', content: r.content || '' }))
          .filter(it => it.url && !seen.has(it.url) && seen.add(it.url));
      }

      // Add placeholders for hard sites so flow continues
      for (const u of hard) items.push({ url: u, title: '', content: '' });

      return res.json({
        ok: true,
        items,
        provider: 'apify|fallback',
        note: hard.length ? 'Some hosts returned placeholders (IG/FB).' : undefined
      });
    }

    // ---- Fallback (no APIFY_TOKEN): simple HTTP GET for each easy URL
    const out = [];
    for (const u of list) {
      try {
        if (isHard(u)) {
          out.push({ url: u, title: '', content: '' });
          continue;
        }
        const r = await axios.get(u, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = String(r.data || '');
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = titleMatch ? titleMatch[1] : '';
        // crude strip of tags
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi,'')
          .replace(/<style[\s\S]*?<\/style>/gi,'')
          .replace(/<[^>]+>/g,' ')
          .replace(/\s+/g,' ')
          .trim();
        out.push({ url: u, title, content: text.slice(0, 20000) });
      } catch (e) {
        console.error('[scrape] fallback error for', u, e?.response?.status || e.message);
        out.push({ url: u, title: '', content: '' });
      }
    }
    return res.json({ ok: true, items: out, provider: 'fallback' });
  } catch (e) {
    console.error('scrape fatal:', e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: 'scrape failed' });
  }
});


app.post('/api/discover', async (req, res) => {
  try {
    const perplex = client('perplexity');
    const apify   = client('apify');
    const { queries = [], location = {}, locations = [] } = req.body || {};

    // normalize inputs
    const qList = Array.isArray(queries) ? queries.filter(Boolean) : [String(queries)].filter(Boolean);
    const locs  = Array.isArray(locations) && locations.length ? locations : [location].filter(Boolean);

    const model = ((process.env.PPLX_MODEL || 'sonar') + '').trim().toLowerCase(); // 'sonar' | 'sonar-pro'
    const allowedDomains = [
  'reddit.com','facebook.com','m.facebook.com','instagram.com',
  'youtube.com','youtu.be','zillow.com','realtor.com','redfin.com',
  'trulia.com','homes.com','apartments.com','nextdoor.com','x.com',
  'twitter.com','linkedin.com'
];
    const isAllowed = (u) => { try { const h = new URL(u).hostname.replace(/^www\./,''); return allowedDomains.some(d => h.endsWith(d)); } catch { return false; } };

    const allItems = [];
    const seen = new Set();



    for (const loc of locs) {
      const userPrompt = qList.length ? qList.map(q => `• ${q}`).join('\n') : 'buyer intent signals for real estate';

      let items = [];

      // --- Try Perplexity for this location
      if (perplex) {
        try {
          const payload = {
            model,
            messages: [
              { role: 'system', content: 'You are a lead intelligence researcher for real estate buyer intent.' },
              { role: 'user', content:
`Find fresh public posts/pages that signal active home-buying in ${loc.city || ''}, ${loc.state || ''}.
Prefer reddit.com, facebook.com, instagram.com, youtube.com, zillow.com, realtor.com, nextdoor.com, x.com, linkedin.com.
Return JSON with "items": [{title, url, platform, contentSnippet}].

Queries:
${userPrompt}` }
            ],
            stream: false,
            search_recency_filter: 'week'
          };

          const r = await perplex.post('/chat/completions', payload);
          const data = r.data || {};

          if (Array.isArray(data.search_results)) {
            items = data.search_results
              .map(s => ({ title: s.title || 'Found', url: s.url, platform: 'web', contentSnippet: s.snippet || '' }))
              .filter(i => isAllowed(i.url));
          }

          if ((!items || items.length === 0) && data.choices?.[0]?.message?.content) {
            const txt = data.choices[0].message.content;
            try {
              const parsed = JSON.parse(txt);
              if (Array.isArray(parsed.items)) {
                items = parsed.items
                  .map(o => ({ title: o.title || 'Found', url: o.url, platform: o.platform || 'web', contentSnippet: o.content || o.contentSnippet || '' }))
                  .filter(i => isAllowed(i.url));
              }
            } catch {
              const urlRegex = /(https?:\/\/[^\s)]+)\)?/g;
              const urls = [...txt.matchAll(urlRegex)].map(m => m[1]).filter(isAllowed);
              items = urls.slice(0, 20).map(u => ({ title: 'Found', url: u, platform: 'web', contentSnippet: '' }));
            }
          }
        } catch (e) {
          console.error('[discover] Perplexity error (city:', loc.city, '):', e?.response?.data || e.message);
        }
      }

      // --- Apify fallback if needed (per location)
      if ((!items || items.length === 0) && apify && qList.length) {
        try {
          const gsQueriesString = qList
            .map(q => `${q} site:(${allowedDomains.join(' OR ')}) ${loc.city || ''} ${loc.state || ''}`.trim())
            .join('\n');

          const start = await apify.post('/v2/acts/apify~google-search-scraper/runs', {
            queries: gsQueriesString,
            maxPagesPerQuery: 1,
            resultsPerPage: 10,
            countryCode: 'us',
            saveHtml: false
          });

          const runId = start.data?.data?.id;
          if (!runId) throw new Error('No Apify run id');

          const wait = ms => new Promise(r => setTimeout(r, ms));
          let status = 'RUNNING', datasetId = null, tries = 0;
          while (tries < 20) {
            const st = await apify.get(`/v2/actor-runs/${runId}`);
            status    = st.data?.data?.status;
            datasetId = st.data?.data?.defaultDatasetId;
            if (status === 'SUCCEEDED' && datasetId) break;
            if (['FAILED','ABORTED','TIMED_OUT'].includes(status)) throw new Error(`Apify run ${status}`);
            await wait(1500); tries++;
          }

          if (status === 'SUCCEEDED' && datasetId) {
            const itemsResp = await apify.get(`/v2/datasets/${datasetId}/items?clean=true&format=json`);
            const raw = Array.isArray(itemsResp.data) ? itemsResp.data : [];
            items = raw.map(r => ({
              title: r.title || 'Found', url: r.url, platform: 'web', contentSnippet: r.snippet || ''
            })).filter(i => isAllowed(i.url));
          }
        } catch (e) {
          console.error('[discover] Apify fallback error (city:', loc.city, '):', e?.response?.data || e.message);
        }
      }

      // Tag each item with the location used and dedupe by URL
      for (const it of (items || [])) {
        if (!it.url || seen.has(it.url)) continue;
        seen.add(it.url);
        allItems.push({ ...it, city: loc.city, state: loc.state });
      }
    }

    return res.json({
      ok: true,
      items: allItems.slice(0, 60), // cap total
      provider: allItems.length ? 'perplexity|apify' : 'none',
      locations: locs
    });
  } catch (e) {
    console.error('discover fatal:', e?.response?.data || e.message);
    return res.status(200).json({ ok: true, items: [], warning: 'discover failed; returned empty list' });
  }
});
// ---- Comments for a single URL (YouTube + Reddit now; IG/FB/Nextdoor when actors/creds ready) ----
app.post('/api/comments', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok:false, error:'url required' });

    const host = new URL(url).hostname.replace(/^www\./,'').toLowerCase();
    const apify = client('apify');
    const items = [];

    // Helper: poll an Apify run to SUCCEEDED and return dataset items
    async function pollApifyRun(runId) {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      let status = 'RUNNING', datasetId = null, tries = 0;
      while (tries < 25) {
        const st = await apify.get(`/v2/actor-runs/${runId}`);
        status    = st.data?.data?.status;
        datasetId = st.data?.data?.defaultDatasetId;
        if (status === 'SUCCEEDED' && datasetId) {
          const resp = await apify.get(`/v2/datasets/${datasetId}/items?clean=true&format=json`);
          return Array.isArray(resp.data) ? resp.data : [];
        }
        if (['FAILED','ABORTED','TIMED_OUT'].includes(status)) throw new Error(`Apify run ${status}`);
        await wait(1500); tries++;
      }
      return [];
    }

    // YOUTUBE
    if (host.endsWith('youtube.com') || host.endsWith('youtu.be')) {
      const key = process.env.YOUTUBE_API_KEY;
      // Try native API first if you provided a key
      const videoId =
        (url.match(/[?&]v=([^&#]+)/) || [])[1] ||
        (host === 'youtu.be' ? url.split('/').pop().split(/[?&#]/)[0] : null);

      if (key && videoId) {
        const yt = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
          params: { part: 'snippet', videoId, maxResults: 100, key }
        });
        const arr = yt.data?.items || [];
        for (const c of arr) {
          const sn = c?.snippet?.topLevelComment?.snippet;
          if (!sn) continue;
          items.push({
            platform: 'youtube',
            author: sn.authorDisplayName,
            text: sn.textDisplay,
            publishedAt: sn.publishedAt,
            url
          });
        }
        return res.json({ ok:true, items, provider:'youtube-api' });
      }

      // Fallback to Apify actor if no YOUTUBE_API_KEY
      if (apify) {
        const start = await apify.post('/v2/acts/apify~youtube-comments-scraper/runs', {
          startUrls: [{ url }], maxComments: 100
        });
        const runId = start.data?.data?.id;
        if (!runId) return res.json({ ok:true, items, provider:'none' });

        const raw = await pollApifyRun(runId);
        for (const r of raw) {
          items.push({
            platform: 'youtube',
            author: r?.author || r?.authorName || '',
            text: r?.text || r?.comment || '',
            publishedAt: r?.publishedAt || '',
            url
          });
        }
        return res.json({ ok:true, items, provider:'apify' });
      }

      return res.json({ ok:true, items, provider:'none' });
    }

    // REDDIT
    if (host.endsWith('reddit.com') && apify) {
      const start = await apify.post('/v2/acts/apify~reddit-scraper/runs', {
        startUrls: [{ url }],
        maxItems: 200,
        includePostComments: true
      });
      const runId = start.data?.data?.id;
      if (!runId) return res.json({ ok:true, items, provider:'none' });

      const raw = await pollApifyRun(runId);
      for (const r of raw) {
        // Dataset may include both posts and comments
        if (r?.type === 'comment' || r?.comment) {
          items.push({
            platform: 'reddit',
            author: r?.author || '',
            text: r?.text || r?.comment || '',
            publishedAt: r?.created || r?.createdAt || '',
            url
          });
        }
      }
      return res.json({ ok:true, items, provider:'apify' });
    }

    // IG / FB / NEXTDOOR (require specific actors/creds; return empty by default)
    // You can wire specific Apify actors later and map them here.
    return res.json({ ok:true, items, provider:'not-configured' });
  } catch (e) {
    console.error('comments error:', e?.response?.data || e.message);
    res.status(500).json({ ok:false, error:'comments failed' });
  }
});


// ---- 3) Fuse + Score (relocation/PCS + geo + safe) ----
app.post('/api/fuse-score', (req, res) => {
  try {
    const { items = [], location = {} } = req.body || {};
    const CITY = String(location.city || '').toLowerCase();
    const HOODS = (location.neighborhoods || []).map(s=>String(s).toLowerCase());
    const ZIPS  = (location.zipCodes || []).map(z=>String(z));

    const ALLOWED = [
      'relocating for work','job transfer','moving for work','new role in',
      'accepted an offer in','pcs orders','permanent change of station','reporting to base'
    ];
    const SELLER = [ 'sell my house','home sell','list my home','listing agent','fsbo','preforeclosure' ];
    const MOVERS = [ 'moving company','moving soon','relocating','job transfer','pcs orders' ];

    const SENSITIVE = [
      'pregnant','expecting','new baby','newborn','engaged','fiancé','fiance','getting married'
    ];

    function any(text, list){ const t = String(text||'').toLowerCase(); return list.some(k=>t.includes(k)); }
    function geoBoost(text){
      const t = String(text||'').toLowerCase();
      let b = 0;
      if (CITY && t.includes(CITY)) b += 1;
      if (HOODS.some(h => t.includes(h))) b += 1;
      if (ZIPS.some(z => new RegExp(`\\b${z}\\b`).test(t))) b += 1;
      return Math.min(b, 2);
    }

    const leads = items.map(r => {
      const txt = String(r.content || '').toLowerCase();
      let base = 0;
      if (txt.includes('looking for') || txt.includes('searching for')) base += 3;
      if (txt.includes('buy') || txt.includes('purchase')) base += 3;
      if (txt.includes('agent') || txt.includes('realtor')) base += 2;
      if (txt.includes('pre-approved') || txt.includes('pre approved')) base += 4;
      if (txt.includes('cash buyer')) base += 4;
      if (txt.includes('urgent') || txt.includes('asap')) base += 3;
      if (txt.includes('moving') || txt.includes('relocating')) base += 2;
      if (any(txt, SELLER)) {base += 3; // strong seller intent
  r.signals = Array.from(new Set([...(r.signals || []), 'seller-intent']));
}
if (any(txt, MOVERS)) {base += 2; // “in motion”
  r.signals = Array.from(new Set([...(r.signals || []), 'mover']));
}

      if (any(txt, ALLOWED)) {
        base += 2;
        r.signals = Array.from(new Set([...(r.signals||[]), 'relocation']));
      }
      if (any(txt, SENSITIVE)) {
        r._transientSensitive = true; // not persisted
      }

      base += geoBoost(txt);
      const score = Math.max(0, Math.min(10, base));

      return {
        source: r.source || 'public',
        platform: r.platform || 'web',
        url: r.url,
        content: r.content,
        signals: r.signals || [],
        finalIntentScore: score,
        urgency: score>=8?'immediate':score>=6?'high':score>=4?'medium':'low',
        timeline: score>=8?'1-14 days':score>=6?'2-8 weeks':score>=4?'2-6 months':'6+ months',
        city: location.city || 'Unknown',
        state: location.state || 'Unknown',
        timestamp: new Date().toISOString()
      };
    });

    res.json({ leads });
  } catch (e) {
    console.error('fuse-score error:', e?.response?.data || e.message);
    res.status(500).json({ ok:false, error:'fuse-score failed' });
  }
});

// ---- 4) Content generation (Claude) ----
app.post('/api/content-generation', async (req, res) => {
  try {
    const { location = {}, lead = {} } = req.body || {};
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return res.json({
        smsA: `Hi ${lead.firstName||'there'}! Quick question about ${location.city||'your area'} homes.`.slice(0,160),
        smsB: `Hello! Want a short ${location.city||'your area'} market update?`.slice(0,160),
        emailSubjectA: `${location.city||'Your area'} market snapshot for you`,
        emailBodyA: `Hi ${lead.firstName||'there'},\nHere’s a helpful update.`,
        emailSubjectB: `Quick ${location.city||'Your area'} real estate insights`,
        emailBodyB: `Hi ${lead.firstName||'there'},\nSome useful info for your search.`,
        videoScript: `Hi ${lead.firstName||'there'}, quick update on ${location.city||'your area'} and how I can help.`,
        provider: 'mock'
      });
    }
    const anthropic = makeClient({ baseURL:'https://api.anthropic.com', headers:{ 'x-api-key': key, 'anthropic-version':'2023-06-01','content-type':'application/json' } });
    const r = await anthropic.post('/v1/messages', {
      model: 'claude-3-haiku-20240307',
      max_tokens: 900,
      system: 'You are a Fair Housing–compliant real estate copywriter. No steering.',
      messages: [{
        role: 'user',
        content: `Return STRICT JSON with keys: smsA, smsB, emailSubjectA, emailBodyA, emailSubjectB, emailBodyB, videoScript. Lead=${JSON.stringify(lead)}; City=${location.city}.`
      }]
    });
    res.json(r.data);
  } catch (e) {
    console.error('content-generation error:', e?.response?.data || e.message);
    res.status(500).json({ ok:false, error:'content-generation failed' });
  }
});

// ---- 5) HeyGen passthrough ----
app.post('/api/heygen/video', async (req, res) => {
  try {
    const key = process.env.HEYGEN_API_KEY;
    if (!key) return res.status(400).json({ ok:false, error:'HEYGEN_API_KEY not set' });
    const heygen = makeClient({ baseURL:'https://api.heygen.com', headers:{ 'X-API-Key': key, 'content-type':'application/json' } });
    const r = await heygen.post('/v2/video/generate', req.body);
    res.json(r.data);
  } catch (e) {
    console.error('heygen error:', e?.response?.data || e.message);
    res.status(500).json({ ok:false, error:'heygen failed' });
  }
});

// ---- 6) Apollo Enrich ----
app.post('/api/apollo/enrich', async (req, res) => {
  try {
    const apollo = client('apollo');
    if (!apollo) return res.status(400).json({ ok:false, error:'APOLLO_API_KEY not set' });
    const r = await apollo.post('/v1/people/enrich', req.body);
    res.json(r.data);
  } catch (e) {
    console.error('apollo error:', e?.response?.data || e.message);
    res.status(500).json({ ok:false, error:'apollo failed' });
  }
});

// ---- 7) IDX Leads ----
app.get('/api/idx/leads', async (req, res) => {
  try {
    const idx = client('idx');
    if (!idx) return res.status(400).json({ ok:false, error:'IDX_ACCESS_KEY not set' });
    const r = await idx.get('/leads/lead');
    res.json(r.data);
  } catch (e) {
    console.error('idx error:', e?.response?.data || e.message);
    res.status(500).json({ ok:false, error:'idx failed' });
  }
});

// ---- 8) Public records passthrough ----
app.post('/api/public-records', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok:false, error:'url required' });
    const r = await axios.get(url, { timeout: 20000 });
    res.json({ items: r.data });
  } catch (e) {
    console.error('public-records error:', e?.response?.data || e.message);
    res.status(500).json({ ok:false, error:'public-records failed' });
  }
});

// ---- 9) Mortgage events ingest ----
app.post('/api/mortgage-event', (req, res) => {
  const payload = req.body || {};
  console.log('Mortgage event:', payload.event, 'for', payload?.contact?.email || payload?.contact?.phone);
  res.json({ ok:true });
});

// ---- 10) Analytics + webhook ----
app.post('/api/analytics-tracking', (req, res) => {
  console.log('Analytics:', req.body?.event, req.body?.metrics);
  res.json({ ok:true });
});
app.post('/webhooks/video-complete', (req, res) => {
  console.log('Video complete payload:', req.body);
  res.json({ ok:true });
});
// === /api/comments : YouTube + Reddit (FB/IG/Nextdoor return empty unless you add actors) ===
app.post('/api/comments', async (req, res) => {
  try {
    const { url, city='', state='' } = req.body || {};
    if (!url) return res.status(400).json({ ok:false, error:'url required' });

    const host = new URL(url).hostname.replace(/^www\./,'');
    const apify = client('apify');
    const items = [];

    // YouTube – native API first
    if (/youtube\.com|youtu\.be/i.test(host)) {
      const key = process.env.YOUTUBE_API_KEY;
      const vid = (url.match(/[?&]v=([^&#]+)/) || [])[1];
      if (key && vid) {
        const yt = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
          params: { part: 'snippet', videoId: vid, maxResults: 80, key }
        });
        for (const row of (yt.data.items || [])) {
          const sn = row.snippet.topLevelComment.snippet;
          items.push({
            platform: 'youtube',
            author: sn.authorDisplayName,
            text: sn.textDisplay,
            publishedAt: sn.publishedAt
          });
        }
        return res.json({ ok:true, url, city, state, items, provider:'youtube-api' });
      }
    }

    // Reddit via Apify
    if (/reddit\.com$/i.test(host) && apify) {
      const run = await apify.post('/v2/acts/apify~reddit-scraper/runs', {
        startUrls: [{ url }], maxItems: 150, includePostComments: true
      });
      const runId = run.data?.data?.id;
      const wait = ms => new Promise(r => setTimeout(r, ms));
      let status='RUNNING', datasetId=null, tries=0;
      while (tries < 20) {
        const st = await apify.get(`/v2/actor-runs/${runId}`);
        status    = st.data?.data?.status;
        datasetId = st.data?.data?.defaultDatasetId;
        if (status==='SUCCEEDED' && datasetId) break;
        if (['FAILED','ABORTED','TIMED_OUT'].includes(status)) throw new Error(`Apify run ${status}`);
        await wait(1500); tries++;
      }
      if (status==='SUCCEEDED' && datasetId) {
        const resp = await apify.get(`/v2/datasets/${datasetId}/items?clean=true&format=json`);
        for (const r of (resp.data || [])) {
          if (Array.isArray(r.comments)) {
            for (const c of r.comments) items.push({
              platform: 'reddit',
              author: c.author,
              text: c.text,
              publishedAt: c.createdAt
            });
          }
        }
      }
      return res.json({ ok:true, url, city, state, items, provider:'apify-reddit' });
    }

    // FB/IG/Nextdoor – return empty unless you wire actors/tokens later
    return res.json({ ok:true, url, city, state, items: [], provider:'none' });
  } catch (e) {
    console.error('comments error:', e?.response?.data || e.message);
    res.status(500).json({ ok:false, error:'comments failed' });
  }
});

// === /api/market-report : simple placeholder so your node doesn’t 404 ===
app.post('/api/market-report', async (req, res) => {
  const { city='', state='' } = req.body || {};
  // TODO: generate real PDF later; for now return a placeholder URL
  return res.json({ ok:true, report_url:`https://example.com/market-report-${encodeURIComponent(city)}-${encodeURIComponent(state)}.pdf` });
});

// === /api/performance/digest : placeholder stats for daily digest ===
app.get('/api/performance/digest', (req, res) => {
  const hours = Number(req.query.hours || 24);
  // TODO: compute real stats from your DB/logs
  res.json({
    ok:true,
    stats:{
      windowHours: hours,
      totalLeads: 0,
      intentDistribution: { immediate:0, high:0, medium:0, low:0 },
      sourceBreakdown: { public:0, idx:0 },
      topSignals:[]
    }
  });
});
// ---- Global error guard ----
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok:false, error:'server error' });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('MCP OMNI PRO listening on', port));
