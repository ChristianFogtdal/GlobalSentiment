# Global Mood Intelligence

A desktop-first interactive dashboard for exploring aggregated public sentiment. It presents the overall mood score, emotional composition, discussion topics, detected shifts, representative signals, and country-level mood on an interactive map.

## Run locally

The application is static. Serve this folder with any web server, for example:

```powershell
node -e "const http=require('http'),fs=require('fs'),path=require('path');http.createServer((req,res)=>{const file=path.join(process.cwd(),req.url==='/'?'index.html':decodeURIComponent(req.url));fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);return res.end('Not found');}const type={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});res.end(data);});}).listen(4173)"
```

Open `http://localhost:4173`.

## Data and dependencies

- The dashboard uses the demo dataset in `demo-data.js`.
- The dashboard reads the shared historical archive from Supabase Postgres; it does not call Bluesky directly. A scheduled Supabase Edge Function searches public Bluesky posts every 15 minutes for the configured AI-coding keywords and writes matching posts to the archive.
- The Bluesky AT URI is the primary key, so repeat searches do not add duplicate rows. Data review displays the full archived time series.
- New ingested posts retain Bluesky's declared original-language tag (such as `en`, `es`, or `pt-BR`). Translation is not performed.
- Leaflet, map tiles, and country boundary data are loaded from public CDNs at runtime.
- See `global-mood-intelligence-prd.md` for the product scope and responsible-AI constraints.

## Scheduled Bluesky ingestion

The `supabase/` directory contains the secure ingestion function and migration. The browser only reads the Supabase archive. Every 15 minutes, the function retrieves up to 10 recent public posts for each of 24 AI-related phrases: core AI concepts, products, AI coding, and societal impact. AT URI deduplication prevents repeat searches from adding the same post.

Before deployment, configure `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`, and a long random `INGESTION_SECRET` as Supabase Edge Function secrets. Create a matching Vault secret and schedule the function only after the function is deployed:

```sql
select vault.create_secret('your-long-random-ingestion-secret', 'bluesky_ingestion_secret');

select cron.schedule(
  'ingest-bluesky-ai-coding-posts',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://bsnzcspfrmlihwxqkjyv.supabase.co/functions/v1/ingest-bluesky-search',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer your-supabase-publishable-key',
      'apikey', 'your-supabase-publishable-key',
      'x-ingestion-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bluesky_ingestion_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```
