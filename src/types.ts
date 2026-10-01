/** 消息发送方：用户或 AI 助手 */
export type MessageRole = 'user' | 'assistant'

/** 一条对话消息 */
export interface Message {
  role: MessageRole
  content: string
  timestamp: number
}

/** 创建新消息，timestamp 默认为当前时间 */
export function createMessage(role: MessageRole, content: string): Message {
  return { role, content, timestamp: Date.now() }
}
