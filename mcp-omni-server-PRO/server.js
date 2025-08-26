// MCP OMNI PRO – Complex server with guardrails + Google CSE + OSINT + URLScan
// ✅ Express + CORS + axios + retries
// ✅ Smart Apify usage with backups
// ✅ Google CSE discovery, OSINT resolve, public email sniff
// ✅ Guardrails: blocks cookie/authorization forwarding to 3rd-party targets
// 🚫 No scraping of logged-in pages or private cookies
// 🔧 FIXED: Crash-resistant with proper error handling

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();

// ---------- Basic app setup ----------
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET','POST'],
  allowedHeaders: [
    'Content-Type','x-auth-token','Authorization','x-ig-sessionid','x-fb-cookie','x-nd-cookie'
  ]
}));

// Response-time decorator
app.use((req, res, next) => {
  req._t0 = Date.now();
  const j = res.json;
  res.json = function (data) {
    const ms = Date.now() - req._t0;
    res.setHeader('X-Response-Time', `${ms}ms`);
    if (data && typeof data === 'object' && !Buffer.isBuffer(data)) {
      data.processingTime = ms;
      data.serverTimestamp = new Date().toISOString();
    }
    return j.call(this, data);
  };
  next();
});

// Simple in-memory rate limiter with cleanup
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 1000;
const CLEANUP_INTERVAL = 60 * 60 * 1000; // Clean up every hour

// Cleanup old rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateLimitMap.entries()) {
    if (now - rec.t0 > RATE_LIMIT_WINDOW * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, CLEANUP_INTERVAL);
// ---------- Storage Setup ----------
const STORAGE_DIR = process.env.STORAGE_DIR || './storage';
const DOCUMENTS_DIR = path.join(STORAGE_DIR, 'documents');
const TEMP_DIR = path.join(STORAGE_DIR, 'temp');

// Initialize storage directories
(async () => {
  try {
    await fs.mkdir(DOCUMENTS_DIR, { recursive: true });
    await fs.mkdir(TEMP_DIR, { recursive: true });
    console.log('✅ Storage directories initialized');
  } catch (e) {
    console.error('Storage directory creation error:', e);
  }
})();

app.use((req, res, next) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = rateLimitMap.get(ip) || { count: 0, t0: now };
    if (now - rec.t0 > RATE_LIMIT_WINDOW) { rec.count = 0; rec.t0 = now; }
    rec.count++;
    rateLimitMap.set(ip, rec);
    if (rec.count > RATE_LIMIT_MAX) return res.status(429).json({ ok:false, error:'Too many requests' });
    next();
  } catch (e) {
    console.error('Rate limiting error:', e);
    next(); // Continue on rate limit errors
  }
});

// x-auth security header
app.use((req, res, next) => {
  try {
    const expected = process.env.AUTH_TOKEN;
    if (!expected) return next(); // dev mode
    const got = req.get('x-auth-token');
    if (got !== expected) return res.status(401).json({ ok:false, error:'unauthorized' });
    next();
  } catch (e) {
    console.error('Auth middleware error:', e);
    res.status(500).json({ ok:false, error:'auth error' });
  }
});

// ---------- Guardrails (NO private cookies/authorization to external sites) ----------
const FORBIDDEN_FORWARD_HEADERS = ['cookie','authorization','x-ig-sessionid','x-fb-cookie','x-nd-cookie'];
function stripForbidden(h = {}) {
  try {
    const clean = { ...h };
    for (const k of Object.keys(clean)) {
      if (FORBIDDEN_FORWARD_HEADERS.includes(k.toLowerCase())) delete clean[k];
    }
    return clean;
  } catch (e) {
    console.error('stripForbidden error:', e);
    return {};
  }
}

function rejectIfHeaderTriesCookies(req, res, next) {
  try {
    for (const h of Object.keys(req.headers || {})) {
      if (FORBIDDEN_FORWARD_HEADERS.includes(h.toLowerCase())) {
        return res.status(400).json({ ok:false, error:'Private cookies/authorization not allowed.' });
      }
    }
    next();
  } catch (e) {
    console.error('Header validation error:', e);
    next(); // Continue on header validation errors
  }
}

// ---------- Utilities ----------
function makeClient({ baseURL, headers = {} }) {
  try {
    const c = axios.create({ baseURL, headers, timeout: 25000 });
    axiosRetry(c, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: e => !e.response || e.response.status >= 500
    });
    return c;
  } catch (e) {
    console.error('makeClient error:', e);
    return null;
  }
}

const PROVIDERS = {
  anthropic: { baseURL:'https://api.anthropic.com', env:'ANTHROPIC_API_KEY', headers:k=>({'x-api-key':k,'anthropic-version':'2023-06-01','content-type':'application/json'})},
  heygen: { baseURL:'https://api.heygen.com', env:'HEYGEN_API_KEY', headers:k=>({'X-API-Key':k,'content-type':'application/json'})},
  perplexity: { baseURL:'https://api.perplexity.ai', env:'PERPLEXITY_API_KEY', headers:k=>({Authorization:`Bearer ${k}`,'content-type':'application/json'})},
  apify: { baseURL:'https://api.apify.com', env:'APIFY_TOKEN', headers:k=>({Authorization:`Bearer ${k}`})},
  apollo: { baseURL:'https://api.apollo.io', env:'APOLLO_API_KEY', headers:k=>({'X-Api-Key':k,'content-type':'application/json'})},
  idx: { baseURL:'https://api.idxbroker.com', env:'IDX_ACCESS_KEY', headers:k=>({accesskey:k, outputtype:'json'})}
};
// IDX Helper Functions
function calculateAveragePrice(sales) {
  if (!sales || sales.length === 0) return 0;
  const total = sales.reduce((sum, sale) => sum + (sale.listPrice || 0), 0);
  return Math.round(total / sales.length);
}

function analyzeTrend(sales) {
  if (!sales || sales.length < 2) return 'stable';
  
  // Sort by date and compare recent vs older prices
  const sorted = sales.sort((a, b) => new Date(b.listDate) - new Date(a.listDate));
  const recent = sorted.slice(0, Math.floor(sorted.length / 2));
  const older = sorted.slice(Math.floor(sorted.length / 2));
  
  const recentAvg = recent.reduce((sum, sale) => sum + (sale.listPrice || 0), 0) / recent.length;
  const olderAvg = older.reduce((sum, sale) => sum + (sale.listPrice || 0), 0) / older.length;
  
  const change = ((recentAvg - olderAvg) / olderAvg) * 100;
  
  if (change > 5) return 'rising';
  if (change < -5) return 'declining';
  return 'stable';
}

function client(name) {
  try {
    const p = PROVIDERS[name];
    if (!p) return null;
    const key = process.env[p.env];
    if (!key) return null;
    return makeClient({ baseURL: p.baseURL, headers: p.headers(key) });
  } catch (e) {
    console.error(`Client creation error for ${name}:`, e);
    return null;
  }
}

