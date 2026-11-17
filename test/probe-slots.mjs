import { readFileSync } from 'node:fs'

const file = 'D:/dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'
const lines = readFileSync(file, 'utf8').split(/\r?\n/)
const needle = 'renderSlot("conversation.input'
lines.forEach((line, index) => {
  if (line.includes(needle)) console.log(`${index + 1}: ${line.trim().slice(0, 260)}`)
})
console.log('--- provide scopes ---')
lines.forEach((line, index) => {
  if (line.includes('uiSession.provide') || line.includes('scope:')) console.log(`${index + 1}: ${line.trim().slice(0, 260)}`)
})
