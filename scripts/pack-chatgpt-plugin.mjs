import {mkdir, mkdtemp, cp, readFile, writeFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {buildMcpRuntime, copyMcpRuntime} from './mcp-package.mjs';

buildMcpRuntime();
const stage = await mkdtemp(join(tmpdir(), 'gijiroku-chatgpt-'));
const output = resolve('dist-chatgpt/gijiroku-mcp-darwin-arm64.zip');
try {
  await copyMcpRuntime(stage);
  await cp('chatgpt-plugin', stage, {recursive:true});
  const manifest = JSON.parse(await readFile(join(stage, 'plugin.json'), 'utf8'));
  const mcpb = JSON.parse(await readFile('manifest.json', 'utf8'));
  manifest.version = mcpb.version;
  await writeFile(join(stage, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  await mkdir('dist-chatgpt', {recursive:true});
  await rm(output, {force:true});
  execFileSync('/usr/bin/zip', ['-q', '-r', output, '.'], {cwd:stage, stdio:'inherit'});
  console.log(output);
} finally { await rm(stage, {recursive:true, force:true}); }
