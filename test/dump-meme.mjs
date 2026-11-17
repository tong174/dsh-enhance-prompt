import fs from 'node:fs'
const p = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-meme/client.js'
const s = fs.readFileSync(p, 'utf8')
const idxs = []
let k = -1
while ((k = s.indexOf('fetch(', k + 1)) >= 0) idxs.push(k)
console.log('fetch count', idxs.length)
for (const j of idxs.slice(0, 8)) {
  console.log('--- @' + j)
  console.log(s.slice(Math.max(0, j - 260), j + 260).replace(/\n/g, ' ⏎ '))
}
