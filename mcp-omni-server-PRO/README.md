# MCP OMNI Server — PRO Edition (ONE server)

## Upload to GitHub
- Create repo → Add file → **server.js**, **package.json**, **Dockerfile**, **Procfile** → paste contents → **Commit** each file to *main*.
- Do not upload a zip; upload *the files inside* the zip or paste them.

## Railway
1) New Project → Deploy from GitHub (pick this repo).
2) Service → **Variables** (Name → Value, no quotes):
   - AUTH_TOKEN → c7f9e2_8743925617_super_secret  (use this or make your own)
   - ANTHROPIC_API_KEY, HEYGEN_API_KEY, APIFY_TOKEN, PERPLEXITY_API_KEY, APOLLO_API_KEY, IDX_ACCESS_KEY (add when ready)
3) Service → **Settings → Domains** → copy **Production Domain** (looks like https://your-app.up.railway.app)
4) Open the domain in your browser → should show `{ ok: true, ... }`

## In n8n
- In 🎯 Market Config Hub, set ALL MCP URLs to your one Railway domain.
- In every HTTP Request node that hits your server, add header:
  `x-auth-token: c7f9e2_8743925617_super_secret`

## Endpoints
POST /api/discover           → { queries:[...], location:{city,state,zipCodes,neighborhoods} }
POST /api/scrape             → { urls:[...] }
POST /api/fuse-score         → { items:[...], location:{...} }
POST /api/content-generation → { lead:{...}, location:{...} }
POST /api/heygen/video       → HeyGen generate payload
POST /api/apollo/enrich      → { firstname, lastname, email, ... }
GET  /api/idx/leads
POST /api/public-records     → { url:"https://data...json?..."} 
POST /api/mortgage-event     → { contact:{email,phone}, event:"preapproval_issued", meta:{}, occurredAt:"ISO" }
POST /api/analytics-tracking → { event, metrics }

## Safety
- Never put API keys in code or n8n nodes; only in Railway → Variables.
- Rotate any keys you posted publicly.
