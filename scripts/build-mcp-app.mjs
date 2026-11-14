import {build} from 'esbuild';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const result = await build({entryPoints:['ui/app.js'], bundle:true, write:false, format:'iife', target:'safari16.5', minify:true, legalComments:'inline', metafile:true});
const template = await readFile('ui/app.html', 'utf8');
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await mkdir('ui/dist', {recursive:true});
await writeFile('ui/dist/app.html', template.replace('/* APP_SCRIPT */', () => script));
// Package root = path up to the last node_modules/ plus the (scoped) name; works for flat and pnpm layouts.
const packageRoot = p => {
  const i = p.lastIndexOf('node_modules/') + 'node_modules/'.length;
  const name = p.slice(i).split('/');
  return p.slice(0, i) + name.slice(0, name[0].startsWith('@') ? 2 : 1).join('/');
};
const packages = new Set(Object.keys(result.metafile.inputs).filter(p => p.includes('node_modules/')).map(packageRoot));
const notices = [];
for (const root of packages) {
  const info = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  let license;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
    try { license = await readFile(join(root, filename), 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!license) throw Error(`Missing license text: ${info.name}`);
  notices.push(`${info.name} ${info.version}\n${license}`);
}
await writeFile('ui/dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n'));
console.log('Built self-contained gijiroku-mcp MCP App');
