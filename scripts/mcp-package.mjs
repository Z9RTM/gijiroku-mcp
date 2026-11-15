import {mkdir, copyFile, cp, readdir, readFile, writeFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join, dirname} from 'node:path';

// Packages are built natively, one per OS and CPU, keyed by Node's platform and arch.
const targets = {
  'darwin-arm64': {name:'darwin-arm64', triple:'aarch64-apple-darwin', exe:'', tar:'tar', launch:['sh', '${PLUGIN_ROOT}/server/launch.sh']},
  // Git for Windows can put GNU tar first on PATH, and only Windows' bsdtar writes ZIP.
  'win32-x64': {name:'windows-x64', triple:'x86_64-pc-windows-msvc', exe:'.exe', tar:`${process.env.SystemRoot}\\System32\\tar.exe`, launch:['cmd', '/d', '/c', '${PLUGIN_ROOT}\\server\\launch.cmd']},
};
export const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw Error('対応環境はApple Silicon MacとWindows x64です');
export const speechBinary = `binaries/speech-${target.triple}${target.exe}`;

// Both distribution formats ship the same server, embedded UI and speech engine.
export function buildMcpRuntime() {
  execFileSync(process.execPath, ['scripts/prepare-backend.mjs'], {stdio:'inherit'});
  execFileSync(process.execPath, ['scripts/build-mcp-app.mjs'], {stdio:'inherit'});
  execFileSync('cargo', ['build', '--locked', '--release'], {stdio:'inherit'});
}

export async function copyMcpRuntime(stage) {
  await mkdir(join(stage, 'server'));
  await copyFile(`target/release/gijiroku-mcp${target.exe}`, join(stage, `server/gijiroku-mcp${target.exe}`));
  await copyFile(speechBinary, join(stage, `server/speech${target.exe}`));
  await cp('licenses', join(stage, 'licenses'), {recursive:true});
  await copyFile('ui/dist/THIRD_PARTY_NOTICES.txt', join(stage, 'licenses/MCP-App-THIRD_PARTY_NOTICES.txt'));
  await copyFile('LICENSE', join(stage, 'licenses/gijiroku-mcp-LICENSE'));
  await writeFile(join(stage, 'licenses/Rust-THIRD_PARTY_NOTICES.txt'), await rustNotices());
}

export async function rustNotices() {
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {encoding:'utf8', maxBuffer:64 * 1024 * 1024}));
  const resolved = new Set(meta.resolve.nodes.map(n => n.id));
  const crates = meta.packages.filter(p => resolved.has(p.id) && !meta.workspace_members.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const sections = [];
  for (const crate of crates) {
    const dir = dirname(crate.manifest_path);
    const files = (await readdir(dir)).filter(f => /^(LICEN[CS]E|COPYING|NOTICE)/i.test(f)).sort();
    if (!files.length) throw Error(`No license file for Rust crate ${crate.name} ${crate.version}`);
    const texts = await Promise.all(files.map(async f => `--- ${f} ---\n${(await readFile(join(dir, f), 'utf8')).trim()}`));
    sections.push(`${crate.name} ${crate.version} (${crate.license})\n${texts.join('\n\n')}`);
  }
  return sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n';
}

// Recreate the archive so old files never survive a rebuild.
export async function zipDirectory(stage, output) {
  await rm(output, {force:true});
  execFileSync(target.tar, ['--format', 'zip', '-cf', output, '-C', stage, ...await readdir(stage)], {stdio:'inherit'});
}
