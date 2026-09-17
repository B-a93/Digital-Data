import {cp,mkdir} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await cp('apps/school-web/public','dist',{recursive:true});
console.log('Static school prototype built in dist.');