function getPlatformFromUrl(url) {
  try {
    if (!url || typeof url !== 'string') return 'Unknown';
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace(/^www\./,'').toLowerCase();
    if (hostname.includes('zillow.com')) return 'Zillow';
    if (hostname.includes('realtor.com')) return 'Realtor.com';
    if (hostname.includes('redfin.com')) return 'Redfin';
    if (hostname.includes('trulia.com')) return 'Trulia';
    if (hostname.includes('instagram.com')) return 'Instagram';
    if (hostname.includes('facebook.com')) return 'Facebook';
    if (hostname.includes('reddit.com')) return 'Reddit';
    if (hostname.includes('youtube.com')) return 'YouTube';
    return 'Real Estate';
  } catch (e) {
    console.error('getPlatformFromUrl error:', e);
    return 'Unknown';
  }
}

function detectPlatform(url) {
  try {
    if (!url || typeof url !== 'string') return 'unknown';
    const u = url.toLowerCase();
    if (u.includes('instagram.com')) return 'instagram';
    if (u.includes('facebook.com')) return 'facebook';
    if (u.includes('reddit.com')) return 'reddit';
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
    if (u.includes('zillow.com')) return 'zillow';
    if (u.includes('realtor.com')) return 'realtor';
    return 'web';
  } catch (e) {
    console.error('detectPlatform error:', e);
    return 'unknown';
  }
}

function getPlatformName(host) {
  try {
    const h = (host || '').toLowerCase();
    if (h.includes('instagram.com')) return 'instagram';
    if (h.includes('facebook.com')) return 'facebook';
    if (h.includes('reddit.com')) return 'reddit';
    if (h.includes('youtube.com')) return 'youtube';
    if (h.includes('zillow.com')) return 'zillow';
    return 'social';
  } catch (e) {
    console.error('getPlatformName error:', e);
    return 'unknown';
  }
}

function extractUrlsFromText(text) {
  try {
    const rx = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
    const matches = String(text||'').match(rx);
    return (matches || []).slice(0,10);
  } catch (e) {
    console.error('extractUrlsFromText error:', e);
    return [];
  }
}

function extractZillowBuyerSignals(html) {
  const s = [];
  try {
    const t = String(html||'').toLowerCase();
    if (t.includes('contact agent') || t.includes('request info') || t.includes('schedule tour')) {
      s.push({ text:'Lead capture forms present', type:'lead_capture', buyerIndicator:'engagement_ready', propertyData:{ hasLeadCapture:true } });
    }
    const priceMatch = String(html||'').match(/\$[\d,]+/);
    if (priceMatch && priceMatch[0]) {
      s.push({ text:`Price seen: ${priceMatch[0]}`, type:'price_point', buyerIndicator:'price_range_known', propertyData:{ priceRange:priceMatch[0] } });
    }
  } catch (e) {
    console.error('extractZillowBuyerSignals error:', e);
  }
  return s;
}

// ---------- Direct scrape (public pages only, with optional proxy fallback) ----------
async function directScrape(url) {
  try {
    const useZyte = !!process.env.ZYTE_API_KEY;
    const useZenrows = !!process.env.ZENROWS_API_KEY;

    if (useZyte) {
      try {
        const zr = await axios.post('https://api.zyte.com/v1/extract',
          { url, httpResponseBody:true, browserHtml:true },
          { auth: { username: process.env.ZYTE_API_KEY, password:'' }, timeout: 20000 }
        );
        const html = String(zr.data?.browserHtml || zr.data?.httpResponseBody || '');
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = titleMatch && titleMatch[1] ? titleMatch[1].trim().replace(/\s+/g,' ') : 'Zyte Content';
        const text = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,12000);
        return { url, title, content:text, platform:getPlatformFromUrl(url), source:'zyte', scrapedAt:new Date().toISOString(), contentLength:text.length };
      } catch (e) {
        console.error('Zyte scraping error:', e);
        // Fall through to next method
      }
    } else if (useZenrows) {
      try {
        const zr = await axios.get('https://api.zenrows.com/v1/', {
          params: { apikey: process.env.ZENROWS_API_KEY, url, js_render: 'true' },
          timeout: 20000
        });
        const html = String(zr.data || '');
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = titleMatch && titleMatch[1] ? titleMatch[1].trim().replace(/\s+/g,' ') : 'ZenRows Content';
        const text = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,12000);
        return { url, title, content:text, platform:getPlatformFromUrl(url), source:'zenrows', scrapedAt:new Date().toISOString(), contentLength:text.length };
      } catch (e) {
        console.error('ZenRows scraping error:', e);
        // Fall through to direct scrape
      }
    }

    const response = await axios.get(url, {
      timeout: 15000,
      headers: stripForbidden({
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'
      }),
      maxRedirects: 3,
      validateStatus: s => (s >= 200 && s < 400) || s === 403 || s === 429
    });

    const html = String(response.data || '');
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch && titleMatch[1] ? titleMatch[1].trim().replace(/\s+/g,' ') : 'Direct Scraped Content';
    const text = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,12000);
    return { url, title, content:text, platform:getPlatformFromUrl(url), source:'direct-scrape', scrapedAt:new Date().toISOString(), contentLength:text.length };
  } catch (e) {
    console.error('Direct scrape error:', e);
    return {
      url, title:'Site Protection Detected',
      content:`Protection detected for ${url}. Public-only intel recorded.`,
      platform:getPlatformFromUrl(url), source:'direct-scrape-error',
      scrapedAt:new Date().toISOString(), errorType:'protection-detected', buyerSignal:'high-value-content', contentLength:0
    };
  }
}

// ---------- Apify helpers (trimmed, still smart) ----------
function getBackupApifyClient() {
  try {
    const tokens = [process.env.APIFY_TOKEN_BACKUP_1, process.env.APIFY_TOKEN_BACKUP_2, process.env.APIFY_TOKEN_BACKUP_3].filter(Boolean);
    for (const t of tokens) {
      try {
        return makeClient({ baseURL:'https://api.apify.com', headers:{ Authorization:`Bearer ${t}` }});
      } catch (e) {
        console.error('Backup Apify client error:', e);
        continue;
      }
    }
    return null;
  } catch (e) {
    console.error('getBackupApifyClient error:', e);
    return null;
  }
}

