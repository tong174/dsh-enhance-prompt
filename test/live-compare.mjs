// 线上验证：直接打插件自己的 HTTP 接口，看默认（enhanced）与 workbuddy 两种风格的实际输出。
// 用法：node test/live-compare.mjs
const BASE = 'http://127.0.0.1:12578/dsh-enhance-prompt'

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, text }
  }
}

const samples = ['帮我写个周报', '这段代码有 bug，can you help me fix it?', 'make my site faster']

for (const text of samples) {
  const { status, json } = await post('/enhance', { text })
  console.log(`\n=== ${JSON.stringify(text)}  HTTP ${status}`)
  if (json?.success) {
    console.log(`[${json.provider}/${json.model}]`)
    console.log(json.text)
  } else {
    console.log('FAILED', JSON.stringify(json))
  }
}
