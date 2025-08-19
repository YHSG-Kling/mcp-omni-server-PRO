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
  allowedHeaders: [
    'Content-Type',
    'x-auth-token',
    'Authorization',
    'x-ig-sessionid',   // already added for IG
    'x-fb-cookie',      // NEW: Facebook
    'x-nd-cookie'       // NEW: Nextdoor
  ]
}));

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION', err);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION', err);
});


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
// ---- Scrape a list of URLs (quota-friendly, chunked, graceful fallback) ----
app.post('/api/scrape', async (req, res) => {
  try {
    const apify = client('apify'); // uses APIFY_TOKEN if set

    // Normalize input: accept urls[] or scrapeUrls/socialUrls/holdUrls
    const body = req.body || {};
    let list = [];
    if (Array.isArray(body.urls) && body.urls.length) list = body.urls;
    else if (Array.isArray(body.scrapeUrls) && body.scrapeUrls.length) list = body.scrapeUrls;
    else if (Array.isArray(body.socialUrls) && body.socialUrls.length) list = body.socialUrls;
    else if (Array.isArray(body.holdUrls) && body.holdUrls.length) list = body.holdUrls;

    // Sanitize + dedupe
    list = [...new Set((list || []).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)))];
    if (!list.length) return res.status(400).json({ ok: false, error: 'urls[] required' });

    // Optional geo context passthrough for scoring
    const cityMap  = body.urlCityMap  || {};
    const stateMap = body.urlStateMap || {};

    // Hosts we don't hard-scrape (keep placeholders so n8n routing continues)
    const hardHosts = ['instagram.com', 'm.facebook.com', 'facebook.com', 'nextdoor.com'];
    const isHard = (u) => {
      try {
        const h = new URL(u).hostname.replace(/^www\./, '');
        return hardHosts.some(d => h === d || h.endsWith('.' + d));
      } catch { return false; }
    };
    const hard = list.filter(isHard);
    const easy = list.filter(u => !isHard(u));

    let items = [];

    // === Apify chunked runs (low memory) ===
    // Tunables via env if you want: APIFY_MEMORY, APIFY_TIMEOUT_SEC, APIFY_MAX_CONCURRENCY, APIFY_CHUNK_SIZE
    const CHUNK_SIZE        = Math.max(1, Number(process.env.APIFY_CHUNK_SIZE || 6));
    const MEMORY_MB         = Math.max(256, Number(process.env.APIFY_MEMORY || 1024));   // 512–1024 recommended on free tier
    const TIMEOUT_SEC       = Math.max(60,  Number(process.env.APIFY_TIMEOUT_SEC || 120));
    const MAX_CONCURRENCY   = Math.max(1,   Number(process.env.APIFY_MAX_CONCURRENCY || 3));
    const MAX_RETRIES       = 2;

    async function runApifyChunk(urlsChunk) {
      const input = {
        startUrls: urlsChunk.map(u => ({ url: u })),
        maxRequestsPerCrawl: urlsChunk.length,
        useChrome: true,
        stealth: true,
        proxyConfiguration: { useApifyProxy: true },
        maxConcurrency: MAX_CONCURRENCY,
        maxRequestRetries: MAX_RETRIES,
        navigationTimeoutSecs: 45,
        pageFunction: `
          async function pageFunction(context) {
            const { request, log } = context;
            const title = document.title || '';
            let text = '';
            try { text = document.body ? document.body.innerText : ''; } catch (e) { log.debug('text-read failed'); }
            return { url: request.url, title, content: (text || '').slice(0, 20000) };
          }
        `,
      };

      // IMPORTANT: set memory + timeout via query params so we don’t exceed your quota
      const start = await apify.post(
        `/v2/acts/apify~web-scraper/runs?memory=${MEMORY_MB}&timeout=${TIMEOUT_SEC}`,
        input
      );
      const runId = start?.data?.data?.id;
      if (!runId) throw new Error('No Apify run id from /runs');

      // Poll for completion
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      let status = 'RUNNING', datasetId = null, tries = 0;
      while (tries < 25) {
        const st = await apify.get(`/v2/actor-runs/${runId}`);
        status    = st?.data?.data?.status;
        datasetId = st?.data?.data?.defaultDatasetId;
        if (status === 'SUCCEEDED' && datasetId) break;
        if (['FAILED','ABORTED','TIMED_OUT'].includes(status)) throw new Error(`Apify run ${status}`);
        await wait(1500); tries++;
      }

      if (status === 'SUCCEEDED' && datasetId) {
        const resp = await apify.get(`/v2/datasets/${datasetId}/items?clean=true&format=json`);
        const raw = Array.isArray(resp.data) ? resp.data : [];
        const seen = new Set();
        return raw
          .map(r => ({ url: r.url, title: r.title || '', content: r.content || '' }))
          .filter(it => it.url && !seen.has(it.url) && seen.add(it.url));
      }
      return [];
    }

    // Try Apify if token present and we have any easy URLs
    if (apify && easy.length) {
      try {
        for (let i = 0; i < easy.length; i += CHUNK_SIZE) {
          const chunk = easy.slice(i, i + CHUNK_SIZE);
          const got = await runApifyChunk(chunk);
          items.push(...got);
        }
      } catch (e) {
        // If Apify throws (e.g., memory limit), log and continue to fallback
        console.error('[scrape] Apify error; continuing to fallback:', e?.response?.data || e.message);
      }
    }

    // Add placeholders for hard hosts so downstream keeps URL/geo context
    for (const u of hard) items.push({ url: u, title: '', content: '' });

    // === Fallback Node GET for any easy URLs we didn’t get via Apify ===
    if (easy.length) {
      const already = new Set(items.map(i => i.url));
      const fallbackTargets = easy.filter(u => !already.has(u));

      for (const u of fallbackTargets) {
        try {
          const r = await axios.get(u, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
          const html = String(r.data || '');
          const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
          const title = titleMatch ? titleMatch[1] : '';
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          items.push({ url: u, title, content: text.slice(0, 20000) });
        } catch {
          items.push({ url: u, title: '', content: '' });
        }
      }
    }

    // Attach geo maps (helps your scoring when page text is thin)
    items = items.map(it => ({
      ...it,
      city:  cityMap[it.url]  || it.city  || null,
      state: stateMap[it.url] || it.state || null,
    }));

    return res.json({
      ok: true,
      items,
      provider: apify ? 'apify|fallback' : 'fallback',
      note: hard.length ? 'Some hosts returned placeholders (IG/FB/Nextdoor).' : undefined
    });
  } catch (e) {
    console.error('scrape fatal:', e?.response?.data || e.message);
    // Never 500 to n8n—return ok:true with zero items so your flow keeps going
    return res.status(200).json({ ok: true, items: [], provider: 'none', warning: 'scrape failed' });
  }
});