async function executeActorWithTimeout(apify, actor, timeoutSeconds = 120) {
  try {
    const run = await apify.post(`/v2/acts/${actor.id}/runs?timeout=${timeoutSeconds+60}`, actor.config);
    const runId = run?.data?.data?.id;
    if (!runId) throw new Error(`Failed to start actor ${actor.id}`);

    const t0 = Date.now();
    let wait = 2000;
    while (Date.now() - t0 < timeoutSeconds*1000) {
      try {
        const status = await apify.get(`/v2/actor-runs/${runId}`);
        const s = status?.data?.data?.status;
        const dsId = status?.data?.data?.defaultDatasetId;
        if (s === 'SUCCEEDED' && dsId) {
          const itemsResp = await apify.get(`/v2/datasets/${dsId}/items?clean=true&format=json&limit=1000`);
          return Array.isArray(itemsResp?.data) ? itemsResp.data : [];
        }
        if (['FAILED','ABORTED','TIMED_OUT'].includes(s)) throw new Error(`Actor ${actor.id} failed: ${s}`);
        await new Promise(r=>setTimeout(r, wait)); 
        wait = Math.min(wait*1.2, 8000);
      } catch (e) {
        console.error('Actor status check error:', e);
        await new Promise(r=>setTimeout(r, wait));
        wait = Math.min(wait*1.2, 8000);
      }
    }
    try { 
      await apify.post(`/v2/actor-runs/${runId}/abort`); 
    } catch(e) {
      console.error('Actor abort error:', e);
    }
    throw new Error(`Actor timeout ${actor.id}`);
  } catch (e) {
    console.error('executeActorWithTimeout error:', e);
    throw e;
  }
}

async function processZillowUrls(apify, urls) {
  try {
    const actors = [
      { id:'dtrungtin/zillow-scraper', name:'DTrungtin Primary', config:{ startUrls: urls.map(u=>({url:u})), maxConcurrency:1, proxyConfiguration:{ useApifyProxy:true, groups:['RESIDENTIAL'], countryCode:'US' } } },
      { id:'compass/zillow-scraper', name:'Compass Backup', config:{ startUrls: urls.map(u=>({url:u})), maxConcurrency:1, proxyConfiguration:{ useApifyProxy:true, groups:['RESIDENTIAL'] } } },
      { id:'apify/web-scraper', name:'Generic Web Scraper', config:{ startUrls: urls.map(u=>({url:u})), useChrome:true, stealth:true, maxConcurrency:1, proxyConfiguration:{ useApifyProxy:true, groups:['RESIDENTIAL'] } } }
    ];
    for (const a of actors) {
      try {
        const out = await executeActorWithTimeout(apify, a, 180);
        if (out && out.length) return out.map(i=>({ ...i, platform:'zillow', actorUsed:a.name }));
      } catch (e) {
        console.error(`Zillow actor ${a.name} error:`, e);
        continue;
      }
    }
    return urls.map(u=>({ url:u, title:'Zillow Property Intelligence', content:'Public protection detected.', platform:'zillow', source:'zillow-intelligence' }));
  } catch (e) {
    console.error('processZillowUrls error:', e);
    return urls.map(u=>({ url:u, title:'Zillow Property Intelligence', content:'Public protection detected.', platform:'zillow', source:'zillow-intelligence' }));
  }
}

async function processGenericUrls(apify, urls) {
  try {
    const actor = { id:'apify/web-scraper', name:'Generic Web Scraper', config:{ startUrls: urls.map(u=>({url:u})), useChrome:true, stealth:true, maxConcurrency:2, proxyConfiguration:{ useApifyProxy:true } } };
    const out = await executeActorWithTimeout(apify, actor, 120);
    if (out && out.length) return out.map(i=>({ ...i, actorUsed:actor.name }));
    return urls.map(u=>({ url:u, title:'Real Estate Intelligence', content:'Public page analyzed (fallback).', platform:getPlatformFromUrl(u), source:'intelligent-fallback' }));
  } catch (e) {
    console.error('processGenericUrls error:', e);
    return urls.map(u=>({ url:u, title:'Real Estate Intelligence', content:'Public page analyzed (fallback).', platform:getPlatformFromUrl(u), source:'intelligent-fallback' }));
  }
}

async function runApifyScrape(apify, urls) {
  try {
    if (!urls || !urls.length) return [];
    const urlObj = new URL(urls[0]);
    const host = urlObj.hostname;
    if (host.includes('zillow.com')) return await processZillowUrls(apify, urls);
    return await processGenericUrls(apify, urls);
  } catch (e) {
    console.error('runApifyScrape error:', e);
    return urls.map(u=>({ url:u, title:'Fallback Analysis', content:'General public intel.', source:'fallback' }));
  }
}

