// 读取系统里已存在的 GitHub 凭据（git-credential-manager），不打印明文。
import { spawnSync } from 'node:child_process';

export function gitCredential(host = 'github.com') {
  const p = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${host}\n\n`,
    encoding: 'utf8',
  });
  const text = `${p.stdout || ''}${p.stderr || ''}`;
  const grab = (k) => {
    const m = text.match(new RegExp(`^${k}=(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  return { username: grab('username'), password: grab('password'), raw: text };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const c = gitCredential();
  console.log('username:', c.username || '(none)');
  console.log('token kind:', c.password ? (c.password.startsWith('ghp_') ? 'classic PAT' : c.password.startsWith('github_pat_') ? 'fine-grained PAT' : c.password.startsWith('gho_') ? 'OAuth' : `other(${c.password.length} chars)`) : '(none)');
}
