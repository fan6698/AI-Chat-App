import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChatApiError, streamChatCompletion } from '../api'
import { clearMessages, loadMessages, saveMessages } from '../storage'
import { createDeltaBuffer } from '../utils/deltaBuffer'
import { createMessage, type Message } from '../types'
import ChatMessage from './ChatMessage'

const MAX_INPUT_HEIGHT = 120
/** 流式输出的最小刷新间隔：把高频 token 合并成低频渲染，避免长回答掉帧 */
const STREAM_FLUSH_INTERVAL_MS = 40
/** 消息变化后延迟写入本地存储，避免流式过程中每个 token 都全量序列化一次 */
const SAVE_DEBOUNCE_MS = 400
/** 距底部小于该距离即视为"用户仍黏在底部"，可以继续自动滚动 */
const STICK_THRESHOLD_PX = 60
/** 自动滚动后忽略 scroll 事件的窗口，避免自身滚动被误判为用户上翻 */
const AUTO_SCROLL_GUARD_MS = 500

export default function ChatInterface() {
  // 首次渲染即从本地存储恢复历史，无需额外的加载态
  const [messages, setMessages] = useState<Message[]>(() => loadMessages())
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** 用户是否已主动往上翻阅：为 true 时不再自动吸底，避免看历史被强行拽回 */
  const stickToBottomRef = useRef(true)
  /** 程序自身触发滚动的时间戳，用于区分用户滚动和自动滚动 */
  const autoScrollAtRef = useRef(0)

  /** 判断用户是否主动离开底部 */
  function handleScroll() {
    const el = listRef.current
    if (!el) return
    // 自动滚动会连续触发 scroll 事件，短时间内忽略，否则中途位置会被误判成用户上翻
    if (Date.now() - autoScrollAtRef.current < AUTO_SCROLL_GUARD_MS) return

    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceToBottom < STICK_THRESHOLD_PX
  }

  // 新消息或流式增量到达时滚动到底部（仅在用户没有上翻时）
  useEffect(() => {
    const el = listRef.current
    if (!el || !stickToBottomRef.current) return

    autoScrollAtRef.current = Date.now()
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages])

  // 输入框随内容增高，到上限后可内部滚动
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }, [input])

  // 卸载时中断未完成的请求
  useEffect(() => () => abortRef.current?.abort(), [])

  // 对话更新后自动落盘（防抖，最后一次更新一定会被写入）
  useEffect(() => {
    const timer = setTimeout(() => saveMessages(messages), SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [messages])

  const appendToLastAssistant = useCallback((delta: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, content: last.content + delta }]
    })
  }, [])

  /** 出错或中断时，移除尚未产出内容的助手气泡 */
  const dropEmptyAssistant = useCallback(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      return last?.role === 'assistant' && !last.content ? prev.slice(0, -1) : prev
    })
  }, [])

  async function handleSend() {
    const content = input.trim()
    if (!content || loading) return

    const userMessage = createMessage('user', content)
    const history = [...messages, userMessage]

    setMessages([...history, createMessage('assistant', '')])
    setInput('')
    setError(null)
    setLoading(true)

    const controller = new AbortController()
    abortRef.current = controller
    // 每个请求独立一份缓冲区，避免跨请求串字
    const buffer = createDeltaBuffer({
      intervalMs: STREAM_FLUSH_INTERVAL_MS,
      onFlush: appendToLastAssistant,
    })

    try {
      for await (const delta of streamChatCompletion(history, {
        signal: controller.signal,
      })) {
        buffer.push(delta)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // 用户主动停止：保留已生成的部分，但避免留下空气泡
        dropEmptyAssistant()
      } else if (err instanceof ChatApiError) {
        setError(err.message)
        dropEmptyAssistant()
      } else {
        setError('发生了未知错误，请稍后再试')
        dropEmptyAssistant()
      }
    } finally {
      // 先冲刷剩余文本，保证中断/结束时最后几个字不丢
      buffer.dispose()
      setLoading(false)
      abortRef.current = null
      // 输入框在加载期间被禁用会丢焦点，结束后自动收回来
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  function handleStop() {
    abortRef.current?.abort()
  }

  function handleClear() {
    if (messages.length === 0) return
    if (!window.confirm('确定要清空所有对话记录吗？此操作不可恢复。')) return

    // 若正在生成，先中断，避免残留的增量又被写回来
    abortRef.current?.abort()
    setMessages([])
    setError(null)
    clearMessages()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter 发送，Shift + Enter 换行
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void handleSend()
    }
  }

  const canSend = input.trim().length > 0 && !loading

  return (
    <div className="flex h-full flex-col bg-[#ededed]">
      {/* 顶部栏 */}
      <header className="relative flex h-12 shrink-0 items-center justify-center border-b border-black/5 bg-[#f7f7f7]">
        <h1 className="text-[15px] font-medium text-slate-800">AI 聊天助手</h1>
        <button
          type="button"
          onClick={handleClear}
          disabled={messages.length === 0}
          className="absolute right-3 rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-black/5 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          清空对话
        </button>
      </header>

      {/* 消息列表 */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-slate-400">发送消息，开始对话</p>
          </div>
        ) : (
          messages.map((message, index) => (
            <ChatMessage
              key={message.timestamp + '-' + index}
              message={message}
              streaming={loading && index === messages.length - 1 && message.role === 'assistant'}
            />
          ))
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
          {error}
        </div>
      )}

      {/* 输入区 */}
      <footer className="shrink-0 border-t border-black/5 bg-[#f7f7f7] px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={loading}
            placeholder={loading ? '思考中…' : '输入消息，Enter 发送'}
            className={`max-h-[120px] flex-1 resize-none rounded-md border border-black/10 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 outline-none placeholder:text-slate-400 focus:border-[#07c160] ${
              loading ? 'cursor-not-allowed opacity-60' : ''
            }`}
          />
          {loading ? (
            <button
              type="button"
              onClick={handleStop}
              className="h-9 shrink-0 rounded-md border border-black/10 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50"
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              className="h-9 shrink-0 rounded-md bg-[#07c160] px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}
