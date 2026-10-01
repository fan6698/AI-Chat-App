import { memo } from 'react'
import Markdown from './Markdown'
import CopyButton from './CopyButton'
import type { Message } from '../types'

interface ChatMessageProps {
  message: Message
  /** 是否正在流式生成中（用于显示光标） */
  streaming?: boolean
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ChatMessage({ message, streaming }: ChatMessageProps) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* 头像 */}
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-xs font-medium text-white ${
          isUser ? 'bg-[#4a90e2]' : 'bg-[#07c160]'
        }`}
      >
        {isUser ? '我' : 'AI'}
      </div>

      {/* 气泡 */}
      <div className={`flex max-w-[72%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div className="relative">
          {/* 气泡小尾巴 */}
          <span
            className={`absolute top-3 h-3 w-3 rotate-45 ${
              isUser ? '-right-1 bg-[#95ec69]' : '-left-1 bg-white'
            }`}
          />
          <div
            className={`relative rounded-lg px-3 py-2 shadow-sm ${
              isUser
                ? 'bg-[#95ec69] text-slate-900'
                : 'bg-white text-slate-800 ring-1 ring-black/5'
            }`}
          >
            {isUser ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                {message.content}
              </p>
            ) : (
              <div className="relative">
                {streaming && !message.content ? (
                  <span className="flex h-5 items-center gap-1.5">
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
                    </span>
                    <span className="text-xs text-slate-400">思考中…</span>
                  </span>
                ) : (
                  <>
                    <Markdown>{message.content}</Markdown>
                    {streaming && (
                      <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[2px] animate-pulse bg-slate-400 align-middle" />
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div
          className={`flex items-center gap-2 ${isUser ? 'flex-row-reverse' : ''}`}
        >
          <time className="px-1 text-[11px] text-slate-400">
            {formatTime(message.timestamp)}
          </time>
          {/* 只在 AI 回答且已有内容时提供复制；常驻显示而非 hover 显示，避免触屏设备点不到 */}
          {!isUser && message.content && <CopyButton text={message.content} />}
        </div>
      </div>
    </div>
  )
}

/**
 * memo 包裹：流式刷新时只重建最后一条 AI 消息，
 * 历史消息不再跟着重渲染，其 Markdown 也不会被反复重新解析。
 */
export default memo(ChatMessage)
