import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG, READ_RPC_URLS } from '../web/src/config.js';

// Build-owned directories only. Entry points and lazy wallet dependencies are
// bundled locally; generated HTML never imports executable code from a CDN.
const outdir = 'assets/vault';
rmSync(outdir, { recursive:true, force:true });
mkdirSync(outdir, { recursive:true });
const result = await build({
  entryPoints:['web/src/main.js'], outdir, bundle:true, splitting:true,
  format:'esm', platform:'browser', target:['es2020'], minify:true,
  entryNames:'app-[hash]', chunkNames:'chunk-[hash]', assetNames:'asset-[hash]',
  metafile:true, legalComments:'linked', logLevel:'warning',
  define:{'process.env.NODE_ENV':'"production"'},
});
const entry = Object.entries(result.metafile.outputs).find(([,v]) => v.entryPoint === 'web/src/main.js')[0];
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith('node_modules/')) continue;
  let dir = dirname(input);
  while (dir.startsWith('node_modules')) {
    if (existsSync(join(dir,'package.json'))) { packages.add(dir); break; }
    dir = dirname(dir);
  }
}
const licenses = [...packages].sort().map(dir => {
  const pkg = JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));
  const files = readdirSync(dir).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  return `${pkg.name}@${pkg.version} — ${JSON.stringify(pkg.license ?? 'see package')}\n` +
    files.map(name => `${name}\n${readFileSync(join(dir,name),'utf8')}`).join('\n');
}).join('\n\n'+'='.repeat(72)+'\n\n');
writeFileSync(outdir+'/THIRD-PARTY-LICENSES.txt', licenses+'\n');
const sri = file => 'sha384-' + createHash('sha384').update(readFileSync(file)).digest('base64');
const origins = READ_RPC_URLS.map(x=>new URL(x).origin);
if (origins.some(x=>!x.startsWith('https://'))) throw new Error('Read endpoints must use HTTPS');
const policy = [
  "default-src 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'none'",
  "script-src 'self'", "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data: https://explorer-api.walletconnect.com https://explorer-api.walletconnect.org https://api.web3modal.com https://api.reown.com https://avatars.githubusercontent.com",
  "connect-src 'self' " + [...new Set(origins)].join(' ') + ' https://explorer-api.walletconnect.com https://explorer-api.walletconnect.org https://rpc.walletconnect.com https://rpc.walletconnect.org https://relay.walletconnect.com https://relay.walletconnect.org wss://relay.walletconnect.com wss://relay.walletconnect.org https://verify.walletconnect.com https://verify.walletconnect.org https://pulse.walletconnect.org https://pulse.walletconnect.com https://api.web3modal.com https://api.reown.com',
  'frame-src https://verify.walletconnect.com https://verify.walletconnect.org',
  'worker-src blob:',
].join('; ');
const template = readFileSync('web/src/index.template.html','utf8');
// Version CSS URLs as well as JavaScript: stale cached CSS must not fail a new page's SRI check.
const css = readFileSync('web/src/style.css');
const stylesheet = outdir + '/style-' + createHash('sha256').update(css).digest('hex').slice(0,16) + '.css';
writeFileSync(stylesheet, css);
mkdirSync('legacy',{recursive:true});
for (const [path,prefix] of [['index.html',''],['web/index.html','../'],['legacy/index.html','../']]) {
  const assets = `<link rel="stylesheet" href="${prefix}${stylesheet}" integrity="${sri(stylesheet)}">\n  <script type="module" src="${prefix}${entry}" integrity="${sri(entry)}"></script>`;
  const html = template.replace('  <!-- LOCAL_ASSETS -->', '  '+assets)
    .replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n  <meta http-equiv="Content-Security-Policy" content="'+policy+'">');
  if (/\son\w+=|<script(?![^>]*\bsrc=)/i.test(html)) throw new Error('Executable inline content must not survive the build');
  writeFileSync(path,html);
}
const files = readdirSync(outdir).sort().map(name=>({path:outdir+'/'+name,sha384:sri(outdir+'/'+name)}));
writeFileSync(outdir+'/manifest.json',JSON.stringify({schema:1,vault:CONFIG.VAULT_ADDRESS,vaultVersion:CONFIG.VAULT_VERSION,files},null,2)+'\n');
mkdirSync('build',{recursive:true});
writeFileSync('build/web-metafile.json',JSON.stringify(result.metafile,null,2));
console.log(`Built ${files.length} local assets; V3 default and legacy withdrawal page built.`);

writeFileSync("_headers", "/*\n  Content-Security-Policy: "+policy+"; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n\n/assets/vault/*\n  Cache-Control: public, max-age=300\n\n/\n  Cache-Control: no-cache\n/legacy/*\n  Cache-Control: no-cache\n");
