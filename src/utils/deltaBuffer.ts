/** 默认的最小刷新间隔：约 25 次/秒，肉眼已看不出卡顿，远低于逐 token 渲染 */
export const DEFAULT_INTERVAL_MS = 40

export interface DeltaBufferOptions {
  /** 落盘到 state 的最小间隔（毫秒），越小越实时、越大越省渲染 */
  intervalMs?: number
  /** 由调用方把累积的文本写入 state */
  onFlush: (delta: string) => void
}

export interface DeltaBuffer {
  /** 接收一小段增量文本，内部合并后按间隔节流刷新 */
  push: (delta: string) => void
  /** 立刻把缓冲区全部冲出 */
  flush: () => void
  /** 结束流式：冲刷剩余内容并清理定时器，保证不丢字、不泄漏 */
  dispose: () => void
}

/**
 * 把高频到达的 token 合并成低频的状态更新。
 *
 * 背景：流式接口每秒可能吐出上百个 token，每个 token 都 setState 会导致
 * 上百次 React 重渲染 + Markdown 全量重解析，长回答明显掉帧。
 * 这里做两层优化：
 * 1. 同一间隔窗口内的多个 token 合并为一次刷新；
 * 2. 超过间隔后的第一个 token 同步立即刷新，保证首字立刻上屏，不牺牲体感。
 */
export function createDeltaBuffer({
  intervalMs = DEFAULT_INTERVAL_MS,
  onFlush,
}: DeltaBufferOptions): DeltaBuffer {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  /** null 表示一次都没刷新过——此时首个 token 必须无条件立即上屏 */
  let lastFlushAt: number | null = null

  function flush() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (!pending) return

    const delta = pending
    pending = ''
    lastFlushAt = performance.now()
    onFlush(delta)
  }

  function push(delta: string) {
    if (!delta) return
    pending += delta

    // 已有定时器在等待本轮刷新，累积即可，不必重复排程
    if (timer !== null) return

    // 首次推送必须立即刷新。不能依赖 performance.now() 与 0 的差值判断：
    // 时间原点取决于运行环境，进程刚启动时它可能还没超过间隔，首字就会被无谓延迟。
    const elapsed =
      lastFlushAt === null ? Number.POSITIVE_INFINITY : performance.now() - lastFlushAt
    if (elapsed >= intervalMs) {
      flush()
      return
    }

    timer = setTimeout(() => {
      timer = null
      flush()
    }, intervalMs - elapsed)
  }

  function dispose() {
    // 冲刷剩余内容：中断/结束时不能丢掉最后没来得及刷出的字
    flush()
  }

  return { push, flush, dispose }
}
