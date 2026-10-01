import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'

const projectRoot = process.cwd()
const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhipu-env-'))
fs.writeFileSync(
  path.join(envDir, '.env'),
  'VITE_ZHIPU_API_KEY=sk-unit-test\nVITE_ZHIPU_MODEL=glm-4-flash\n',
)

const server = await createServer({
  root: projectRoot,
  envDir,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

const api = await server.ssrLoadModule('/src/api.ts')

function textStreamResponse(text, status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

let lastInit = null
let lastUrl = null
globalThis.fetch = async (url, init) => {
  lastUrl = url
  lastInit = init
  return globalThis.__nextResponse()
}

async function collect(messages, sseText, status = 200) {
  globalThis.__nextResponse = () => textStreamResponse(sseText, status)
  const parts = []
  for await (const delta of api.streamChatCompletion(messages)) parts.push(delta)
  return parts.join('')
}

const messages = [{ role: 'user', content: 'hi', timestamp: 1 }]
const results = []

// 1. 正常流式：跨多次网络分片、中途被截断
const sse =
  'data: {"id":"1","choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"，我是"}}]}\n\ndata: {"choices":[{"delta":{"content":"助手"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"。"},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n'
const full = await collect(messages, sse)
assert.equal(full, '你好，我是助手。', '流式增量拼接不正确')
results.push('正常流式拼接 OK')

// 2. 网络分片打散（含半个 JSON 被切断的场景）
globalThis.__nextResponse = () =>
  textStreamResponse(
    'data: {"choices":[{"delta":{"content":"拆分"}}]}\n\ndata: {"choices":[{"del',
  )
{
  const streamer = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      // 故意把一条 SSE 消息从中间劈开，横跨两次网络读取
      controller.enqueue(
        enc.encode('data: {"choices":[{"delta":{"content":"拆分"}}]}\n\ndata: {"choices":[{"del'),
      )
      controller.enqueue(enc.encode('ta":{"content":"测试"}}]}\n\n'))
      controller.enqueue(enc.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  globalThis.fetch = async () => new Response(streamer, { status: 200 })
  let out = ''
  for await (const delta of api.streamChatCompletion(messages)) out += delta
  assert.equal(out, '拆分测试', '跨网络分片的 SSE 未按缓冲正确重组')
  results.push('跨分片缓冲重组 OK')
  globalThis.fetch = async (url, init) => {
    lastUrl = url
    lastInit = init
    return globalThis.__nextResponse()
  }
}

// 3. CRLF 换行兼容
const crlf = sse.replace(/\n\n/g, '\r\n\r\n')
assert.equal(await collect(messages, crlf), '你好，我是助手。', 'CRLF 换行未兼容')
results.push('CRLF 换行兼容 OK')

// 4. [DONE] 之后的垃圾数据应被忽略
const trailing = sse + 'data: {"choices":[{"delta":{"content":"多余"}}]}\n\n'
assert.equal(await collect(messages, trailing), '你好，我是助手。', '未正确终止于 [DONE]')
results.push('[DONE] 正确终止 OK')

// 5. HTTP 401 应给出友好提示
globalThis.__nextResponse = () =>
  new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
await assert.rejects(
  async () => {
    for await (const _ of api.streamChatCompletion(messages)) void _
  },
  (err) => {
    assert.equal(err.name, 'ChatApiError')
    assert.match(err.message, /API Key 无效/)
    assert.equal(err.status, 401)
    return true
  },
)
results.push('401 友好报错 OK')

// 6. 请求体：必须开启 stream 且带上完整历史
assert.equal(lastInit.method, 'POST')
const body = JSON.parse(lastInit.body)
assert.equal(body.stream, true, '未开启 stream')
assert.equal(body.model, 'glm-4-flash')
assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
assert.equal(lastInit.headers.Authorization, 'Bearer sk-unit-test')
assert.equal(lastInit.signal, undefined, '未传 signal 时不应携带')
results.push('请求体/Bearer/多轮历史 OK')

// 6b. 传入 signal 时应透传给 fetch
{
  const controller = new AbortController()
  globalThis.__nextResponse = () => textStreamResponse('data: [DONE]\n\n')
  let seen = []
  for await (const d of api.streamChatCompletion(messages, { signal: controller.signal }))
    seen.push(d)
  assert.equal(lastInit.signal, controller.signal, 'signal 未透传')
  results.push('signal 透传 OK')
}

// 7. AbortSignal 中断
const controller = new AbortController()
controller.abort()
globalThis.fetch = async () => {
  throw new DOMException('aborted', 'AbortError')
}
await assert.rejects(
  async () => {
    for await (const _ of api.streamChatCompletion(messages, { signal: controller.signal })) void _
  },
  (err) => err.name === 'AbortError',
)
results.push('中断信号透传 OK')

// 还原被上面替换掉的 fetch，否则会污染后续用例
globalThis.fetch = async (url, init) => {
  lastUrl = url
  lastInit = init
  return globalThis.__nextResponse()
}

// 8. 未配置 VITE_ZHIPU_API_KEY 时自动走服务端代理（部署模式的默认行为）
{
  const proxyEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'zhipu-proxy-'))
  // 只放一个无关变量，确保没有 VITE_ZHIPU_API_KEY
  fs.writeFileSync(path.join(proxyEnv, '.env'), 'OTHER_FLAG=1\n')
  const s2 = await createServer({
    root: projectRoot,
    envDir: proxyEnv,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  })
  const api2 = await s2.ssrLoadModule('/src/api.ts')

  globalThis.__nextResponse = () =>
    textStreamResponse(
      'data: {"choices":[{"delta":{"content":"代理回答"}}]}\n\ndata: [DONE]\n\n',
    )

  let out = ''
  for await (const delta of api2.streamChatCompletion(messages)) out += delta

  assert.equal(out, '代理回答', '代理模式下未能正确解析 SSE')
  assert.equal(lastUrl, '/api/chat', `代理模式下应请求 /api/chat，实际 ${lastUrl}`)
  assert.equal(lastInit.headers.Authorization, undefined, '前端不应携带 Key')
  const proxyBody = JSON.parse(lastInit.body)
  assert.deepEqual(proxyBody.messages, [{ role: 'user', content: 'hi' }])
  await s2.close()
  results.push('无 Key 时自动走 /api/chat 代理 OK')
}

console.log(results.map((r) => '  ✓ ' + r).join('\n'))
console.log(`\n全部 ${results.length} 项通过`)

await server.close()
