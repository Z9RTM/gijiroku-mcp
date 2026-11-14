import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

test('ChatGPT ZIP is self-contained and launches the shared MCP without recording', {timeout:15000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gijiroku plugin test '));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const root = join(dir, 'plugin with spaces');
  const archive = resolve('dist-chatgpt/gijiroku-mcp-darwin-arm64.zip');
  execFileSync('/usr/bin/unzip', ['-q', archive, '-d', root]);
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const manifest = await json(join(root, 'plugin.json'));
  const mcpb = await json('manifest.json');
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'gijiroku-mcp');
  assert.equal(manifest.version, mcpb.version);
  const openai = manifest.extensions['com.openai'];
  assert.equal(openai.requires_local_executor, true);
  assert.ok(openai.interface.shortDescription.length <= 30);
  assert.deepEqual((await readdir(root)).sort(), ['README.md', 'licenses', 'mcp.json', 'plugin.json', 'server']);
  for (const [packed, source] of [
    ['server/gijiroku-mcp', 'target/release/gijiroku-mcp'],
    ['server/speech', 'binaries/speech-aarch64-apple-darwin'],
    ['licenses/MCP-App-THIRD_PARTY_NOTICES.txt', 'ui/dist/THIRD_PARTY_NOTICES.txt'],
    ['licenses/gijiroku-mcp-LICENSE', 'LICENSE'],
  ]) assert.deepEqual(await readFile(join(root, packed)), await readFile(source));
  for (const binary of ['gijiroku-mcp', 'speech']) assert.ok((await stat(join(root, 'server', binary))).mode & 0o111);
  assert.ok((await readdir(join(root, 'licenses'))).includes('speech.cpp-LICENSE'));
  const rust = await readFile(join(root, 'licenses/Rust-THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const crate of ['serde_json', 'libc', 'itoa', 'memchr', 'zmij']) assert.match(rust, new RegExp(`^${crate} \\d`, 'm'), `${crate} license bundled`);
  const config = await json(join(root, 'mcp.json'));
  assert.equal(config.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  const server = config.mcpServers.gijiroku_mcp;
  assert.equal(server.type, 'stdio');
  // Portable command tokens must be PATH names or ./ paths, never absolute paths.
  assert.match(server.command, /^(?:[A-Za-z0-9_-]+|\.\/[^\s]+)$/);
  const expand = s => s.replaceAll('${PLUGIN_ROOT}', root);
  // Use an isolated home; this never requests downloads or microphone access.
  const home = join(dir, 'test home');
  const requests = [
    ['initialize', {protocolVersion:'2025-11-25', capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}}],
    ['tools/list', {}],
    ['resources/read', {uri:'ui://gijiroku-mcp/panel-v0.6.0.html'}],
    ['tools/call', {name:'open_gijiroku', arguments:{}}],
  ].map(([method, params], id) => JSON.stringify({jsonrpc:'2.0', id, method, params})).join('\n') + '\n';
  const child = spawnSync(server.command, server.args.map(expand), {
    cwd:expand(server.cwd), env:{...process.env, HOME:home}, input:requests,
    encoding:'utf8', timeout:10000, maxBuffer:4 * 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const responses = child.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses.length, 4);
  assert.equal(responses[0].result.serverInfo.version, mcpb.version);
  assert.deepEqual(responses[1].result.tools.map(t => t.name).sort(), mcpb.tools.map(t => t.name).sort());
  const resource = responses[2].result.contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.text, /gijiroku-mcp/);
  assert.equal(responses[3].result.isError, undefined);
  const status = responses[3].result.structuredContent;
  assert.equal(status.operation, 'idle');
  assert.equal(status.recording, null);
  assert.equal(status.dataDirectory, join(home, 'Library/Application Support/gijiroku-mcp/chatgpt'));
  assert.equal(status.modelDirectory, join(home, 'Library/Application Support/gijiroku-mcp/models'));
});
