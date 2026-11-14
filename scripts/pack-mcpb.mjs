import {mkdir, mkdtemp, copyFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {buildMcpRuntime, copyMcpRuntime} from './mcp-package.mjs';

buildMcpRuntime();
const stage = await mkdtemp(join(tmpdir(), 'gijiroku-mcpb-'));
const output = resolve('dist-mcp/gijiroku-mcp-darwin-arm64.mcpb');
try {
  await copyMcpRuntime(stage);
  await mkdir('dist-mcp', {recursive:true});
  await copyFile('manifest.json', join(stage, 'manifest.json'));
  await copyFile('README.md', join(stage, 'README.md'));
  // Recreate the archive so old files never survive a rebuild.
  await rm(output, {force:true});
  execFileSync('/usr/bin/zip', ['-q', '-r', output, '.'], {cwd:stage, stdio:'inherit'});
  console.log(output);
} finally { await rm(stage, {recursive:true, force:true}); }
