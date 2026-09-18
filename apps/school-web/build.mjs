import {cp,mkdir} from 'node:fs/promises';
await mkdir('dist/public',{recursive:true});
await mkdir('dist/database',{recursive:true});
await cp('apps/school-web/public','dist',{recursive:true});
await cp('apps/school-web/public','dist/public',{recursive:true});
await cp('apps/school-web/server.mjs','dist/server.mjs');
await cp('apps/school-web/database.mjs','dist/database.mjs');
await cp('apps/school-web/database/schema.sql','dist/database/schema.sql');
console.log('School portal frontend and Node.js server built in dist.');
