/**
 * 对话代理（EdgeOne Pages · Cloud Functions，Node.js 运行时）
 *
 * 路由：cloud-functions/api/chat.js → /api/chat
 * 签名：export default function onRequest(context)
 *   context.request  客户端请求（Web 标准 Request）
 *   context.env      Pages 控制台配置的环境变量（ZHIPU_API_KEY 在这里）
 *
 * 之所以选 Cloud Functions 而不是 Edge Functions：AI 回答是长连接流式响应，
 * Cloud Functions 的 Node.js 运行时运行时间更长，不容易被中途掐断。
 *
 * 说明：本文件与 Vercel 版 api/chat.ts 功能等价，但签名不同（两平台约定不一样）。
 * 修改转发逻辑时，两边都要同步改。
 */

const UPSTREAM_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const DEFAULT_MODEL = 'glm-4-flash'

/** 入参上限，避免接口被滥用 */
const MAX_MESSAGES = 50
const MAX_TOTAL_CHARS = 20000

const JSON_HEADERS = { 'content-type': 'application/json; charset=UTF-8' }

function jsonResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: JSON_HEADERS,
  })
}

/** 校验并清洗消息，返回 null 表示不合法 */
function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length === 0) return null
  if (value.length > MAX_MESSAGES) return null

  const total = value.reduce((sum, item) => sum + String(item?.content ?? '').length, 0)
  if (total > MAX_TOTAL_CHARS) return null

  const messages = []
  for (const item of value) {
    const role = item?.role
    const content = item?.content
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null
    if (!content.trim()) return null
    messages.push({ role, content })
  }

  return messages
}

export default async function onRequest(context) {
  const request = context?.request
  const env = context?.env ?? {}

  if (!request) return jsonResponse(500, '函数入参缺少 request')

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: '仅支持 POST 请求' } }), {
      status: 405,
      headers: { ...JSON_HEADERS, Allow: 'POST' },
    })
  }

  // Key 只存在于服务端环境变量，不会被打包进前端
  const apiKey = String(env.ZHIPU_API_KEY ?? '').trim()
  if (!apiKey) {
    return jsonResponse(500, '服务端未配置 ZHIPU_API_KEY，请在 EdgeOne Pages 控制台的环境变量中设置')
  }

  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse(400, '请求体不是合法的 JSON')
  }

  const messages = normalizeMessages(body?.messages)
  if (!messages) return jsonResponse(400, '消息内容不合法')

  const model =
    (typeof body?.model === 'string' && body.model.trim()) ||
    String(env.ZHIPU_MODEL ?? '').trim() ||
    DEFAULT_MODEL

  let upstream
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ model, messages, stream: true }),
    })
  } catch {
    return jsonResponse(502, '无法连接 AI 服务，请稍后重试')
  }

  if (!upstream.ok || !upstream.body) {
    let message = `AI 服务返回错误（HTTP ${upstream.status}）`
    try {
      const errorBody = await upstream.clone().json()
      if (errorBody?.error?.message) message = errorBody.error.message
    } catch {
      // 上游返回的不是 JSON，用默认提示
    }
    return jsonResponse(upstream.ok ? 502 : upstream.status, message)
  }

  // 把上游的 SSE 流直接作为响应体返回，前端解析逻辑不用改
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
