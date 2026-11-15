import {mkdir, mkdtemp, copyFile, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {buildMcpRuntime, copyMcpRuntime, target, zipDirectory} from './mcp-package.mjs';

buildMcpRuntime();
const stage = await mkdtemp(join(tmpdir(), 'gijiroku-mcpb-'));
const output = resolve(`dist-mcp/gijiroku-mcp-${target.name}.mcpb`);
try {
  await copyMcpRuntime(stage);
  await mkdir('dist-mcp', {recursive:true});
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  manifest.server.entry_point += target.exe;
  // A package carries one OS's binaries, so it must not install on the other.
  manifest.compatibility.platforms = [process.platform];
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await copyFile('README.md', join(stage, 'README.md'));
  await zipDirectory(stage, output);
  console.log(output);
} finally { await rm(stage, {recursive:true, force:true}); }
