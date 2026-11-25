import { gh } from './gh-api.mjs';

const runs = await gh('/repos/awesome-dsh-plugin/awesome-dsh-plugin/actions/runs?per_page=5');
if (runs.ok) {
  for (const r of runs.json.workflow_runs) {
    console.log(`${r.name} #${r.run_number} ${r.status}/${r.conclusion} event=${r.event} head=${r.head_branch} started=${r.run_started_at}`);
  }
} else {
  console.log('runs failed', runs.status, runs.text.slice(0, 200));
}

const cr = await gh('/repos/awesome-dsh-plugin/awesome-dsh-plugin/commits/main/check-runs');
console.log('\nmain check runs:', (cr.json?.check_runs || []).map((c) => `${c.name}:${c.status}/${c.conclusion}`).join(',') || '(none)');

// 我们的 PR 分支上的文件是否就位
const f = await gh('/repos/tong174/awesome-dsh-plugin/contents/data/plugins/tong174__dsh-enhance-prompt.yml');
console.log('\nentry on fork:', f.status);
if (f.ok) console.log(Buffer.from(f.json.content, 'base64').toString('utf8'));
