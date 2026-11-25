// 上架 DSH 插件市场：fork awesome-dsh-plugin → 新增 data/plugins/<owner>__<repo>.yml → 提 PR。
import { gh } from './gh-api.mjs';

const OWNER = 'tong174';
const REPO = 'dsh-enhance-prompt';
const UPSTREAM = 'awesome-dsh-plugin';
const UREPO = 'awesome-dsh-plugin';
const FILE = `data/plugins/${OWNER}__${REPO}.yml`;

const yaml = `url: https://github.com/${OWNER}/${REPO}
name: ${OWNER}/${REPO}
category: ui
description:
  en: 'One-click prompt enhancer: rewrite a rough composer draft into a clear, specific prompt without changing the ask, with one-click revert — reverse-engineered from WorkBuddy and benchmarked ahead of it.'
  zh: '输入框右侧一键增强提示词：把草稿改写成更清晰具体的版本而不改原意，并可一键恢复原文——逆向复刻 WorkBuddy 且实测优于原版。'
`;

// 0. 顺手清掉误提交的临时输出文件
const del = await gh(`/repos/${OWNER}/${REPO}/contents/live-out.txt`);
if (del.ok) {
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/live-out.txt`, {
    method: 'DELETE',
    body: { message: 'chore: drop stray test output', sha: del.json.sha, branch: 'main' },
  });
  console.log('cleanup live-out.txt:', r.status);
}

// 1. fork
const fork = await gh(`/repos/${UPSTREAM}/${UREPO}/forks`, { method: 'POST', body: { default_branch_only: true } });
console.log('fork:', fork.status, fork.json?.full_name || fork.text.slice(0, 160));

// 2. 等 fork 就绪
let ready = null;
for (let i = 0; i < 20; i += 1) {
  const r = await gh(`/repos/${OWNER}/${UREPO}`);
  if (r.ok) { ready = r.json; break; }
  await new Promise((res) => setTimeout(res, 3000));
}
if (!ready) {
  console.error('fork never became available');
  process.exit(1);
}
console.log('fork ready:', ready.full_name, 'default:', ready.default_branch);

// 3. 写注册表条目
const existing = await gh(`/repos/${OWNER}/${UREPO}/contents/${FILE}`);
const putBody = {
  message: `feat: add ${OWNER}/${REPO}`,
  content: Buffer.from(yaml, 'utf8').toString('base64'),
  branch: ready.default_branch,
};
if (existing.ok) putBody.sha = existing.json.sha;
const put = await gh(`/repos/${OWNER}/${UREPO}/contents/${FILE}`, { method: 'PUT', body: putBody });
console.log('put file:', put.status, put.ok ? put.json.commit?.sha?.slice(0, 8) : put.text.slice(0, 300));
if (!put.ok) process.exit(1);

// 4. 提 PR
const prBody = `## Add \`${OWNER}/${REPO}\`

A DeepSeek Harness plugin that brings a one-click **prompt enhancer** to the composer: a rough draft becomes a
clearer, more specific prompt without changing the ask, with one-click revert (the revert entry disappears as soon
as you type over the result).

- Repo: https://github.com/${OWNER}/${REPO}
- Kind: UI plugin (\`conversation.input.right\` slot) + host-side HTTP API + \`enhance_prompt\` agent tool
- Requirements met: \`dsh.bundle.patch\` declared (installable), topic \`dsh-plugin\` set, MIT licensed
- Extras: ships the two prompt constants it was derived from (reverse-engineered for interoperability) and an
  A/B report (\`docs/compare-report.md\`) showing the default prompt scoring 23.69 vs 22.13 over 12 cases × 5 judge passes.

**Note:** the repository was created on the same day as this PR. If the automated check requires a repo age of at
least one day, please re-run it tomorrow — the branch does not need any change.`;

const pr = await gh(`/repos/${UPSTREAM}/${UREPO}/pulls`, {
  method: 'POST',
  body: {
    title: `Add ${OWNER}/${REPO} — one-click prompt enhancer for the composer`,
    head: `${OWNER}:${ready.default_branch}`,
    base: 'main',
    body: prBody,
    maintainer_can_modify: true,
  },
});
if (pr.ok) {
  console.log(`\nPR #${pr.json.number}: ${pr.json.html_url}`);
} else {
  console.error('PR failed', pr.status, pr.text.slice(0, 500));
  process.exit(1);
}