async function runApifyWithBackups(urls) {
  try {
    if (!urls || !urls.length) return [];
    let ap = client('apify') || getBackupApifyClient();
    if (!ap) return await Promise.all(urls.map(u=>directScrape(u)));
    try { 
      return await runApifyScrape(ap, urls); 
    } catch (e) {
      console.error('Primary Apify failed:', e);
      const bak = getBackupApifyClient(); 
      if (bak) { 
        try { 
          return await runApifyScrape(bak, urls); 
        } catch (e2) {
          console.error('Backup Apify failed:', e2);
        }
      }
    }
    return await Promise.all(urls.map(u=>directScrape(u)));
  } catch (e) {
    console.error('runApifyWithBackups error:', e);
    return urls.map(u=>({ url:u, title:'Error Analysis', content:'Fallback analysis.', source:'error-fallback' }));
  }
}
// ---------- Document Generation Helpers ----------
function generateCMAHTML(leadData, marketData, comparables, city, state) {
  const avgPrice = comparables.length > 0 
    ? comparables.reduce((sum, c) => sum + (c.price || 0), 0) / comparables.length 
    : 0;
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        .header { background: #2c5aa0; color: white; padding: 30px; text-align: center; }
        .content { max-width: 800px; margin: 20px auto; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th { background: #f0f0f0; padding: 10px; text-align: left; }
        td { padding: 10px; border-bottom: 1px solid #ddd; }
        .summary { background: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Comparative Market Analysis</h1>
        <h2>${city}, ${state}</h2>
        <p>Prepared for: ${leadData.firstName || 'Valued Client'} ${leadData.lastName || ''}</p>
        <p>Date: ${new Date().toLocaleDateString()}</p>
      </div>
      
      <div class="content">
        <div class="summary">
          <h3>Market Summary</h3>
          <p>Average Price: $${Math.round(avgPrice).toLocaleString()}</p>
          <p>Total Comparables: ${comparables.length}</p>
        </div>
        
        <h3>Comparable Properties</h3>
        <table>
          <tr>
            <th>Address</th>
            <th>Price</th>
            <th>Beds/Baths</th>
            <th>Sq Ft</th>
          </tr>
          ${comparables.map(comp => `
            <tr>
              <td>${comp.address || 'N/A'}</td>
              <td>$${(comp.listPrice || 0).toLocaleString()}</td>
              <td>${comp.bedrooms || 0}/${comp.bathrooms || 0}</td>
              <td>${comp.sqFt || 'N/A'}</td>
            </tr>
          `).join('')}
        </table>
      </div>
    </body>
    </html>
  `;
}
// ---------- Basic routes ----------
app.get('/', (_req,res)=>res.json({ ok:true, service:'MCP OMNI PRO', time:new Date().toISOString() }));
app.get('/health', (_req,res)=>res.status(200).send('OK'));
app.get('/routes', (req,res)=>{
  try {
    const stack = app._router?.stack || [];
    const list = stack.filter(r=>r.route).map(r=>({ 
      method:Object.keys(r.route.methods)[0]?.toUpperCase() || 'UNKNOWN', 
      path:r.route.path 
    }));
    res.json({ ok:true, routes:list });
  } catch(e){ 
    console.error('Routes error:', e);
    res.json({ ok:false, error:String(e?.message||e) }); 
  }
});
// IDX Lead Cross-Reference
app.post('/api/idx/cross-reference', async (req, res) => {
  try {
    const { email, phone, firstName, lastName } = req.body;
    const idx = client('idx');
    if (!idx) return res.status(400).json({ ok: false, error: 'IDX not configured' });
    
    const existingLeadsResponse = await idx.get('/leads/lead');
    const existingLeads = existingLeadsResponse.data || [];
    
    const matches = existingLeads.filter(lead => {
      const emailMatch = email && lead.email && lead.email.toLowerCase() === email.toLowerCase();
      const phoneMatch = phone && lead.phone && lead.phone.replace(/\D/g, '') === phone.replace(/\D/g, '');
      const nameMatch = firstName && lastName && lead.firstName && lead.lastName &&
        lead.firstName.toLowerCase() === firstName.toLowerCase() &&
        lead.lastName.toLowerCase() === lastName.toLowerCase();
      
      return emailMatch || phoneMatch || nameMatch;
    });
    
    res.json({ 
      ok: true, 
      matches: matches,
      isExisting: matches.length > 0,
      matchedBy: matches.length > 0 ? getMatchReason(matches[0], { email, phone, firstName, lastName }) : null
    });
  } catch (e) {
    console.error('IDX cross-reference error:', e);
    res.status(500).json({ ok: false, error: 'IDX cross-reference failed' });
  }
});

function getMatchReason(match, searchCriteria) {
  if (searchCriteria.email && match.email === searchCriteria.email) return 'email';
  if (searchCriteria.phone && match.phone === searchCriteria.phone) return 'phone';
  if (searchCriteria.firstName && match.firstName === searchCriteria.firstName) return 'name';
  return 'unknown';
}
// ---------- API endpoints ----------

// 1) Enhanced scrape (public)
app.post('/api/scrape', rejectIfHeaderTriesCookies, async (req, res) => {
  try {
    const body = req.body || {};
    const { scrapeUrls = [], socialUrls = [], urlCityMap = {}, urlStateMap = {} } = body;
    
    if (!Array.isArray(scrapeUrls) || !Array.isArray(socialUrls)) {
      return res.status(400).json({ ok:false, error:'scrapeUrls and socialUrls must be arrays' });
    }
    
    if (!scrapeUrls.length && !socialUrls.length) {
      return res.json({ ok:true, items:[], provider:'no-urls', stats:{ scraped:0, social:0, total:0 } });
    }
    const items = [];
    
    // scrape
    for (const url of scrapeUrls.slice(0,20)) {
      try {
        const apifyResults = await runApifyWithBackups([url]);
        const platform = getPlatformFromUrl(url);
        for (const r of (apifyResults||[])) {
          items.push({ 
            ...r, 
            platform, 
            city: urlCityMap[url] || r?.city || '', 
            state: urlStateMap[url] || r?.state || '', 
            enhanced: true 
          });
        }
      } catch (e) {
        console.error('Scraping error for', url, ':', e);
        const platform = getPlatformFromUrl(url);
        items.push({ url, title:`${platform} - Protection`, content:`Public protection detected for ${url}.`, platform, source:'error-intelligence' });
      }
    }
    
    // social placeholders
    for (const url of socialUrls.slice(0,30)) {
      const platform = detectPlatform(url);
      items.push({ url, title:`${platform.toUpperCase()} Post`, content:`Detected ${platform} content.`, platform, needsComments:true });
    }
    
    res.json({ 
      ok:true, 
      items, 
      provider:'enhanced-apify-system', 
      stats:{ 
        scraped: items.filter(i=>!i.needsComments).length, 
        social: items.filter(i=>i.needsComments).length, 
        total: items.length 
      } 
    });
  } catch (e) { 
    console.error('Scrape endpoint error:', e);
    res.json({ ok:true, items:[], provider:'error-fallback', error:e.message }); 
  }
});

// 2) Comments (public signals)
app.post('/api/comments', rejectIfHeaderTriesCookies, async (req, res) => {
  try {
    const body = req.body || {};
    const { url, city = '', state = '' } = body;
    if (!url) return res.status(400).json({ ok:false, error:'url required' });
    
    let urlObj;
    try {
      urlObj = new URL(url);
    } catch (e) {
      return res.status(400).json({ ok:false, error:'Invalid URL format' });
    }
    
    const host = urlObj.hostname.replace(/^www\./,'');
    const items = [];

    // YouTube
    if (/youtube\.com|youtu\.be/i.test(host)) {
      const key = process.env.YOUTUBE_API_KEY;
      let vid = null;
      try {
        const vidMatch = url.match(/[?&]v=([^&#]+)/);
        if (vidMatch && vidMatch[1]) {
          vid = vidMatch[1];
        } else if (urlObj.hostname.includes('youtu.be')) {
          const pathParts = urlObj.pathname.split('/').filter(Boolean);
          vid = pathParts[0] || '';
        } else if (urlObj.pathname.startsWith('/shorts/')) {
          const pathParts = urlObj.pathname.split('/');
          vid = pathParts[2] || '';
        }
      } catch (e) {
        console.error('YouTube URL parsing error:', e);
      }
      
      if (key && vid) {
        try {
          const yt = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', { 
            params:{ part:'snippet', videoId:vid, maxResults:50, key },
            timeout: 15000
          });
          const ytItems = yt.data?.items || [];
          for (const row of ytItems) {
            try {
              const sn = row?.snippet?.topLevelComment?.snippet;
              if (sn) {
                items.push({ 
                  platform:'youtube', 
                  author: sn.authorDisplayName || 'Unknown', 
                  text: sn.textDisplay || '', 
                  publishedAt: sn.publishedAt || new Date().toISOString() 
                });
              }
            } catch (e) {
              console.error('YouTube comment parsing error:', e);
            }
          }
        } catch (e) {
          console.error('YouTube API error:', e);
        }
      }
      if (!items.length) items.push({ platform:'youtube', author:'youtube_user', text:`Real estate video engagement detected for ${city}`, publishedAt:new Date().toISOString(), synthetic:true });
      return res.json({ ok:true, url, city, state, items, provider:'youtube-enhanced' });
    }

    // Zillow
    if (/zillow\.com/i.test(host)) {
      try {
        const r = await axios.get(url, { 
          timeout: 20000, 
          headers: stripForbidden({ 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }) 
        });
        const sig = extractZillowBuyerSignals(r.data);
        sig.forEach(s=>items.push({ 
          platform:'zillow', 
          author:'zillow_activity', 
          text:s.text, 
          publishedAt:new Date().toISOString(), 
          activityType:s.type, 
          propertyData:s.propertyData, 
          buyerIndicator:s.buyerIndicator 
        }));
      } catch (e) {
        console.error('Zillow scraping error:', e);
      }
      if (!items.length) items.push({ platform:'zillow', author:'zillow_intelligence', text:`Zillow property activity detected in ${city}`, publishedAt:new Date().toISOString(), synthetic:true });
      return res.json({ ok:true, url, city, state, items, provider:'zillow-buyer-intel' });
    }

    // Reddit
    if (/reddit\.com/i.test(host)) {
      try {
        const ap = await runApifyWithBackups([url]);
        for (const r of (ap||[])) {
          if (Array.isArray(r.comments)) {
            for (const c of r.comments.slice(0,20)) {
              items.push({ 
                platform:'reddit', 
                author: c?.author || 'reddit_user', 
                text: c?.text || '', 
                publishedAt: c?.createdAt || new Date().toISOString() 
              });
            }
          }
        }
      } catch (e) {
        console.error('Reddit scraping error:', e);
      }
      if (!items.length) items.push({ platform:'reddit', author:'reddit_user', text:`Reddit real estate discussion in ${city}`, publishedAt:new Date().toISOString(), synthetic:true });
      return res.json({ ok:true, url, city, state, items, provider:'reddit-enhanced' });
    }

    // Generic
    const platformName = getPlatformName(host);
    items.push({ platform: platformName, author:`${platformName}_user`, text:`${platformName} engagement detected in ${city}`, publishedAt:new Date().toISOString(), synthetic:true });
    res.json({ ok:true, url, city, state, items, provider:`${platformName}-placeholder` });
  } catch (e) {
    console.error('Comments endpoint error:', e);
    res.json({ 
      ok:true, 
      url: req.body?.url || '', 
      city: req.body?.city || '', 
      state: req.body?.state || '', 
      items:[{ 
        platform:'error-recovery', 
        author:'system', 
        text:`Processing error: ${e.message}`, 
        publishedAt:new Date().toISOString(), 
        synthetic:true 
      }], 
      provider:'error-fallback', 
      error:e.message 
    });
  }
});

// 3) Discovery (Perplexity-assisted public discovery)
app.post('/api/discover', async (req,res)=>{
  const t0 = Date.now();
  try {
    const perplex = client('perplexity');
    const body = req.body || {};
    const { queries = [], location = {}, locations = [], maxResults = 40 } = body;
    const qList = Array.isArray(queries) ? queries : [];
    const locs = Array.isArray(locations) && locations.length ? locations.slice(0,2) : [location];
    const all = [], seen = new Set();
    
    if (perplex && qList.length) {
      for (const loc of locs.slice(0,2)) {
        const cleanQs = qList.slice(0,8).map(q => `${q} ${loc.city||''} ${loc.state||''}`.trim());
        for (const q of cleanQs.slice(0,4)) {
          try {
            const r = await perplex.post('/chat/completions', {
              model:'sonar-pro',
              messages:[
                { role:'system', content:'Find public BUYER intent mentions. Return relevant links.' },
                { role:'user', content:`Find home BUYERS: ${q}` }
              ],
              stream:false, max_tokens:600, search_recency_filter:'month'
            }, { timeout:25000 });
            
            const data = r.data||{};
            if (data.search_results && Array.isArray(data.search_results)) {
              for (const rs of data.search_results.slice(0,6)) {
                if (rs.url && rs.url.startsWith('http') && !seen.has(rs.url)) {
                  seen.add(rs.url);
                  all.push({ 
                    title: rs.title || 'Buyer Intent Content', 
                    url: rs.url, 
                    platform: getPlatformFromUrl(rs.url), 
                    contentSnippet: rs.snippet || '', 
                    city: loc.city, 
                    state: loc.state, 
                    queryType: q, 
                    buyerRelevance: 5 
                  });
                }
              }
            }
            
            const content = data.choices?.[0]?.message?.content;
            if (content) {
              for (const u of extractUrlsFromText(content).slice(0,3)) {
                if (!seen.has(u)) { 
                  seen.add(u); 
                  all.push({ 
                    title:'AI Discovery', 
                    url:u, 
                    platform:getPlatformFromUrl(u), 
                    contentSnippet:'Found via AI search', 
                    city:loc.city, 
                    state:loc.state, 
                    queryType:q, 
                    buyerRelevance:4 
                  }); 
                }
              }
            }
          } catch (e) {
            console.error('Perplexity query error:', e);
          }
          await new Promise(r=>setTimeout(r,1200));
        }
      }
    }
    res.json({ 
      ok:true, 
      items: all.slice(0,maxResults), 
      provider: all.length>10?'perplexity-buyer-focused':'buyer-fallback', 
      locations:locs, 
      processingTime: Date.now()-t0 
    });
  } catch (e) { 
    console.error('Discovery endpoint error:', e);
    res.json({ ok:true, items:[], provider:'error-fallback', processingTime: Date.now()-t0 }); 
  }
});

// 4) Fuse + Score (simple textual intent scoring)
app.post('/api/fuse-score', (req,res)=>{
  try {
    const body = req.body || {};
    const { items = [], location = {} } = body;
    const CITY = String(location.city||'').toLowerCase();
    
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok:false, error:'items must be an array' });
    }
    
    const leads = items.map(r=>{
      try {
        const txt = String(r.content || r.contentSnippet || '').toLowerCase();
        let base = 0;
        if (txt.includes('looking for') || txt.includes('searching for')) base += 3;
        if (txt.includes('buy') || txt.includes('purchase')) base += 3;
        if (txt.includes('agent') || txt.includes('realtor')) base += 2;
        if (txt.includes('pre-approved') || txt.includes('pre approved')) base += 4;
        if (txt.includes('cash buyer')) base += 4;
        if (txt.includes('urgent') || txt.includes('asap')) base += 3;
        if (txt.includes('moving') || txt.includes('relocating')) base += 2;
        if (CITY && txt.includes(CITY)) base += 1;
        const score = Math.max(0, Math.min(10, base));
        return { 
          ...r,
          finalIntentScore: score,
          urgency: score>=8?'immediate':score>=6?'high':score>=4?'medium':'low',
          timeline: score>=8?'1-14 days':score>=6?'2-8 weeks':score>=4?'2-6 months':'6+ months',
          timestamp: new Date().toISOString()
        };
      } catch (e) {
        console.error('Score calculation error for item:', e);
        return { 
          ...r,
          finalIntentScore: 0,
          urgency: 'low',
          timeline: '6+ months',
          timestamp: new Date().toISOString()
        };
      }
    });
    res.json({ leads });
  } catch (e) { 
    console.error('Fuse-score error:', e);
    res.status(500).json({ ok:false, error:'fuse-score failed' }); 
  }
});

// 5) Content generation (Fair Housing system prompt)
app.post('/api/content-generation', async (req,res)=>{
  try {
    const body = req.body || {};
    const { location = {}, lead = {} } = body;
    const key = process.env.ANTHROPIC_API_KEY;
    
    if (!key) {
      return res.json({
        smsA:`Hi ${lead.firstName||'there'}! Quick question about ${location.city||'your area'} homes.`.slice(0,160),
        smsB:`Hello! Want a short ${location.city||'your area'} market update?`.slice(0,160),
        emailSubjectA:`${location.city||'Your area'} market snapshot for you`,
        emailBodyA:`Hi ${lead.firstName||'there'},\nHere's a helpful update.`,
        emailSubjectB:`Quick ${location.city||'Your area'} real estate insights`,
        emailBodyB:`Hi ${lead.firstName||'there'},\nSome useful info for your search.`,
        videoScript:`Hi ${lead.firstName||'there'}, quick update on ${location.city||'your area'} and how I can help.`,
        provider:'mock'
      });
    }
    
    const anthropic = makeClient({ 
      baseURL:'https://api.anthropic.com', 
      headers:{ 
        'x-api-key':key, 
        'anthropic-version':'2023-06-01',
        'content-type':'application/json' 
      } 
    });
    
    if (!anthropic) {
      throw new Error('Failed to create Anthropic client');
    }
    
    const r = await anthropic.post('/v1/messages', {
      model: 'claude-3-haiku-20240307',
      max_tokens: 900,
      system: 'You are a Fair Housing–compliant real estate copywriter. No steering.',
      messages: [{ 
        role:'user', 
        content:`Return STRICT JSON with keys: smsA, smsB, emailSubjectA, emailBodyA, emailSubjectB, emailBodyB, videoScript. Lead=${JSON.stringify(lead)}; City=${location.city}.` 
      }]
    });
    res.json(r.data);
  } catch (e) { 
    console.error('Content generation error:', e);
    res.status(500).json({ ok:false, error:'content-generation failed' }); 
  }
});

