// 校验远端仓库内容与本地一致（版本号、关键文件存在性、文件数）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gh } from './gh-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'tong174';
const REPO = 'dsh-enhance-prompt';

const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail += 1;
};

const readRemote = async (p) => {
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${p}`);
  if (!r.ok) return null;
  return { json: r.json, text: Buffer.from(r.json.content, 'base64').toString('utf8') };
};

const pkg = await readRemote('package.json');
check('remote package.json reachable', Boolean(pkg), pkg ? `${pkg.json.size} B` : 'missing');
if (pkg) {
  const j = JSON.parse(pkg.text);
  check('version matches local', j.version === local.version, `${j.version} vs ${local.version}`);
  for (const f of ['lib/index.js', 'lib/client.js', 'lib/prompts.js', 'cordis.patch.yml', 'LICENSE']) {
    check(`files[] covers ${f}`, j.files.some((x) => f === x || f.startsWith(`${x}/`)));
  }
  check('dsh.bundle.patch declared', j.dsh?.bundle?.patch === './cordis.patch.yml');
}

for (const p of ['docs/audit-v0.4.md', 'docs/compare-report.md', 'README.md', 'README.zh.md']) {
  const r = await readRemote(p);
  check(`remote has ${p}`, Boolean(r), r ? `${r.json.size} B` : 'missing');
}

const idx = await readRemote('lib/index.js');
check('remote index.js is v0.4.x', Boolean(idx) && idx.text.includes('await llm.listModels'), 'contains await llm.listModels');

const cli = await readRemote('lib/client.js');
check('remote client.js has header gate', Boolean(cli) && cli.text.includes('x-dsh-enhance'));

const tree = await gh(`/repos/${OWNER}/${REPO}/git/trees/main?recursive=1`);
check('main tree readable', tree.ok, tree.ok ? `${tree.json.tree.length} entries` : String(tree.status));

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
