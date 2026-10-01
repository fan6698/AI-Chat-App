import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

const { default: onRequest } = await server.ssrLoadModule('/cloud-functions/api/chat.js')

const URL_ = 'https://example.com/api/chat'

/** 用真实的 Request 对象，贴近线上运行环境 */
function makeRequest(method, body) {
  return new Request(URL_, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** 分两次推送的 SSE 上游，用于验证流式是否被原样透传 */
function sseUpstream(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

const results = []
let lastUpstreamInit = null
globalThis.fetch = async (_url, init) => {
  lastUpstreamInit = init
  return globalThis.__upstream()
}

async function call(options) {
  const response = await onRequest(options)
  const text = await response.text()
  return { response, text }
}

// 1. 仅允许 POST
{
  const { response, text } = await call({ request: makeRequest('GET'), env: {} })
  assert.equal(response.status, 405)
  assert.match(text, /仅支持 POST/)
  assert.equal(response.headers.get('Allow'), 'POST')
  results.push('非 POST 返回 405 OK')
}

// 2. 未配置 Key
{
  const { response, text } = await call({
    request: makeRequest('POST', { messages: [{ role: 'user', content: 'hi' }] }),
    env: {},
  })
  assert.equal(response.status, 500)
  assert.match(text, /ZHIPU_API_KEY/)
  results.push('未配置 Key 返回 500 并提示 OK')
}

// 3. 非法入参一律 400
{
  const env = { ZHIPU_API_KEY: 'sk-server-side-test' }
  const badBodies = [
    { messages: [] },
    { messages: 'not-an-array' },
    { messages: [{ role: 'system', content: '注入角色' }] },
    { messages: [{ role: 'user', content: '   ' }] },
    { messages: Array.from({ length: 51 }, () => ({ role: 'user', content: 'x' })) },
    { messages: [{ role: 'user', content: 'x'.repeat(20001) }] },
  ]
  for (const body of badBodies) {
    const { response } = await call({ request: makeRequest('POST', body), env })
    assert.equal(response.status, 400, `本应 400 却被放行: ${JSON.stringify(body).slice(0, 50)}`)
  }
  // 非 JSON 的请求体
  const badRequest = new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  })
  const { response } = await call({ request: badRequest, env })
  assert.equal(response.status, 400)
  results.push(`非法入参拦截 OK（${badBodies.length + 1} 种）`)
}

// 4. 正常转发：Key 来自 env、SSE 原样透传
{
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n',
  ]
  globalThis.__upstream = () => sseUpstream(chunks)

  const { response, text } = await call({
    request: makeRequest('POST', { messages: [{ role: 'user', content: '打个招呼' }] }),
    env: { ZHIPU_API_KEY: 'sk-server-side-test' },
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type'), /text\/event-stream/)
  assert.equal(text, chunks.join(''), 'SSE 字节流未被原样透传')

  assert.equal(lastUpstreamInit.headers.Authorization, 'Bearer sk-server-side-test')
  const upstreamBody = JSON.parse(lastUpstreamInit.body)
  assert.equal(upstreamBody.stream, true)
  assert.deepEqual(upstreamBody.messages, [{ role: 'user', content: '打个招呼' }])
  results.push('正常转发 + Key 服务端注入 OK')
}

// 5. 上游错误透传
{
  globalThis.__upstream = () =>
    new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  const { response, text } = await call({
    request: makeRequest('POST', { messages: [{ role: 'user', content: 'hi' }] }),
    env: { ZHIPU_API_KEY: 'sk-test' },
  })
  assert.equal(response.status, 401)
  assert.match(text, /invalid api key/)
  results.push('上游错误透传 OK')
}

// 6. 上游不可达
{
  globalThis.__upstream = () => {
    throw new Error('network down')
  }
  const { response, text } = await call({
    request: makeRequest('POST', { messages: [{ role: 'user', content: 'hi' }] }),
    env: { ZHIPU_API_KEY: 'sk-test' },
  })
  assert.equal(response.status, 502)
  assert.match(text, /无法连接 AI 服务/)
  results.push('上游不可达返回 502 OK')
}

// 7. 支持用 ZHIPU_MODEL 指定模型
{
  globalThis.__upstream = () => sseUpstream(['data: [DONE]\n\n'])
  await call({
    request: makeRequest('POST', { messages: [{ role: 'user', content: 'hi' }] }),
    env: { ZHIPU_API_KEY: 'sk-test', ZHIPU_MODEL: 'glm-4.7' },
  })
  assert.equal(JSON.parse(lastUpstreamInit.body).model, 'glm-4.7')
  results.push('ZHIPU_MODEL 生效 OK')
}

console.log(results.map((r) => '  ✓ ' + r).join('\n'))
console.log(`\n全部 ${results.length} 项通过`)

await server.close()