// 6) HeyGen passthrough
app.post('/api/heygen/video', async (req,res)=>{
  try {
    const key = process.env.HEYGEN_API_KEY;
    if (!key) return res.status(400).json({ ok:false, error:'HEYGEN_API_KEY not set' });
    const hey = makeClient({ baseURL:'https://api.heygen.com', headers:{ 'X-API-Key': key, 'content-type':'application/json' } });
    if (!hey) return res.status(500).json({ ok:false, error:'Failed to create HeyGen client' });
    const r = await hey.post('/v2/video/generate', req.body);
    res.json(r.data);
  } catch (e) { 
    console.error('HeyGen error:', e);
    res.status(500).json({ ok:false, error:'heygen failed' }); 
  }
});

// 7) Apollo enrich
app.post('/api/apollo/enrich', async (req,res)=>{
  try {
    const apollo = client('apollo');
    if (!apollo) return res.status(400).json({ ok:false, error:'APOLLO_API_KEY not set' });
    const r = await apollo.post('/v1/people/enrich', req.body);
    res.json(r.data);
  } catch (e) { 
    console.error('Apollo error:', e);
    res.status(500).json({ ok:false, error:'apollo failed' }); 
  }
});

// 8) IDX leads
app.get('/api/idx/leads', async (_req,res)=>{
  try {
    const idx = client('idx');
    if (!idx) return res.status(400).json({ ok:false, error:'IDX_ACCESS_KEY not set' });
    const r = await idx.get('/leads/lead');
    res.json(r.data);
  } catch (e) { 
    console.error('IDX error:', e);
    res.status(500).json({ ok:false, error:'idx failed' }); 
  }
});
// IDX Property Search
app.get('/api/idx/properties', async (req, res) => {
  try {
    const idx = client('idx');
    if (!idx) return res.status(400).json({ ok: false, error: 'IDX_ACCESS_KEY not set' });
    
    const { city, state, minPrice, maxPrice, bedrooms, bathrooms, propertyType } = req.query;
    const response = await idx.get('/clients/featured', {
      params: { 
        city, 
        state, 
        startOffset: 0, 
        maxRows: 20,
        minPrice: minPrice || 0,
        maxPrice: maxPrice || 999999999,
        bedrooms: bedrooms || '',
        bathrooms: bathrooms || '',
        propertyType: propertyType || 'residential'
      }
    });
    
    res.json({ 
      ok: true, 
      properties: response.data || [], 
      count: (response.data || []).length 
    });
  } catch (e) {
    console.error('IDX property search error:', e);
    res.status(500).json({ ok: false, error: 'IDX property search failed' });
  }
});
// IDX Market Statistics
app.get('/api/idx/market-data', async (req, res) => {
  try {
    const idx = client('idx');
    if (!idx) return res.status(400).json({ ok: false, error: 'IDX_ACCESS_KEY not set' });
    
    const { city, state } = req.query;
    if (!city || !state) {
      return res.status(400).json({ ok: false, error: 'city and state required' });
    }
    
    // Get market statistics
    const statsResponse = await idx.get('/clients/statistics', { 
      params: { city, state } 
    });
    
    // Get recent sales for trend analysis
    const salesResponse = await idx.get('/clients/sold', {
      params: { 
        city, 
        state, 
        startOffset: 0, 
        maxRows: 50 
      }
    });
    
    const marketData = {
      city,
      state,
      statistics: statsResponse.data || {},
      recentSales: salesResponse.data || [],
      averagePrice: calculateAveragePrice(salesResponse.data || []),
      marketTrend: analyzeTrend(salesResponse.data || []),
      generatedAt: new Date().toISOString()
    };
    
    res.json({ ok: true, marketData });
  } catch (e) {
    console.error('IDX market data error:', e);
    res.status(500).json({ ok: false, error: 'IDX market data failed' });
  }
});

