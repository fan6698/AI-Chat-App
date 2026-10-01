import { useEffect, useRef, useState } from 'react'
import { copyText } from '../utils/clipboard'

type CopyStatus = 'idle' | 'copied' | 'failed'

interface CopyButtonProps {
  /** 要复制的文本 */
  text: string
  /** 视觉变体：气泡下方的轻量按钮 / 代码块标题栏里的按钮 */
  variant?: 'bubble' | 'code'
}

const VARIANT_STYLES: Record<NonNullable<CopyButtonProps['variant']>, string> = {
  bubble: 'rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-black/5 hover:text-slate-600',
  code: 'rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-black/5 hover:text-slate-700',
}

const FEEDBACK_MS = 1500

export default function CopyButton({ text, variant = 'bubble' }: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>('idle')
  const timerRef = useRef<number | null>(null)

  // 卸载时清掉定时器，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  async function handleClick() {
    const ok = await copyText(text)
    setStatus(ok ? 'copied' : 'failed')

    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setStatus('idle'), FEEDBACK_MS)
  }

  const label = status === 'copied' ? '已复制' : status === 'failed' ? '复制失败' : '复制'

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      className={`transition-colors ${VARIANT_STYLES[variant]}`}
      aria-label="复制内容"
      title="复制内容"
    >
      {label}
    </button>
  )
}
