import {mkdir,writeFile,readFile,chmod,copyFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('対応環境はApple Silicon Macです');
const repository = 'https://github.com/Z9RTM/speech.cpp.git';
const pinned = process.env.SPEECH_COMMIT;
if (pinned !== undefined && !/^[a-f0-9]{7}$/i.test(pinned)) throw Error('SPEECH_COMMITにコミットハッシュの先頭7桁を指定してください');
const commit = pinned?.toLowerCase() ?? execFileSync('git',['ls-remote',repository,'refs/heads/main'],{encoding:'utf8'}).split(/\s/)[0];
if (!/^[a-f0-9]{40}$/.test(commit) && !pinned) throw Error('speech.cppのmainブランチを解決できません');
const destination = 'binaries/speech-aarch64-apple-darwin';
const hash = data => createHash('sha256').update(data).digest('hex');
// ビルド設定を変更した際も以前のバイナリを再利用しない。
const recipe = hash(await readFile(new URL(import.meta.url)));
try {
 const cached = JSON.parse(await readFile(`${destination}.json`,'utf8'));
 if (cached.commit?.startsWith(commit) && cached.recipe === recipe && cached.binarySha === hash(await readFile(destination))) process.exit(0);
} catch {}
const dir = await mkdtemp(join(tmpdir(),'gijiroku-backend-'));
const source = join(dir,'source');
const build = join(dir,'build');
const bin = join(build,'bin');
const run = (command,args) => execFileSync(command,args,{stdio:'inherit'});
try {
 // 短縮ハッシュの一意性をGitに検証させるため、履歴を取得する。
 run('git',['clone','--no-checkout',repository,source]);
 const resolved = execFileSync('git',['-C',source,'rev-parse','--verify',`${commit}^{commit}`],{encoding:'utf8'}).trim();
 if (!/^[a-f0-9]{40}$/.test(resolved) || !resolved.startsWith(commit)) throw Error('指定したコミットを一意に特定できません');
 run('git',['-C',source,'checkout','--detach',resolved]);
 run('git',['-C',source,'submodule','update','--init','--recursive','--depth','1']);
 run('cmake',[
  '-S',source,'-B',build,'-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF','-DGGML_NATIVE=OFF','-DGGML_OPENMP=OFF',
  `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${bin}`,`-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${bin}`,
  '-DCMAKE_OSX_ARCHITECTURES=arm64','-DGGML_METAL=ON','-DGGML_METAL_EMBED_LIBRARY=ON','-DGGML_VULKAN=OFF'
 ]);
 run('cmake',['--build',build,'--config','Release','--target','speech-cli','--parallel','4']);
 run(join(bin,'speech'),['--version']);
 await mkdir('binaries',{recursive:true});
 await mkdir('licenses',{recursive:true});
 await copyFile(join(source,'LICENSE'),'licenses/speech.cpp-LICENSE');
 await copyFile(join(source,'ggml','LICENSE'),'licenses/ggml-LICENSE');
 await copyFile(join(bin,'speech'),destination);
 await chmod(destination,0o755);
 await writeFile(`${destination}.json`,JSON.stringify({commit:resolved,recipe,binarySha:hash(await readFile(destination))}));
} finally { await rm(dir,{recursive:true,force:true}); }
