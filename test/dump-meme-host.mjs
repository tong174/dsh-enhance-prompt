import fs from 'node:fs'
const p = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-meme/index.js'
const s = fs.readFileSync(p, 'utf8')
for (const needle of ['dsh-memes-api', 'webServer', 'route(', 'addRoute', 'app.get', 'app.post']) {
  let k = -1
  let c = 0
  console.log('##### ' + needle)
  while ((k = s.indexOf(needle, k + 1)) >= 0 && c < 4) {
    c++
    console.log('--- @' + k, s.slice(Math.max(0, k - 320), k + 320).replace(/\n/g, ' ⏎ '))
  }
}
