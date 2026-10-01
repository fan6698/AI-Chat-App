/**
 * 对话代理（Vercel Serverless Function，Node runtime）
 *
 * 作用：API Key 只存在于服务端环境变量，浏览器不再直连智谱，
 * 也就不会被打进前端产物里被人翻走。
 *
 * 部署时在平台配置环境变量 ZHIPU_API_KEY（注意没有 VITE_ 前缀，
 * 有 VITE_ 前缀的变量会被打包进前端，等于没藏）。
 */

const UPSTREAM_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const DEFAULT_MODEL = 'glm-4-flash'

/** 简单的入参上限，避免接口被拿来滥用 */
const MAX_MESSAGES = 50
const MAX_TOTAL_CHARS = 20000

interface ProxyRequest {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

interface ProxyResponse {
  statusCode: number
  setHeader: (key: string, value: string) => void
  writeHead: (status: number, headers?: Record<string, string>) => void
  write: (chunk: Uint8Array | string) => void
  end: (chunk?: string) => void
}

interface ChatMessagePayload {
  role: string
  content: string
}

function readBody(req: ProxyRequest): unknown {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)
    } catch {
      return null
    }
  }
  return req.body
}

/** 校验并清洗前端传来的消息，返回 null 表示不合法 */
function normalizeMessages(value: unknown): ChatMessagePayload[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (value.length > MAX_MESSAGES) return null

  const total = value.reduce((sum, item) => sum + String(item?.content ?? '').length, 0)
  if (total > MAX_TOTAL_CHARS) return null

  const messages: ChatMessagePayload[] = []
  for (const item of value) {
    const role = item?.role
    const content = item?.content
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      return null
    }
    if (!content.trim()) return null
    messages.push({ role, content })
  }

  return messages
}

/** 允许最长运行 60 秒，保证长回答不会被平台提前掐断 */
export const config = { maxDuration: 60 }

export default async function handler(req: ProxyRequest, res: ProxyResponse) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('Allow', 'POST')
    res.end(JSON.stringify({ error: { message: '仅支持 POST 请求' } }))
    return
  }

  const apiKey = process.env.ZHIPU_API_KEY?.trim()
  if (!apiKey) {
    res.statusCode = 500
    res.end(
      JSON.stringify({
        error: { message: '服务端未配置 ZHIPU_API_KEY，请在部署平台的环境变量中设置' },
      }),
    )
    return
  }

  const body = readBody(req) as { messages?: unknown; model?: unknown; temperature?: unknown }
  const messages = normalizeMessages(body?.messages)
  if (!messages) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: { message: '消息内容不合法' } }))
    return
  }

  const model =
    (typeof body?.model === 'string' && body.model.trim()) || process.env.ZHIPU_MODEL || DEFAULT_MODEL

  let upstream: Response
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
    res.statusCode = 502
    res.end(JSON.stringify({ error: { message: '无法连接 AI 服务，请稍后重试' } }))
    return
  }

  if (!upstream.ok || !upstream.body) {
    let message = `AI 服务返回错误（HTTP ${upstream.status}）`
    try {
      const errorBody = (await upstream.json()) as { error?: { message?: string } }
      if (errorBody.error?.message) message = errorBody.error.message
    } catch {
      // 上游返回的不是 JSON，用默认提示
    }
    res.statusCode = upstream.ok ? 502 : upstream.status
    res.end(JSON.stringify({ error: { message } }))
    return
  }

  // 原样透传 SSE 字节流，前端的解析逻辑完全不用改
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
    res.end()
  } catch {
    // 客户端断开或写写出错时结束响应，避免函数挂住
    res.end()
  }
}