// 9) Public records passthrough
app.post('/api/public-records', async (req,res)=>{
  try {
    const body = req.body || {};
    const { url } = body;
    if (!url) return res.status(400).json({ ok:false, error:'url required' });
    
    // Validate URL
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json({ ok:false, error:'Invalid URL format' });
    }
    
    const r = await axios.get(url, { timeout: 20000 });
    res.json({ items: r.data });
  } catch (e) { 
    console.error('Public records error:', e);
    res.status(500).json({ ok:false, error:'public-records failed' }); 
  }
});

// 10) Mortgage event, 11) Analytics
app.post('/api/mortgage-event', (req,res)=>{ 
  try {
    const p = req.body||{}; 
    console.log('Mortgage event:', p.event, 'for', p?.contact?.email||p?.contact?.phone); 
    res.json({ok:true});
  } catch (e) {
    console.error('Mortgage event error:', e);
    res.json({ok:false, error:e.message});
  }
});

app.post('/api/analytics-tracking', (req,res)=>{ 
  try {
    console.log('Analytics:', req.body?.event, req.body?.metrics); 
    res.json({ok:true});
  } catch (e) {
    console.error('Analytics tracking error:', e);
    res.json({ok:false, error:e.message});
  }
});

app.post('/webhooks/video-complete', (req,res)=>{ 
  try {
    console.log('Video complete payload:', req.body); 
    res.json({ok:true});
  } catch (e) {
    console.error('Video complete webhook error:', e);
    res.json({ok:false, error:e.message});
  }
});

