import {mkdir, mkdtemp, cp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {buildMcpRuntime, copyMcpRuntime, target, zipDirectory} from './mcp-package.mjs';

buildMcpRuntime();
const stage = await mkdtemp(join(tmpdir(), 'gijiroku-chatgpt-'));
const output = resolve(`dist-chatgpt/gijiroku-mcp-${target.name}.zip`);
const [command, ...args] = target.launch;
const launcher = basename(args.at(-1));
try {
  await copyMcpRuntime(stage);
  await cp('chatgpt-plugin', stage, {recursive:true, filter: src => !/[\\/]launch\.\w+$/.test(src) || basename(src) === launcher});
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const write = (path, value) => writeFile(join(stage, path), JSON.stringify(value, null, 2) + '\n');
  const manifest = await json(join(stage, 'plugin.json'));
  manifest.version = (await json('manifest.json')).version;
  await write('plugin.json', manifest);
  const config = await json(join(stage, 'mcp.json'));
  Object.assign(config.mcpServers.gijiroku_mcp, {command, args});
  await write('mcp.json', config);
  await mkdir('dist-chatgpt', {recursive:true});
  await zipDirectory(stage, output);
  console.log(output);
} finally { await rm(stage, {recursive:true, force:true}); }
