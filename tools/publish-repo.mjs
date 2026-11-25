// 把插件目录发布成一个公开 GitHub 仓库（单 commit，走 Git Data API，不需要 git push 通路）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gh } from './gh-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'tong174';
const REPO = 'dsh-enhance-prompt';
const DESC = "One-click prompt enhancer for DeepSeek Harness — reverse-engineered and benchmarked against WorkBuddy's Enhance prompt.";
const TOPICS = ['dsh-plugin', 'deepseek-harness', 'deepseek', 'prompt-engineering', 'prompt', 'llm', 'ui-plugin'];

const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'out', 'received']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(abs, rel));
    } else if (!SKIP_FILES.has(entry.name)) {
      out.push({ rel, abs, size: fs.statSync(abs).size });
    }
  }
  return out;
}

const files = walk(ROOT).sort((a, b) => a.rel.localeCompare(b.rel));
console.log(`files: ${files.length}, total ${(files.reduce((n, f) => n + f.size, 0) / 1024).toFixed(1)} KB`);

// 1. 建仓库（已存在就复用；空仓库调 git/blobs 会 409，所以先要有一个初始 commit）
const created = await gh('/user/repos', {
  method: 'POST',
  body: { name: REPO, description: DESC, private: false, has_issues: true, has_wiki: false, auto_init: true },
});
if (created.status === 422) {
  console.log('repo already exists, reusing');
} else if (!created.ok) {
  console.error('create repo failed', created.status, created.text.slice(0, 400));
  process.exit(1);
}

// 2. 确保默认分支有 commit
let head = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/main`);
if (!head.ok) {
  console.log('no main ref yet, seeding initial commit');
  const seed = await gh(`/repos/${OWNER}/${REPO}/contents/.gitkeep`, {
    method: 'PUT',
    body: { message: 'chore: init', content: Buffer.from(' ').toString('base64'), branch: 'main' },
  });
  if (!seed.ok) {
    console.error('seed failed', seed.status, seed.text.slice(0, 300));
    process.exit(1);
  }
  head = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/main`);
  if (!head.ok) {
    console.error('still no ref', head.status, head.text.slice(0, 300));
    process.exit(1);
  }
}
const parentSha = head.json.object.sha;
console.log('parent commit', parentSha);

// 3. 上传 blobs → tree → commit → 更新 ref
const tree = [];
for (const f of files) {
  const blob = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: { content: fs.readFileSync(f.abs).toString('base64'), encoding: 'base64' },
  });
  if (!blob.ok) {
    console.error('blob failed', f.rel, blob.status, blob.text.slice(0, 200));
    process.exit(1);
  }
  tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.json.sha });
}
console.log(`blobs: ${tree.length}`);

const treeRes = await gh(`/repos/${OWNER}/${REPO}/git/trees`, { method: 'POST', body: { tree } });
if (!treeRes.ok) {
  console.error('tree failed', treeRes.status, treeRes.text.slice(0, 300));
  process.exit(1);
}

const message = `feat: dsh-enhance-prompt v0.4.0

Adversarial audit and rebuild. Fixes seven real defects found by reading the code against
the actual DSH adapter contract, the worst of which made the route resolver useless:
llm.listModels() is async, so every provider was treated as model-less and every call
first tried a route with an empty model name.

Also: selftest is now POST-only and rate limited, promptStyle has one source of truth,
the request handler has a total time budget, repeated clicks are idempotent, and the
HTTP surface rejects cross-origin callers. 14 unit + 7 contract tests. See docs/audit-v0.4.md.`;

const commit = await gh(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: { message, tree: treeRes.json.sha, parents: [parentSha] },
});
if (!commit.ok) {
  console.error('commit failed', commit.status, commit.text.slice(0, 300));
  process.exit(1);
}
console.log('commit', commit.json.sha);

const upd = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
  method: 'PATCH',
  body: { sha: commit.json.sha, force: true },
});
console.log('ref update', upd.status, upd.ok ? '' : upd.text.slice(0, 200));

// 4. 元数据 + topics
const patchRepo = await gh(`/repos/${OWNER}/${REPO}`, {
  method: 'PATCH',
  body: {
    description: DESC,
    homepage: `https://github.com/${OWNER}/${REPO}`,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
  },
});
console.log('patch repo', patchRepo.status);

const topics = await gh(`/repos/${OWNER}/${REPO}/topics`, {
  method: 'PUT',
  body: { names: TOPICS },
});
console.log('topics', topics.status, topics.ok ? (topics.json?.names || []).join(',') : topics.text.slice(0, 200));

console.log(`\nrepo: https://github.com/${OWNER}/${REPO}`);