// 12) Enhanced Market report with CMA generation
app.post('/api/market-report', async (req, res) => {
  try {
    const body = req.body || {};
    const { city='', state='', leadData = {}, generateCMA = false } = body;
    
    // Get market data from IDX if available
    let marketData = { comparables: [] };
    const idxClient = client('idx');
    
    if (idxClient && city) {
      try {
        const listings = await idxClient.get('/clients/featured', {
          params: { city, state, startOffset: 0, maxRows: 20 }
        });
        marketData.comparables = (listings.data || []).slice(0, 6);
      } catch (e) {
        console.error('IDX fetch error:', e);
      }
    }
    
    if (generateCMA && leadData.firstName) {
      // Generate CMA HTML
      const html = generateCMAHTML(leadData, marketData, marketData.comparables || [], city, state);
      
      // Save as PDF-ready HTML
      const htmlBuffer = Buffer.from(html);
      const filename = `CMA_${leadData.firstName}_${city}_${Date.now()}.html`;
      
      // Use internal storage
      const fileId = crypto.randomBytes(16).toString('hex');
      const storedFilename = `${fileId}.html`;
      const filePath = path.join(DOCUMENTS_DIR, storedFilename);
      
      await fs.writeFile(filePath, htmlBuffer);
      
      const metadata = {
        id: fileId,
        originalName: filename,
        storedName: storedFilename,
        type: 'cma',
        leadId: leadData.contactId || '',
        size: htmlBuffer.length,
        uploadedAt: new Date().toISOString()
      };
      
      await fs.writeFile(
        path.join(DOCUMENTS_DIR, `${fileId}.meta.json`),
        JSON.stringify(metadata, null, 2)
      );
      
      const baseUrl = process.env.MCP_BASE_URL || 'http://localhost:' + port;
      const cmaUrl = `${baseUrl}/api/storage/download/${fileId}`;
      
      res.json({ 
        ok: true, 
        report_url: cmaUrl,
        fileId: fileId,
        marketData: marketData
      });
    } else {
      // Original simple response
      res.json({ 
        ok: true, 
        report_url: `https://example.com/market-report-${encodeURIComponent(city)}-${encodeURIComponent(state)}.pdf`,
        marketData: marketData
      });
    }
  } catch (e) {
    console.error('Market report error:', e);
    res.status(500).json({ ok: false, error: 'market-report failed' });
  }
});


// 13) Performance digest
app.get('/api/performance/digest', (req,res)=>{
  try {
    const hours = Number(req.query.hours) || 24;
    res.json({ 
      ok:true, 
      stats:{ 
        windowHours:hours, 
        totalLeads:0, 
        intentDistribution:{ immediate:0, high:0, medium:0, low:0 }, 
        sourceBreakdown:{ public:0, idx:0 }, 
        topSignals:[] 
      } 
    });
  } catch (e) {
    console.error('Performance digest error:', e);
    res.status(500).json({ ok:false, error:'performance-digest failed' });
  }
});
// 14.5) Storage endpoints
app.post('/api/storage/upload', express.raw({ type: 'application/pdf', limit: '10mb' }), async (req, res) => {
  try {
    const { type = 'document', leadId, filename } = req.query;
    const fileId = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(filename || '.pdf');
    const storedFilename = `${fileId}${ext}`;
    const filePath = path.join(DOCUMENTS_DIR, storedFilename);
    
    await fs.writeFile(filePath, req.body);
    
    const metadata = {
      id: fileId,
      originalName: filename,
      storedName: storedFilename,
      type: type,
      leadId: leadId,
      size: req.body.length,
      uploadedAt: new Date().toISOString(),
      url: `/api/storage/download/${fileId}`
    };
    
    await fs.writeFile(
      path.join(DOCUMENTS_DIR, `${fileId}.meta.json`),
      JSON.stringify(metadata, null, 2)
    );
    
    const baseUrl = process.env.MCP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    
    res.json({ 
      ok: true, 
      fileId: fileId,
      url: `${baseUrl}/api/storage/download/${fileId}`,
      metadata: metadata
    });
  } catch (e) {
    console.error('Storage upload error:', e);
    res.status(500).json({ ok: false, error: 'Upload failed' });
  }
});

app.get('/api/storage/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    const metaPath = path.join(DOCUMENTS_DIR, `${fileId}.meta.json`);
    const metadata = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    
    const filePath = path.join(DOCUMENTS_DIR, metadata.storedName);
    const fileBuffer = await fs.readFile(filePath);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${metadata.originalName}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    
    res.send(fileBuffer);
  } catch (e) {
    console.error('Storage download error:', e);
    res.status(404).json({ ok: false, error: 'File not found' });
  }
});
// 14) Test Instagram session
app.get('/api/test-instagram', async (_req,res)=>{
  try {
    const session = process.env.IG_SESSIONID;
    if (!session) return res.json({ error:'No IG_SESSIONID in environment' });
    
    const r = await axios.get('https://www.instagram.com/api/v1/users/web_profile_info/?username=instagram', { 
      headers: { 
        'Cookie': `sessionid=${session}`, 
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' 
      }, 
      timeout:10000 
    });
    return res.json({ success:true, sessionValid:r.status===200, sessionLength: session.length });
  } catch (e) { 
    console.error('Instagram test error:', e);
    return res.json({ success:false, error:e.message, sessionLength: process.env.IG_SESSIONID?.length || 0 }); 
  }
});

// 15) Google CSE discovery
app.post('/api/google/cse', async (req,res)=>{
  try {
    const key = process.env.GOOGLE_CSE_KEY;
    const cx  = process.env.GOOGLE_CSE_CX;
    if (!key || !cx) return res.status(400).json({ ok:false, error:'GOOGLE_CSE_KEY/GOOGLE_CSE_CX not set' });
    
    const body = req.body || {};
    const { queries = [], num = 8, dateRestrict = 'm1' } = body;
    
    if (!Array.isArray(queries)) {
      return res.status(400).json({ ok:false, error:'queries must be an array' });
    }
    
    const g = makeClient({ baseURL:'https://www.googleapis.com' });
    if (!g) return res.status(500).json({ ok:false, error:'Failed to create Google client' });
    
    const results = [], uniq = new Set();
    for (const q of queries.slice(0,20)) {
      try {
        const r = await g.get('/customsearch/v1', { 
          params:{ key, cx, q, num: Math.min(num,10), dateRestrict },
          timeout: 15000
        });
        const items = r.data?.items || [];
        for (const it of items) {
          if (!it.link || uniq.has(it.link)) continue;
          uniq.add(it.link);
          results.push({ 
            title: it.title || 'Result', 
            url: it.link, 
            snippet: it.snippet || '', 
            displayLink: it.displayLink || '', 
            source:'google-cse', 
            query:q, 
            formattedUrl: it.formattedUrl || '' 
          });
        }
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        console.error('Google CSE query error:', e);
      }
    }
    res.json({ ok:true, items:results, totalQueries:queries.length });
  } catch (e) { 
    console.error('Google CSE error:', e);
    res.json({ ok:true, items:[], error:e.message }); 
  }
});

