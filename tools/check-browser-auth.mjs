import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), 'dsh-cookie-check');
if (!fs.existsSync(dir)) { console.log('no dir'); process.exit(0); }

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.db'))) {
  try {
    const db = new DatabaseSync(path.join(dir, f), { readOnly: true });
    const rows = db.prepare('select host_key, count(*) as c from cookies group by host_key').all();
    const pick = (re) => rows.filter((r) => re.test(r.host_key));
    const gh = pick(/github/i);
    const npm = pick(/npmjs|registry\.npm/i);
    console.log(f, 'hosts=' + rows.length);
    console.log('  github:', gh.length ? JSON.stringify(gh) : 'NONE');
    console.log('  npmjs :', npm.length ? JSON.stringify(npm) : 'NONE');
    db.close();
  } catch (e) {
    console.log(f, 'ERR', e.message);
  }
}
