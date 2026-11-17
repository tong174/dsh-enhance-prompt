import fs from 'node:fs'
const p = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-meme/client.js'
const s = fs.readFileSync(p, 'utf8')
for (const needle of ['absAppPath', 'APP_BASE', 'appBase']) {
  let k = -1
  let n = 0
  while ((k = s.indexOf(needle, k + 1)) >= 0 && n < 4) {
    n++
    console.log('=== ' + needle + ' @' + k)
    console.log(s.slice(Math.max(0, k - 400), k + 400).replace(/\n/g, ' ⏎ '))
  }
}
