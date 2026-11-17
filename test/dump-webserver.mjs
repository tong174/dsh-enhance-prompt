import fs from 'node:fs'
const p = 'D:/dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'
const s = fs.readFileSync(p, 'utf8')
for (const needle of ['401', '403', 'authorize', 'auth', 'register(', 'prefix', 'fallback']) {
  let k = -1
  let c = 0
  console.log('##### ' + needle)
  while ((k = s.indexOf(needle, k + 1)) >= 0 && c < 3) {
    c++
    console.log('--- @' + k, s.slice(Math.max(0, k - 260), k + 300).replace(/\n/g, ' ⏎ '))
  }
}