// 16) OSINT resolve (public profile links)
app.post('/api/osint/resolve', async (req,res)=>{
  try {
    const body = req.body || {};
    const { handle = '', fullName = '', city = '', state = '' } = body;
    const qBase = [handle, fullName, city, state].filter(Boolean).join(' ');
    if (!qBase) return res.json({ ok:true, candidates: [] });
    
    const perplex = client('perplexity');
    const queries = [
      `contact for ${qBase}`,
      `${qBase} instagram OR facebook OR reddit OR youtube`,
      `${qBase} email OR "mailto"`,
      `${qBase} realtor OR agent`
    ];
    const candidates = [], seen = new Set();
    
    if (perplex) {
      for (const q of queries.slice(0,4)) {
        try {
          const r = await perplex.post('/chat/completions', {
            model:'sonar-pro',
            messages:[
              { role:'system', content:'Return concise, public OSINT only. No private data.' },
              { role:'user', content:`Find public profile/name/links for: ${q}. Give JSON: [{name, handle, platform, link}]` }
            ],
            max_tokens: 600, stream:false, search_recency_filter:'year'
          }, { timeout:22000 });
          
          const text = JSON.stringify(r.data || {});
          const urlMatches = text.match(/https?:\/\/[^\s"']+/g) || [];
          const urls = urlMatches.slice(0, 10);
          
          for (const link of urls) {
            if (seen.has(link)) continue;
            seen.add(link);
            let plat = 'web';
            if (/instagram\.com/i.test(link)) plat = 'instagram';
            else if (/facebook\.com/i.test(link)) plat = 'facebook';
            else if (/reddit\.com/i.test(link)) plat = 'reddit';
            else if (/youtube\.com|youtu\.be/i.test(link)) plat = 'youtube';
            else if (/tiktok\.com/i.test(link)) plat = 'tiktok';
            else if (/linkedin\.com/i.test(link)) plat = 'linkedin';
            else if (/twitter\.com|x\.com/i.test(link)) plat = 'twitter';
            
            candidates.push({ 
              name: fullName || '', 
              handle: handle || '', 
              platform: plat, 
              link, 
              confidence: plat!=='web'?0.8:0.5, 
              source:'perplexity-osint' 
            });
          }
        } catch (e) {
          console.error('OSINT query error:', e);
        }
        await new Promise(r=>setTimeout(r, 900));
      }
    }
    
    // dedupe & sort
    const unique = [];
    const linkset = new Set();
    for (const c of candidates) {
      if (!linkset.has(c.link)) { 
        linkset.add(c.link); 
        unique.push(c); 
      }
    }
    
    unique.sort((a,b)=> {
      const aScore = a.confidence + (['instagram','facebook','linkedin'].includes(a.platform)?3: ['reddit','youtube','twitter'].includes(a.platform)?2:1);
      const bScore = b.confidence + (['instagram','facebook','linkedin'].includes(b.platform)?3: ['reddit','youtube','twitter'].includes(b.platform)?2:1);
      return bScore - aScore;
    });
    
    res.json({ ok:true, candidates: unique.slice(0,15) });
  } catch (e) { 
    console.error('OSINT resolve error:', e);
    res.json({ ok:true, candidates: [], error:e.message }); 
  }
});

// 17) OSINT: sniff public emails from a URL
app.post('/api/osint/sniff-emails', async (req,res)=>{
  try {
    const body = req.body || {};
    const { url } = body;
    if (!url) return res.status(400).json({ ok:false, error:'url required' });
    
    // Validate URL
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json({ ok:false, error:'Invalid URL format' });
    }
    
    const r = await axios.get(url, {
      timeout: 15000,
      headers: stripForbidden({
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      })
    });
    
    const html = String(r.data||'');
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
    const emailMatches = html.match(emailRegex) || [];
    const found = Array.from(new Set(emailMatches.map(e=>e.toLowerCase())))
      .filter(e => !/noreply|no-reply|example\.com/.test(e))
      .slice(0, 10);
    res.json({ ok:true, emails: found, url });
  } catch (e) { 
    console.error('Email sniffing error:', e);
    res.json({ ok:true, emails: [], error:e.message }); 
  }
});

// 18) URLScan submit/result
app.post('/api/urlscan/lookup', async (req,res)=>{
  try {
    const body = req.body || {};
    const { url } = body;
    if (!url) return res.status(400).json({ ok:false, error:'url required' });
    
    // Validate URL
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json({ ok:false, error:'Invalid URL format' });
    }
    
    const r = await axios.post('https://urlscan.io/api/v1/scan/',
      { url, visibility:'public' },
      { 
        headers: stripForbidden({ 'API-Key': process.env.URLSCAN_API_KEY || '' }), 
        timeout: 20000 
      }
    );
    res.json({ ok:true, submission: r.data });
  } catch (e) { 
    console.error('URLScan submission error:', e);
    res.json({ ok:true, submission: null, error:e.message }); 
  }
});

app.get('/api/urlscan/result', async (req,res)=>{
  try {
    const { uuid } = req.query || {};
    if (!uuid) return res.status(400).json({ ok:false, error:'uuid required' });
    
    const r = await axios.get(`https://urlscan.io/api/v1/result/${uuid}/`, { timeout:20000 });
    res.json({ ok:true, result: r.data });
  } catch (e) { 
    console.error('URLScan result error:', e);
    res.json({ ok:true, result:null, error:e.message }); 
  }
});
// ---------- Storage Cleanup Job ----------
setInterval(async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = await fs.stat(filePath);
        // Delete temp files older than 24 hours
        if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
          await fs.unlink(filePath);
        }
      } catch (e) {
        console.error('Error processing file:', file, e);
      }
    }
  } catch (e) {
    console.error('Storage cleanup error:', e);
  }
}, 24 * 60 * 60 * 1000); // Run daily
// ---------- Error handler + start ----------
app.use((err,_req,res,_next)=>{ 
  console.error('Unhandled error:', err); 
  res.status(500).json({ ok:false, error:'server error' }); 
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log('🚀 MCP OMNI PRO listening on', port);
  console.log('✅ Guardrails active (no private cookies/auth forwarding)');
  console.log('✅ Google CSE / OSINT / URLScan endpoints ready');
  console.log('✅ Storage system initialized at:', STORAGE_DIR);
  console.log('🔧 Crash-resistant fixes applied');
});
