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
- Select **Load Bluesky AI sample** to make one public, unauthenticated request for up to ten posts from the configured AI-focused Bluesky feed. It never auto-refreshes and enforces a five-minute cooldown between requests.
- Leaflet, map tiles, and country boundary data are loaded from public CDNs at runtime.
- See `global-mood-intelligence-prd.md` for the product scope and responsible-AI constraints.
