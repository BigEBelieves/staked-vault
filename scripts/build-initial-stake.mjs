import fs from 'node:fs';import {createHash} from 'node:crypto';import {build} from 'esbuild';
await build({entryPoints:['initial-stake/app.mjs'],outfile:'initial-stake/app.bundle.js',bundle:true,minify:true,format:'esm',platform:'browser',legalComments:'eof'});
const hash=createHash('sha384').update(fs.readFileSync('initial-stake/app.bundle.js')).digest('base64');fs.writeFileSync('initial-stake/index.html',fs.readFileSync('initial-stake/template.html','utf8').replace('BUNDLE_INTEGRITY','sha384-'+hash));
