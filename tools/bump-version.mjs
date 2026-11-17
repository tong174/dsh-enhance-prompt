// 版本号同步：lib/index.js 里的 version 常量与 package.json 一起升到 0.3.0。
import fs from 'node:fs'

const target = process.argv[2] ?? '0.3.0'
let s = fs.readFileSync('lib/index.js', 'utf8')
s = s.replace(/version: '\d+\.\d+\.\d+'/g, `version: '${target}'`)
fs.writeFileSync('lib/index.js', s)

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
pkg.version = target
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

console.log('version ->', target, '| refs in index.js:', (s.match(new RegExp(`version: '${target}'`, 'g')) ?? []).length)
