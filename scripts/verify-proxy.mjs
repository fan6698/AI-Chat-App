import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

const { default: handler } = await server.ssrLoadModule('/api/chat.ts')

/** 极简的 res 模拟，记录写出的字节与状态码 */
function mockRes() {
  const chunks = []
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    setHeader(k, v) {
      this.headers[k] = v
    },
    writeHead(status, headers) {
      this.statusCode = status
      Object.assign(this.headers, headers || {})
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk).toString('utf8'))
    },
    end(chunk) {
      if (chunk) chunks.push(String(chunk))
      this.ended = true
    },
    text: () => chunks.join(''),
    writeCount: () => chunks.length,
  }
}

function mockReq(method, body) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

/** 让上游返回一段 SSE 字节流，分两次推给代理，验证是否原样透传 */
function sseUpstream(events) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode(events[0]))
      controller.enqueue(enc.encode(events[1]))
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

// 1. 仅允许 POST
{
  const res = mockRes()
  await handler(mockReq('GET', { messages: [] }), res)
  assert.equal(res.statusCode, 405)
  assert.match(res.text(), /仅支持 POST/)
  results.push('非 POST 返回 405 OK')
}

// 2. 服务端未配置 Key 时给出明确提示
{
  delete process.env.ZHIPU_API_KEY
  const res = mockRes()
  await handler(mockReq('POST', { messages: [{ role: 'user', content: 'hi' }] }), res)
  assert.equal(res.statusCode, 500)
  assert.match(res.text(), /ZHIPU_API_KEY/, '缺少 Key 时未提示配置环境变量')
  results.push('未配置 Key 返回 500 并提示 OK')
}

// 3. 非法入参一律 400（这是防止接口被滥用的第一道闸）
{
  process.env.ZHIPU_API_KEY = 'sk-server-side-test'
  const badBodies = [
    { messages: [] },
    { messages: 'not-an-array' },
    { messages: [{ role: 'system', content: '注入角色' }] },
    { messages: [{ role: 'user', content: '   ' }] },
    { messages: Array.from({ length: 51 }, () => ({ role: 'user', content: 'x' })) },
    { messages: [{ role: 'user', content: 'x'.repeat(20001) }] },
    'not-json-at-all',
    {},
  ]
  for (const body of badBodies) {
    const res = mockRes()
    await handler(mockReq('POST', body), res)
    assert.equal(res.statusCode, 400, `本应 400 的入参却被放行: ${JSON.stringify(body).slice(0, 60)}`)
  }
  results.push(`非法入参拦截 OK（${badBodies.length} 种）`)
}

// 4. 正常转发：Key 留在服务端、SSE 原样透传
{
  const events = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n',
  ]
  globalThis.__upstream = () => sseUpstream(events)

  const res = mockRes()
  await handler(mockReq('POST', { messages: [{ role: 'user', content: '打个招呼' }] }), res)

  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Type'], /text\/event-stream/)
  assert.equal(res.text(), events.join(''), 'SSE 字节流未被原样透传')
  assert.ok(res.ended, '流结束后未调用 res.end')

  // 关键：Key 来自服务端环境变量，上游应收到 Bearer 头
  assert.equal(lastUpstreamInit.headers.Authorization, 'Bearer sk-server-side-test')
  const upstreamBody = JSON.parse(lastUpstreamInit.body)
  assert.equal(upstreamBody.stream, true)
  assert.deepEqual(upstreamBody.messages, [{ role: 'user', content: '打个招呼' }])
  results.push('正常转发 + Key 服务端注入 OK')
}

// 5. 上游错误：状态码与信息透传给前端
{
  globalThis.__upstream = () =>
    new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  const res = mockRes()
  await handler(mockReq('POST', { messages: [{ role: 'user', content: 'hi' }] }), res)
  assert.equal(res.statusCode, 401)
  assert.match(res.text(), /invalid api key/, '上游错误信息未透传')
  results.push('上游错误透传 OK')
}

// 6. 上游不可达
{
  globalThis.__upstream = () => {
    throw new Error('network down')
  }
  const res = mockRes()
  await handler(mockReq('POST', { messages: [{ role: 'user', content: 'hi' }] }), res)
  assert.equal(res.statusCode, 502)
  assert.match(res.text(), /无法连接 AI 服务/)
  results.push('上游不可达返回 502 OK')
}

console.log(results.map((r) => '  ✓ ' + r).join('\n'))
console.log(`\n全部 ${results.length} 项通过`)

await server.close()
