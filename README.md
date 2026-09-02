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
- The dashboard fetches up to ten public, unauthenticated AI-related posts from three configured Bluesky accounts on load and then every five minutes while the page is open. This makes three small feed requests per refresh; posts must match an AI-related keyword before appearing. The refresh control can request an additional sample; concurrent requests are prevented.
- Leaflet, map tiles, and country boundary data are loaded from public CDNs at runtime.
- See `global-mood-intelligence-prd.md` for the product scope and responsible-AI constraints.
