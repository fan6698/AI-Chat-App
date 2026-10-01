import type { Message } from './types'

/**
 * 存储 key 带版本号：以后 Message 结构变了改版本号，
 * 老数据自然失效，避免反序列化出脏数据导致页面渲染异常。
 */
const STORAGE_KEY = 'ai-chat-assistant:messages:v1'

/** 本地存储不可用时（隐私模式、超配额）静默降级，不影响聊天主流程 */
function getSafeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** 逐条校验，脏数据直接丢弃而不是让整个列表报废 */
function isValidMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Record<string, unknown>

  return (
    (candidate.role === 'user' || candidate.role === 'assistant') &&
    typeof candidate.content === 'string' &&
    candidate.content.trim().length > 0 &&
    typeof candidate.timestamp === 'number' &&
    Number.isFinite(candidate.timestamp)
  )
}

/** 读取本地对话历史，无数据或数据损坏时返回空数组 */
export function loadMessages(): Message[] {
  try {
    const raw = getSafeStorage()?.getItem(STORAGE_KEY)
    if (!raw) return []

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.filter(isValidMessage)
  } catch {
    return []
  }
}

/** 写入对话历史。跳过空内容的占位气泡，不把半成品存进去 */
export function saveMessages(messages: Message[]): void {
  try {
    const valid = messages.filter(isValidMessage)
    getSafeStorage()?.setItem(STORAGE_KEY, JSON.stringify(valid))
  } catch {
    // 超配额或不可用时忽略，聊天本身不受影响
  }
}

/** 清空本地对话历史 */
export function clearMessages(): void {
  try {
    getSafeStorage()?.removeItem(STORAGE_KEY)
  } catch {
    // 同上
  }
}
