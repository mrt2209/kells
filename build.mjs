import { mkdir, copyFile } from 'node:fs/promises';
const assets = ['index.html','styles.css','site.js','thank-you.html','thank-you.js','message.css','privacy.html','favicon.svg','robots.txt','_headers','_routes.json','_worker.js'];
await mkdir(new URL('./dist/',import.meta.url),{recursive:true});
for (const asset of assets) await copyFile(new URL(asset,import.meta.url),new URL(`dist/${asset}`,import.meta.url));
console.log('Kells website ready in dist/');