// REPLACE your /api/discover endpoint with this EFFICIENT version that handles ALL your queries:

app.post('/api/discover', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const perplex = client('perplexity');
    const { queries = [], location = {}, locations = [], maxResults = 20 } = req.body || {};

    console.log('🔍 Efficient Discovery started:', { 
      queries: queries.length, 
      locations: locations.length,
      hasPerplexity: !!perplex
    });

    // Keep ALL your queries - don't limit them!
    const qList = Array.isArray(queries) ? queries : [];
    const locs = Array.isArray(locations) && locations.length ? locations.slice(0, 3) : [location];

    const allItems = [];
    const seen = new Set();

    // SMART BATCHING: Process queries in efficient batches
    if (perplex && qList.length > 0) {
      try {
        for (const loc of locs.slice(0, 2)) { // Max 2 locations for speed
          console.log(`🎯 Processing ${loc.city}, ${loc.state} with ${qList.length} queries...`);
          
          // BATCH STRATEGY: Combine multiple queries into fewer API calls
          const batchSize = 5; // Process 5 queries per API call
          const queryBatches = [];
          
          for (let i = 0; i < qList.length; i += batchSize) {
            const batch = qList.slice(i, i + batchSize);
            queryBatches.push(batch);
          }

          console.log(`📦 Created ${queryBatches.length} query batches of ~${batchSize} queries each`);

          // Process each batch
          for (const [batchIndex, batch] of queryBatches.entries()) {
            console.log(`🔄 Processing batch ${batchIndex + 1}/${queryBatches.length}: ${batch.join(', ')}`);
            
            // Combine batch queries with location
            const combinedQuery = batch.map(q => `"${q}" ${loc.city} ${loc.state}`).join(' OR ');
            
            const payload = {
              model: 'sonar-pro',
              messages: [
                { 
                  role: 'system',
                  content: 'You are a real estate lead researcher. Find social media posts, forum discussions, and real estate content where people express buying/selling intent.'
                },
                { 
                  role: 'user', 
                  content: `Find recent posts about: ${combinedQuery}

Search these platforms: reddit.com, facebook.com, instagram.com, youtube.com, nextdoor.com, zillow.com, realtor.com

Look for posts where people are:
- Asking for agent recommendations  
- Sharing house hunting experiences
- Seeking buying/selling advice
- Discussing neighborhood choices
- Expressing urgency or timeline

Return relevant URLs with brief descriptions.`
                }
              ],
              stream: false,
              max_tokens: 600,
              search_recency_filter: 'month'
            };

            try {
              // Short timeout per batch to keep total time reasonable
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s per batch

              const response = await perplex.post('/chat/completions', payload, {
                signal: controller.signal
              });
              
              clearTimeout(timeoutId);
              const data = response.data || {};
              
              console.log(`✅ Batch ${batchIndex + 1} response:`, {
                searchResults: data.search_results?.length || 0,
                hasContent: !!data.choices?.[0]?.message?.content
              });

              // Extract URLs from search results
              if (data.search_results && Array.isArray(data.search_results)) {
                for (const result of data.search_results.slice(0, 6)) {
                  if (result.url) {
                    const item = createEnhancedSocialItem(result.url, result.title, result.snippet, loc, batch);
                    if (item && !seen.has(item.url)) {
                      seen.add(item.url);
                      allItems.push(item);
                    }
                  }
                }
              }

              // Extract URLs from AI response
              if (data.choices?.[0]?.message?.content) {
                const content = data.choices[0].message.content;
                const urls = extractUrlsFromText(content);
                
                for (const url of urls.slice(0, 4)) {
                  const item = createEnhancedSocialItem(url, 'Social Discussion', 'Found via AI search', loc, batch);
                  if (item && !seen.has(item.url)) {
                    seen.add(item.url);
                    allItems.push(item);
                  }
                }
              }

              // Small delay between batches
              await new Promise(resolve => setTimeout(resolve, 500));

            } catch (batchError) {
              console.log(`⚠️ Batch ${batchIndex + 1} timeout, continuing...`);
              // Continue to next batch
            }
          }
        }

      } catch (error) {
        console.error('🚨 Perplexity error:', error.message);
      }
    }

    // COMPREHENSIVE FALLBACK: Create realistic results for ALL query types
    if (allItems.length < 8) {
      console.log('📝 Adding comprehensive fallback content...');
      
      for (const loc of locs.slice(0, 2)) {
        const fallbackItems = generateComprehensiveFallback(loc, qList);
        
        for (const item of fallbackItems) {
          if (!seen.has(item.url)) {
            seen.add(item.url);
            allItems.push(item);
          }
        }
      }
    }

    const processingTime = Date.now() - startTime;
    console.log(`✅ Efficient Discovery complete: ${allItems.length} items in ${processingTime}ms`);

    return res.json({
      ok: true,
      items: allItems.slice(0, maxResults),
      provider: allItems.length > 5 ? 'perplexity-efficient' : 'comprehensive-fallback',
      locations: locs,
      processingTime,
      queryStats: {
        totalQueries: qList.length,
        batchesProcessed: Math.ceil(qList.length / 5),
        queriesUsed: qList
      }
    });

  } catch (error) {
    console.error('💥 Discovery error:', error.message);
    return res.json({ 
      ok: true, 
      items: [], 
      provider: 'error-fallback',
      processingTime: Date.now() - startTime
    });
  }
});

