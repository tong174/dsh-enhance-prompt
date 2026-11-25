// 核对：仓库已发布的文件、README、topic；顺便取注册表里同类条目的格式做参照。
import { gh } from './gh-api.mjs';

const OWNER = 'tong174';
const REPO = 'dsh-enhance-prompt';

const repo = await gh(`/repos/${OWNER}/${REPO}`);
console.log('repo:', repo.status, repo.json?.full_name, '| private:', repo.json?.private, '| default:', repo.json?.default_branch);
console.log('desc:', repo.json?.description);
console.log('topics:', (repo.json?.topics || []).join(','));

const contents = await gh(`/repos/${OWNER}/${REPO}/git/trees/main?recursive=1`);
const paths = (contents.json?.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
console.log(`files on main: ${paths.length}`);
console.log(paths.slice(0, 40).join('\n'));

const readme = await gh(`/repos/${OWNER}/${REPO}/readme`, { accept: 'application/vnd.github.html+json' });
console.log('readme html status:', readme.status, 'bytes:', (readme.text || '').length);

// 注册表参照
const reg = await gh('/repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins');
if (reg.ok) {
  const names = reg.json.map((e) => e.name);
  console.log('registry entries:', reg.json.length, '| sample:', names.slice(0, 6).join(','));
  const sample = names.find((n) => !n.startsWith('.')) || names[0];
  const one = await gh(`/repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins/${sample}`);
  if (one.ok) {
    const body = Buffer.from(one.json.content, 'base64').toString('utf8');
    console.log(`--- ${sample} ---\n${body}`);
  }
} else {
  console.log('registry listing failed', reg.status, reg.text.slice(0, 200));
}
