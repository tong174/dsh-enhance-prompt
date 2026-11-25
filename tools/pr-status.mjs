import { gh } from './gh-api.mjs';

const pr = await gh('/repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls/16368');
console.log('PR', pr.json?.number, pr.json?.state, '| mergeable:', pr.json?.mergeable, '| state:', pr.json?.mergeable_state);
console.log('url:', pr.json?.html_url);

const headSha = pr.json?.head?.sha;
if (headSha) {
  const st = await gh(`/repos/awesome-dsh-plugin/awesome-dsh-plugin/commits/${headSha}/status`);
  console.log('combined status:', st.json?.state, (st.json?.statuses || []).map((s) => `${s.context}:${s.state}`).join(',') || '(none)');
  const cr = await gh(`/repos/awesome-dsh-plugin/awesome-dsh-plugin/commits/${headSha}/check-runs`);
  console.log('check runs:', (cr.json?.check_runs || []).map((c) => `${c.name}:${c.status}/${c.conclusion}`).join(',') || '(none)');
}

const comments = await gh('/repos/awesome-dsh-plugin/awesome-dsh-plugin/issues/16368/comments');
if (comments.ok && comments.json.length) {
  for (const c of comments.json) console.log(`\nCOMMENT[${c.user.login}] ${c.created_at}\n${c.body.slice(0, 800)}`);
} else {
  console.log('\nno comments yet');
}