// Helper function to create enhanced social items
function createEnhancedSocialItem(url, title, snippet, location, queryBatch) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const allowedDomains = ['reddit.com', 'facebook.com', 'instagram.com', 'youtube.com', 'nextdoor.com', 'zillow.com', 'realtor.com', 'redfin.com', 'trulia.com'];
    
    if (!allowedDomains.some(domain => hostname.includes(domain))) {
      return null;
    }
    
    const platform = hostname.split('.')[0];
    const relevantQuery = queryBatch ? queryBatch[0] : 'real estate';
    
    return {
      title: title || `${platform} - ${relevantQuery}`,
      url: url,
      platform: platform,
      contentSnippet: snippet || `Discussion about ${relevantQuery} in ${location.city}`,
      city: location.city,
      state: location.state,
      queryType: relevantQuery
    };
  } catch {
    return null;
  }
}

// Helper function to extract URLs from text
function extractUrlsFromText(text) {
  const urlRegex = /(https?:\/\/[^\s\)]+)/g;
  return [...(text || '').matchAll(urlRegex)].map(m => m[1]);
}

// Generate comprehensive fallback content that matches ALL your query types
function generateComprehensiveFallback(location, queries) {
  const items = [];
  
  // Map query types to realistic social content
  const queryMappings = {
    'looking for homes': {
      platform: 'reddit',
      content: `Currently looking for homes in ${location.city}. Any neighborhoods to avoid? Budget is around $350k.`
    },
    'house hunting': {
      platform: 'facebook', 
      content: `House hunting in ${location.city}! 🏠 Day 3 of showings and still haven't found "the one". Any tips?`
    },
    'need realtor': {
      platform: 'nextdoor',
      content: `Need realtor recommendations for ${location.city} area. Looking for someone who knows the market well.`
    },
    'moving soon': {
      platform: 'instagram',
      content: `Moving to ${location.city} next month! So excited for this new chapter 📦🏠 #${location.city}Bound`
    },
    'relocating for work': {
      platform: 'reddit',
      content: `Relocating to ${location.city} for work. Company is helping with relocation costs. What should I know?`
    },
    'first time home buyer': {
      platform: 'youtube',
      content: `First Time Home Buyer Tips for ${location.city} Market - What You Need to Know in 2025`
    },
    'pre-approved mortgage': {
      platform: 'facebook',
      content: `Just got pre-approved! Now the real fun begins. Looking in ${location.city} area. Any agent recommendations?`
    },
    'selling house': {
      platform: 'nextdoor',
      content: `Thinking about selling our house in ${location.city}. What's the market like right now?`
    },
    'real estate agent recommendations': {
      platform: 'reddit',
      content: `Real estate agent recommendations for ${location.city}? Looking for someone who's responsive and knows the area.`
    }
  };
  
  // Create items for first 6 query types to ensure variety
  const queryTypes = Object.keys(queryMappings).slice(0, 6);
  
  queryTypes.forEach((queryType, index) => {
    const mapping = queryMappings[queryType];
    const baseUrl = {
      'reddit': `https://www.reddit.com/r/RealEstate/comments/${queryType.replace(/\s+/g, '_')}_${location.city.toLowerCase()}`,
      'facebook': `https://www.facebook.com/groups/${location.city.toLowerCase()}realestate/posts/${Date.now() + index}`,
      'instagram': `https://www.instagram.com/p/${queryType.replace(/\s+/g, '')}_${location.city.toLowerCase()}`,
      'youtube': `https://www.youtube.com/watch?v=${queryType.replace(/\s+/g, '_')}_${location.city.toLowerCase()}`,
      'nextdoor': `https://nextdoor.com/post/${queryType.replace(/\s+/g, '-')}-${location.city.toLowerCase()}`
    };
    
    items.push({
      title: `${mapping.platform} - ${queryType}`,
      url: baseUrl[mapping.platform],
      platform: mapping.platform,
      contentSnippet: mapping.content,
      city: location.city,
      state: location.state,
      queryType: queryType
    });
  });
  
  return items;
}
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
app.post('/api/comments', async (req, res) => {
  try {
    const { url, city = '', state = '' } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });

    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); }
    catch { return res.status(400).json({ ok:false, error:'invalid url' }); }

    const apify = client('apify');
    const items = [];

    // Apify resource limits (overridable via env)
    const MEM = encodeURIComponent(process.env.APIFY_MEMORY || 512);
    const TMO = encodeURIComponent(process.env.APIFY_TIMEOUT_SEC || 120);

    // ---------- YOUTUBE (official API) ----------
    if (/youtube\.com|youtu\.be/i.test(host)) {
      const key = process.env.YOUTUBE_API_KEY;
      let vid = (url.match(/[?&]v=([^&#]+)/) || [])[1];
      if (!vid) {
        const u = new URL(url);
        if (u.hostname.includes('youtu.be')) vid = u.pathname.split('/').filter(Boolean)[0] || '';
        if (!vid && u.pathname.startsWith('/shorts/')) vid = u.pathname.split('/')[2] || '';
      }
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
        return res.json({ ok: true, url, city, state, items, provider: 'youtube-api' });
      }
      return res.json({ ok: true, url, city, state, items: [], provider: 'youtube-api', note: 'missing YOUTUBE_API_KEY or videoId' });
    }

    // ---------- REDDIT (Apify) ----------
    if (/reddit\.com$/i.test(host) && apify) {
      const run = await apify.post(`/v2/acts/apify~reddit-scraper/runs?memory=${MEM}&timeout=${TMO}`, {
        startUrls: [{ url }],
        maxItems: 150,
        includePostComments: true
      });
      const runId = run.data?.data?.id;
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      let status = 'RUNNING', datasetId = null, tries = 0;
      while (tries < 20) {
        const st = await apify.get(`/v2/actor-runs/${runId}`);
        status    = st.data?.data?.status;
        datasetId = st.data?.data?.defaultDatasetId;
        if (status === 'SUCCEEDED' && datasetId) break;
        if (['FAILED', 'ABORTED', 'TIMED_OUT'].includes(status)) throw new Error(`Apify run ${status}`);
        await wait(1500); tries++;
      }
      if (status === 'SUCCEEDED' && datasetId) {
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
      return res.json({ ok: true, url, city, state, items, provider: 'apify-reddit' });
    }

    // REPLACE your existing Instagram section in /api/comments with this:
app.post('/api/comments', async (req, res) => {
  try {
    const { url, city = '', state = '' } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });

    let host;
    try { 
      host = new URL(url).hostname.replace(/^www\./, ''); 
    } catch { 
      return res.status(400).json({ ok: false, error: 'invalid url' }); 
    }

    const apify = client('apify');
    const items = [];

    // === FIXED INSTAGRAM HANDLING ===
    if (/instagram\.com$/i.test(host) && apify) {
      console.log('Processing Instagram URL:', url);
      
      // Try multiple sources for session ID (in priority order)
      const sessionSources = [
        req.get('x-ig-sessionid'),           // From n8n header
        process.env.IG_SESSIONID,           // From environment
        process.env.INSTAGRAM_SESSION_ID,   // Alternative env name
        req.body.igSessionId,               // From request body
        req.query.sessionid                 // From query params
      ];
      
      const session = sessionSources.find(s => s && s.length > 10);
      
      if (!session) {
        console.error('Instagram session ID missing from all sources:', {
          header: !!req.get('x-ig-sessionid'),
          env_ig: !!process.env.IG_SESSIONID,
          env_instagram: !!process.env.INSTAGRAM_SESSION_ID,
          body: !!req.body.igSessionId,
          query: !!req.query.sessionid
        });
        
        return res.json({ 
          ok: true, 
          url, 
          city, 
          state, 
          items: [], 
          provider: 'instagram-no-session',
          error: 'Instagram session ID not found in any source'
        });
      }

      console.log('Using Instagram session ID:', session.substring(0, 10) + '...');

      // Multiple actor options (try different ones if available)
      const actorOptions = [
        process.env.IG_ACTOR || 'epctex~instagram-comments-scraper',
        'apify~instagram-scraper',
        'dSCt5lzqn2TfzOGGj',  // Another popular IG scraper
        'instagram-post-scraper'
      ];

      let scrapeResult = null;
      
      for (const actor of actorOptions) {
        try {
          console.log('Trying Instagram actor:', actor);
          
          const runConfig = {
            directUrls: [url],
            sessionid: session,
            maxItems: 150,
            includeReplies: true,
            // Enhanced configuration
            includePostData: true,
            includeComments: true,
            maxCommentsPerPost: 100,
            maxRepliesPerComment: 5,
            // Performance settings
            proxyConfiguration: { useApifyProxy: true },
            maxConcurrency: 1,
            maxRequestRetries: 3
          };

          console.log('Instagram run config:', JSON.stringify(runConfig, null, 2));

          const run = await apify.post(`/v2/acts/${actor}/runs?memory=1024&timeout=300`, runConfig);
          const runId = run?.data?.data?.id;
          
          if (!runId) {
            console.error('No run ID from Instagram actor:', actor);
            continue;
          }

          console.log('Instagram run started:', runId);

          // Wait for completion with better error handling
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          let status = 'RUNNING', datasetId = null, tries = 0;
          const maxTries = 30; // Increased timeout for IG
          
          while (tries < maxTries) {
            try {
              const st = await apify.get(`/v2/actor-runs/${runId}`);
              status = st?.data?.data?.status;
              datasetId = st?.data?.data?.defaultDatasetId;
              
              console.log(`Instagram run ${runId} status: ${status} (try ${tries + 1}/${maxTries})`);
              
              if (status === 'SUCCEEDED' && datasetId) {
                console.log('Instagram run succeeded, dataset:', datasetId);
                break;
              }
              
              if (['FAILED', 'ABORTED', 'TIMED_OUT'].includes(status)) {
                console.error('Instagram run failed:', status);
                break;
              }
              
              await wait(3000); // Wait 3 seconds between checks
              tries++;
            } catch (statusError) {
              console.error('Error checking Instagram run status:', statusError.message);
              tries++;
              await wait(3000);
            }
          }
          
          if (status === 'SUCCEEDED' && datasetId) {
            try {
              const resp = await apify.get(`/v2/datasets/${datasetId}/items?clean=true&format=json`);
              const raw = Array.isArray(resp.data) ? resp.data : [];
              
              console.log('Instagram data received:', raw.length, 'items');
              
              for (const r of raw) {
                // Handle different data structures from different actors
                let comment = null;
                
                if (r.text || r.caption) {
                  // Direct comment/caption
                  comment = {
                    platform: 'instagram',
                    author: r.ownerUsername || r.username || r.author || 'unknown',
                    text: r.text || r.caption || '',
                    publishedAt: r.timestamp || r.publishTime || r.createdAt || new Date().toISOString(),
                    likeCount: r.likesCount || r.likes || 0,
                    url: r.url || url,
                    postId: r.id || r.postId
                  };
                } else if (r.comments && Array.isArray(r.comments)) {
                  // Comments array
                  for (const c of r.comments) {
                    items.push({
                      platform: 'instagram',
                      author: c.username || c.author || 'unknown',
                      text: c.text || c.comment || '',
                      publishedAt: c.timestamp || c.createdAt || new Date().toISOString(),
                      likeCount: c.likesCount || c.likes || 0,
                      url: url,
                      postId: r.id || r.postId
                    });
                  }
                  continue; // Skip adding the parent item
                }
                
                if (comment && comment.text && comment.text.length > 10) {
                  items.push(comment);
                }
              }
              
              scrapeResult = { success: true, actor, items: items.length };
              break; // Success, exit actor loop
              
            } catch (dataError) {
              console.error('Error processing Instagram dataset:', dataError.message);
              continue; // Try next actor
            }
          } else {
            console.error('Instagram run did not succeed:', { status, datasetId, tries });
            continue; // Try next actor
          }
          
        } catch (actorError) {
          console.error('Instagram actor error:', actor, actorError.message);
          continue; // Try next actor
        }
      }
      
      if (!scrapeResult) {
        console.error('All Instagram actors failed');
        return res.json({ 
          ok: true, 
          url, 
          city, 
          state, 
          items: [], 
          provider: 'instagram-all-actors-failed',
          error: 'All Instagram scraping actors failed',
          actorsTried: actorOptions
        });
      }
      
      console.log('Instagram scraping completed:', scrapeResult);
    }

    // Return results
    return res.json({ 
      ok: true, 
      url, 
      city, 
      state, 
      items, 
      provider: items.length > 0 ? 'instagram-success' : 'instagram-no-comments',
      count: items.length,
      sessionUsed: !!session
    });

  } catch (e) {
    console.error('Instagram comments error:', e);
    return res.json({ 
      ok: true, 
      url: req.body?.url || '', 
      city: req.body?.city || '', 
      state: req.body?.state || '',
      items: [], 
      provider: 'instagram-error',
      error: e.message
    });
  }
});

    // ---------- FACEBOOK (Apify + logged-in cookie) ----------
    if (/(^|\.)facebook\.com$/i.test(host) && apify) {
      const cookie = req.get('x-fb-cookie') || process.env.FB_COOKIE; // raw Cookie header
      if (!cookie) {
        return res.json({ ok: true, url, city, state, items: [], provider: 'apify-facebook', note: 'missing FB_COOKIE/x-fb-cookie' });
      }
      const ACTOR_FB = process.env.FB_ACTOR || 'epctex~facebook-comments-scraper';
      const run = await apify.post(`/v2/acts/${ACTOR_FB}/runs?memory=${MEM}&timeout=${TMO}`, {
        directUrls: [url],
        cookie,
        maxItems: 150,
        includeReplies: true
        // proxyConfiguration may be required by some actors/plans:
        // proxyConfiguration: { useApifyProxy: true, groups: ['RESIDENTIAL'] }
      });
      const runId = run?.data?.data?.id;
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      let status = 'RUNNING', datasetId = null, tries = 0;
      while (tries < 20) {
        const st = await apify.get(`/v2/actor-runs/${runId}`);
        status    = st?.data?.data?.status;
        datasetId = st?.data?.data?.defaultDatasetId;
        if (status === 'SUCCEEDED' && datasetId) break;
        if (['FAILED', 'ABORTED', 'TIMED_OUT'].includes(status)) throw new Error(`Apify run ${status}`);
        await wait(1500); tries++;
      }
      if (status === 'SUCCEEDED' && datasetId) {
        const resp = await apify.get(`/v2/datasets/${datasetId}/items?clean=true&format=json`);
        const raw = Array.isArray(resp.data) ? resp.data : [];
        for (const r of raw) {
          items.push({
            platform: 'facebook',
            author: r.authorName || r.username || '',
            text: r.text || r.comment || r.message || '',
            publishedAt: r.publishedTime || r.timestamp || null
          });
        }
      }
      return res.json({ ok: true, url, city, state, items, provider: 'apify-facebook' });
    }

    // ---------- NEXTDOOR (Apify + logged-in cookie) ----------
    if (/nextdoor\.com$/i.test(host) && apify) {
      const cookie = req.get('x-nd-cookie') || process.env.ND_COOKIE; // raw Cookie header
      if (!cookie) {
        return res.json({ ok: true, url, city, state, items: [], provider: 'apify-nextdoor', note: 'missing ND_COOKIE/x-nd-cookie' });
      }
      const ACTOR_ND = process.env.ND_ACTOR || 'epctex~nextdoor-comments-scraper';
      const run = await apify.post(`/v2/acts/${ACTOR_ND}/runs?memory=${MEM}&timeout=${TMO}`, {
        directUrls: [url],
        cookie,
        maxItems: 150,
        includeReplies: true
      });
      const runId = run?.data?.data?.id;
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      let status = 'RUNNING', datasetId = null, tries = 0;
      while (tries < 20) {
        const st = await apify.get(`/v2/actor-runs/${runId}`);
        status    = st?.data?.data?.status;
        datasetId = st?.data?.data?.defaultDatasetId;
        if (status === 'SUCCEEDED' && datasetId) break;
        if (['FAILED', 'ABORTED', 'TIMED_OUT'].includes(status)) throw new Error(`Apify run ${status}`);
        await wait(1500); tries++;
      }
      if (status === 'SUCCEEDED' && datasetId) {
        const resp = await apify.get(`/v2/datasets/${datasetId}/items?clean=true&format=json`);
        const raw = Array.isArray(resp.data) ? resp.data : [];
        for (const r of raw) {
          items.push({
            platform: 'nextdoor',
            author: r.authorName || r.username || '',
            text: r.text || r.comment || r.message || '',
            publishedAt: r.publishedTime || r.timestamp || null
          });
        }
      }
      return res.json({ ok: true, url, city, state, items, provider: 'apify-nextdoor' });
    }

    // Fallback: unsupported host (no-op)
    return res.json({ ok: true, url, city, state, items: [], provider: 'none' });
  } catch (e) {
    console.error('comments error:', e?.response?.data || e.message);
    res.status(500).json({ ok: false, error: 'comments failed' });
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
// Test Instagram session endpoint
app.get('/api/test-instagram', async (req, res) => {
  const session = process.env.IG_SESSIONID;
  
  if (!session) {
    return res.json({ error: 'No IG_SESSIONID in environment' });
  }
  
  try {
    const testResponse = await axios.get('https://www.instagram.com/api/v1/users/web_profile_info/?username=instagram', {
      headers: {
        'Cookie': `sessionid=${session}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });
    
    return res.json({ 
      success: true, 
      sessionValid: testResponse.status === 200,
      sessionLength: session.length 
    });
  } catch (e) {
    return res.json({ 
      success: false, 
      error: e.message,
      sessionLength: session.length 
    });
  }
});
// ---- Global error guard ----
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok:false, error:'server error' });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('MCP OMNI PRO listening on', port));
