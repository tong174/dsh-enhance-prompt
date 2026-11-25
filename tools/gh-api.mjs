// 极小的 GitHub API 客户端：token 从 git 凭据或 GH_TOKEN 读，不落盘。
import { gitCredential } from './gh-credential.mjs';

export function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const c = gitCredential();
  if (!c.password) throw new Error('no GitHub credential found');
  return c.password;
}

export async function gh(pathname, { method = 'GET', body, token, accept = 'application/vnd.github+json' } = {}) {
  const t = token || resolveToken();
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${t}`,
      accept,
      'user-agent': 'dsh-enhance-prompt-publisher',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, json, text, scopes: res.headers.get('x-oauth-scopes') };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const me = await gh('/user');
  console.log('status', me.status, 'login', me.json?.login, 'scopes', me.scopes);
  if (!me.ok) console.log(me.text.slice(0, 300));
  const repo = await gh('/repos/tong174/dsh-enhance-prompt');
  console.log('repo exists?', repo.status);
}
