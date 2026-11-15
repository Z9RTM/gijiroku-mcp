import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const script = new URL('./prepare-backend.mjs', import.meta.url).href;
const prelude = `
import cp from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process, 'platform', {value: process.env.TEST_PLATFORM});
Object.defineProperty(process, 'arch', {value: process.env.TEST_PLATFORM === 'darwin' ? 'arm64' : 'x64'});
let bin;
cp.execFileSync = (command, args) => {
 console.log(JSON.stringify([command,...args]));
 if (args[0] === 'ls-remote') return (process.env.TEST_MAIN || '4d0278b' + '1'.repeat(33)) + '\\trefs/heads/main\\n';
 if (args.includes('rev-parse')) {
  if (process.env.SPEECH_COMMIT === 'badc0de') throw Error('ambiguous commit');
  const ref = args.at(-1).split('^')[0];
  return ref.length === 40 ? ref : ref + '0'.repeat(33);
 }
 if (args[0] === 'clone') {
  const source = args.at(-1);
  mkdirSync(join(source, 'ggml'), {recursive: true});
  writeFileSync(join(source, 'LICENSE'), 'speech license');
  writeFileSync(join(source, 'ggml', 'LICENSE'), 'ggml license');
 }
 if (command === 'cmake' && args[0] === '-S') {
  bin = args.find(arg => arg.startsWith('-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=')).split('=')[1];
  mkdirSync(bin, {recursive: true});
 }
 if (command === 'cmake' && args[0] === '--build') {
  if (process.env.TEST_BUILD_FAIL) throw Error('build failed');
  writeFileSync(join(bin, process.env.TEST_PLATFORM === 'win32' ? 'speech.exe' : 'speech'), 'binary');
 }
};
syncBuiltinESMExports();
await import(${JSON.stringify(script)});
`;

for (const [platform, file, backend] of [
 ['darwin', 'speech-aarch64-apple-darwin', /GGML_METAL_EMBED_LIBRARY=ON/],
 ['win32', 'speech-x86_64-pc-windows-msvc.exe', /GGML_VULKAN=ON","-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded/],
]) {
 test(`${platform}: source build, commit validation and cache`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gijiroku-prepare-test-'));
  const run = (commit, extra = {}) => {
   const env = {...process.env, TEST_PLATFORM: platform, ...extra};
   delete env.SPEECH_COMMIT;
   if (commit !== undefined) env.SPEECH_COMMIT = commit;
   return spawnSync(process.execPath, ['--input-type=module', '-e', prelude], {cwd, encoding: 'utf8', env});
  };
  const binary = join(cwd, 'binaries', file);
  try {
   let result = run();
   assert.equal(result.status, 0, result.stderr);
   assert.match(result.stdout, /"ls-remote","https:\/\/github.com\/Z9RTM\/speech.cpp.git","refs\/heads\/main"/);
   assert.match(result.stdout, /4d0278b1{33}\^\{commit\}/);
   assert.match(result.stdout, /"submodule","update","--init","--recursive"/);
   assert.match(result.stdout, /"--target","speech-cli"/);
   assert.match(result.stdout, backend);
   assert.equal(await readFile(binary, 'utf8'), 'binary');
   assert.equal(await readFile(join(cwd, 'licenses/ggml-LICENSE'), 'utf8'), 'ggml license');
   assert.doesNotMatch(run().stdout, /clone/, 'unchanged main reuses the build');
   assert.match(run(undefined, {TEST_MAIN: 'c0ffee0' + '2'.repeat(33)}).stdout, /c0ffee02{33}\^\{commit\}/, 'moved main rebuilds');
   assert.equal(run('c0ffee0').stdout, '', 'pinned prefix of the cached build skips git entirely');
   result = run('ABC1234');
   assert.equal(result.status, 0, result.stderr);
   assert.match(result.stdout, /abc1234\^\{commit\}/);
   assert.equal(JSON.parse(await readFile(`${binary}.json`, 'utf8')).commit, 'abc1234' + '0'.repeat(33));
   await writeFile(binary, 'corrupted');
   assert.match(run('abc1234').stdout, /clone/);
   const stale = JSON.parse(await readFile(`${binary}.json`, 'utf8'));
   await writeFile(`${binary}.json`, JSON.stringify({...stale, recipe: 'old recipe'}));
   assert.match(run('abc1234').stdout, /clone/);
   const metadata = await readFile(`${binary}.json`, 'utf8');
   result = run('def5678', {TEST_BUILD_FAIL: '1'});
   assert.notEqual(result.status, 0);
   assert.equal(await readFile(`${binary}.json`, 'utf8'), metadata);
   assert.equal(await readFile(binary, 'utf8'), 'binary');
   result = run('badc0de');
   assert.notEqual(result.status, 0);
   assert.doesNotMatch(result.stdout, /cmake/);
   for (const invalid of ['', '../invalid', 'abc123', 'abc12345', 'v0.10.0']) {
    result = run(invalid);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SPEECH_COMMIT/);
    assert.equal(result.stdout, '');
   }
  } finally {
   await rm(cwd, {recursive: true, force: true});
  }
 });
}
