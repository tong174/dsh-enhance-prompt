import fs from 'node:fs'
const p = 'D:/dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'
const s = fs.readFileSync(p, 'utf8')
let k = s.indexOf('this.exact.get')
if (k < 0) k = s.indexOf('.exact.get(')
console.log('exact.get at', k)
console.log(s.slice(Math.max(0, k - 1500), k + 1500))
