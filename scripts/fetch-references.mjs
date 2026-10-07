import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = new URL('..', import.meta.url).pathname;
const catalog = JSON.parse(readFileSync(join(root, 'references/catalog.json'), 'utf8'));
const outRoot = join(root, 'references/recorded');
const tarPath = process.env.TINYSOL_TAR || '/tmp/refs/TinySOL.tar.gz';
const tarUrl = 'https://zenodo.org/records/3685367/files/TinySOL.tar.gz?download=1';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n${r.stderr || r.stdout}`);
  return r.stdout;
}

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 1000) return;
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function ensureTar() {
  const min = 900 * 1024 * 1024;
  if (!existsSync(tarPath) || statSync(tarPath).size < min) {
    console.log('downloading TinySOL archive');
    run('curl', ['-L', '--retry', '3', '-o', tarPath, tarUrl]);
  }
}

let tarIndex = null;
function archiveMember(rel) {
  if (!tarIndex) {
    tarIndex = run('tar', ['-tzf', tarPath]).split('\n').filter(Boolean);
  }
  return tarIndex.find((name) => name === rel || name.endsWith('/' + rel));
}

const want = new Set(process.argv.slice(2));
const pendingArchive = [];
for (const set of catalog.sets) {
  if (want.size && !want.has(set.id)) continue;
  const dir = join(outRoot, set.id);
  mkdirSync(dir, { recursive: true });
  for (const note of set.notes) {
    const wavName = `${note.midi}_${note.size}.wav`;
    const dest = join(dir, wavName);
    if (existsSync(dest) && statSync(dest).size > 1000) continue;
    if (note.archive) {
      pendingArchive.push({ set, note, dest, wavName });
      continue;
    }
    const raw = join(dir, note.file);
    await download(note.url, raw);
    if (note.flac) {
      run('ffmpeg', ['-y', '-i', raw, '-c:a', 'pcm_s24le', dest]);
      run('rm', [raw]);
    } else if (raw !== dest) {
      run('mv', [raw, dest]);
    }
    console.log('get', set.id, wavName);
  }
}

if (pendingArchive.length) {
  ensureTar();
  const tmp = join(outRoot, '.tinysol-extract');
  mkdirSync(tmp, { recursive: true });
  const members = [];
  for (const item of pendingArchive) {
    const member = archiveMember(item.note.archive);
    if (!member) throw new Error(`missing in TinySOL archive: ${item.note.archive}`);
    item.member = member;
    members.push(member);
  }
  run('tar', ['-xzf', tarPath, '-C', tmp, ...members]);
  for (const item of pendingArchive) {
    run('mv', [join(tmp, item.member), item.dest]);
    console.log('tar', item.set.id, item.wavName);
  }
  run('rm', ['-rf', tmp]);
}
console.log('recorded notes are in references/recorded');
