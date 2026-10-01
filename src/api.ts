import type { Message } from './types'

/** 官方 Chat Completions 接口前缀，仅在"直连模式"下使用 */
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
/** 默认模型，直连模式下可通过环境变量覆盖；代理模式下由服务端决定 */
const DEFAULT_MODEL = 'glm-4-flash'
/** 默认的服务端代理地址（与前端同源，部署后由平台提供该函数） */
const DEFAULT_PROXY_ENDPOINT = '/api/chat'
/** SSE 流结束标志 */
const DONE_FLAG = '[DONE]'

/** 对话接口抛出的错误，message 为可直接展示给用户的文案 */
export class ChatApiError extends Error {
  readonly status?: number
  readonly code?: string

  constructor(
    message: string,
    options: { status?: number; code?: string } = {},
  ) {
    super(message)
    this.name = 'ChatApiError'
    this.status = options.status
    this.code = options.code
  }
}

export interface StreamChatOptions {
  /** 用于中断请求（例如用户点击"停止生成"） */
  signal?: AbortSignal
  /** 覆盖环境变量中的模型 */
  model?: string
  /** 采样温度，取值 (0, 1] */
  temperature?: number
}

interface ChatCompletionChunk {
  id?: string
  choices?: Array<{
    delta?: { content?: string | null }
    finish_reason?: string | null
  }>
  error?: { code?: string; message?: string }
}

/**
 * 两种运行模式：
 * - 直连模式：设置了 VITE_ZHIPU_API_KEY，浏览器带着 Key 直接请求智谱。
 *   仅适合本地开发——带 VITE_ 前缀的变量会被打包进前端产物，部署后 Key 对访问者可见。
 * - 代理模式（部署默认）：不设置 VITE_ZHIPU_API_KEY，改为请求同源的 /api/chat，
 *   由服务端函数持有 Key。公网部署必须走这条。
 */
function isDirectMode(): boolean {
  return Boolean(import.meta.env.VITE_ZHIPU_API_KEY?.trim())
}

/** 读取直连模式下的 API Key */
function getApiKey(): string {
  return import.meta.env.VITE_ZHIPU_API_KEY?.trim() ?? ''
}

/** 将 HTTP 状态码转换为用户能看懂的提示 */
function describeHttpError(status: number, serverMessage?: string): ChatApiError {
  const map: Record<number, string> = {
    400: '请求参数有误，请检查消息内容',
    401: 'API Key 无效或已过期，请检查部署平台的环境变量配置',
    403: '当前 API Key 没有该模型的访问权限',
    404: '请求的接口地址不存在，请确认代理地址或 VITE_ZHIPU_BASE_URL 配置正确',
    429: '请求过于频繁或额度不足，请稍后再试',
  }

  const message =
    map[status] ??
    (status >= 500 ? 'AI 服务暂时不可用，请稍后再试' : `请求失败（HTTP ${status}）`)

  return new ChatApiError(serverMessage ? `${message}：${serverMessage}` : message, {
    status,
  })
}

/**
 * 逐块读取 SSE 事件。每次 yield 一个完整的 event（可能包含多行）。
 * 兼容 \r\n 换行，并在流结束时冲刷剩余缓冲，避免丢掉最后一块。
 */
async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

      let separator = buffer.indexOf('\n\n')
      while (separator !== -1) {
        const event = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        if (event.trim()) yield event
        separator = buffer.indexOf('\n\n')
      }
    }

    const tail = buffer.trim()
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

/**
 * 流式调用智谱 AI 对话接口，按 token 增量产出文本内容。
 *
 * @example
 * for await (const delta of streamChatCompletion(messages)) {
 *   setAnswer((prev) => prev + delta)
 * }
 */
export async function* streamChatCompletion(
  messages: Message[],
  options: StreamChatOptions = {},
): AsyncGenerator<string, void, void> {
  const direct = isDirectMode()
  const apiKey = getApiKey()
  const baseUrl = import.meta.env.VITE_ZHIPU_BASE_URL?.trim() || DEFAULT_BASE_URL
  const proxyEndpoint =
    import.meta.env.VITE_CHAT_ENDPOINT?.trim() || DEFAULT_PROXY_ENDPOINT
  const model = options.model ?? import.meta.env.VITE_ZHIPU_MODEL?.trim() ?? DEFAULT_MODEL

  const payload = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }))

  if (payload.length === 0) {
    throw new ChatApiError('没有可发送的消息', { code: 'empty_messages' })
  }

  if (!direct && !proxyEndpoint) {
    throw new ChatApiError('未配置 API Key，也未配置代理地址，无法发起请求', {
      code: 'missing_api_key',
    })
  }

  // 代理模式由服务端决定模型，前端不传 temperature 等参数，避免被随意覆盖
  const body = JSON.stringify(
    direct
      ? {
          model,
          messages: payload,
          stream: true,
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        }
      : { messages: payload, model },
  )

  let response: Response
  try {
    response = await fetch(direct ? `${baseUrl}/chat/completions` : proxyEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(direct ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
      signal: options.signal,
    })
  } catch (error) {
    // 用户主动中断，交由调用方按 AbortError 处理
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ChatApiError('网络连接失败，请检查网络后重试', { code: 'network_error' })
  }

  if (!response.ok) {
    let serverMessage: string | undefined
    try {
      const errorBody = (await response.json()) as { error?: { message?: string } }
      serverMessage = errorBody.error?.message
    } catch {
      // 响应体不是 JSON 时忽略，使用默认提示
    }
    throw describeHttpError(response.status, serverMessage)
  }

  if (!response.body) {
    throw new ChatApiError('当前环境不支持流式响应', { code: 'no_stream_body' })
  }

  for await (const event of readSseEvents(response.body)) {
    for (const line of event.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue

      const data = trimmed.slice(5).trim()
      if (!data) continue
      if (data === DONE_FLAG) return

      let chunk: ChatCompletionChunk
      try {
        chunk = JSON.parse(data) as ChatCompletionChunk
      } catch {
        throw new ChatApiError('AI 返回了无法解析的内容，请稍后重试', {
          code: 'invalid_json',
        })
      }

      if (chunk.error) {
        throw new ChatApiError(chunk.error.message ?? 'AI 服务返回错误', {
          code: chunk.error.code,
        })
      }

      const delta = chunk.choices?.[0]?.delta?.content
      if (delta) yield delta
    }
  }
}

/**
 * 回调式封装：拿到一次完整回答，同时实时接收增量文本。
 * 适合不想直接处理 async generator 的场景。
 *
 * @returns AI 的完整回答文本
 */
export async function requestChatStream(
  messages: Message[],
  callbacks: {
    onDelta: (delta: string) => void
    signal?: AbortSignal
    model?: string
    temperature?: number
  },
): Promise<string> {
  let answer = ''

  for await (const delta of streamChatCompletion(messages, {
    signal: callbacks.signal,
    model: callbacks.model,
    temperature: callbacks.temperature,
  })) {
    answer += delta
    callbacks.onDelta(delta)
  }

  return answer
}
