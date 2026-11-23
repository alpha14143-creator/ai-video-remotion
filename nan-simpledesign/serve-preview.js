const http=require('http'),https=require('https'),fs=require('fs'),path=require('path');
const P=process.argv[2],LIVE='nan-simpledesign.nansimpledesign-studio.workers.dev';
const local={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js'};
const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8'};
http.createServer((req,res)=>{const u=req.url.split('?')[0];
 if(local[u]){const f=local[u];res.writeHead(200,{'content-type':types[f.split('.').pop()],'cache-control':'no-store'});return fs.createReadStream(path.join(P,f)).pipe(res);}
 if(req.method!=='GET'){res.writeHead(403);return res.end('preview read-only');}
 https.get({host:LIVE,path:req.url,headers:{'user-agent':'preview'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)}).on('error',e=>{res.writeHead(502);res.end(String(e))});
}).listen(8787,()=>console.log('ok'));
