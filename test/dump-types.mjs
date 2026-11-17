import fs from 'node:fs'
const s = fs.readFileSync('D:/dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js', 'utf8')
const re = /"declaration":\s*"((?:[^"\\]|\\.)*)"/g
let m
const want = /interface GenerateOptions|interface LlmCallConfig|type FinishReason|interface TokenUsage/
while ((m = re.exec(s))) {
  let d = m[1]
  try { d = JSON.parse('"' + d + '"') } catch {}
  if (want.test(d)) { console.log('-----'); console.log(d.slice(0, 2200)) }
}
