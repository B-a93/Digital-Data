import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { databaseHealth, initializeDatabase, query } from './database.mjs';
import { requirePlatformOwner } from './auth-server.mjs';
const root = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
async function body(req){let value='';for await(const chunk of req){value+=chunk;if(value.length>20000)throw Object.assign(new Error('Request too large'),{status:413});}return JSON.parse(value||'{}');}
const server = http.createServer(async (req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/health') {
      const database = await databaseHealth();
      const body = JSON.stringify({status: database.ok ? 'ok' : 'degraded', database});
      res.writeHead(database.ok ? 200 : 503, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(body);
      return;
    }
    if(pathname==='/api/platform/schools'){
      await requirePlatformOwner(req);
      if(req.method==='GET'){
        const result=await query(`SELECT s.id,s.name,s.slug,s.school_type,s.region,s.district,s.status,s.created_at,o.administrator_name,o.administrator_email,o.invitation_status FROM schools s LEFT JOIN school_onboarding o ON o.school_id=s.id ORDER BY s.created_at DESC`);
        json(res,200,{schools:result.rows});return;
      }
      if(req.method==='POST'){
        const data=await body(req),name=String(data.name||'').trim(),slug=String(data.slug||'').trim().toLowerCase(),adminName=String(data.administratorName||'').trim(),adminEmail=String(data.administratorEmail||'').trim().toLowerCase();
        if(!name||!adminName||!/^[-a-z0-9]{3,60}$/.test(slug)||!/^\S+@\S+\.\S+$/.test(adminEmail)){json(res,400,{error:'Enter valid school and administrator details.'});return;}
        const result=await query(`WITH school AS (INSERT INTO schools(name,slug,school_type,region,district,contact_name,contact_email,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *) INSERT INTO school_onboarding(school_id,administrator_name,administrator_email) SELECT id,$6,$7 FROM school RETURNING school_id`,[name,slug,String(data.schoolType||'public'),String(data.region||'').trim()||null,String(data.district||'').trim()||null,adminName,adminEmail]);
        json(res,201,{id:result.rows[0].school_id,status:'pending'});return;
      }
      json(res,405,{error:'Method not allowed'});return;
    }
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(root + path.sep)) {res.writeHead(403);res.end('Forbidden');return;}
    const body = await readFile(target);
    res.writeHead(200, {'Content-Type':types[path.extname(target)] || 'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://ep-spring-poetry-b2x3am6k.neonauth.c-6.eu-central-1.aws.neon.tech; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
    res.end(body);
  } catch(error){if(new URL(req.url,'http://localhost').pathname.startsWith('/api/')){json(res,error.status||500,{error:error.status?error.message:'Request failed'});return;}res.writeHead(404);res.end('Not found');}
});
await initializeDatabase();
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () => console.log(`School portal: http://${process.env.HOST || '0.0.0.0'}:${process.env.PORT || 3000}`));
