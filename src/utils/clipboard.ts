/**
 * 复制文本到剪贴板。
 * @returns 是否复制成功，调用方据此决定是否显示"已复制"反馈
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false

  // 首选异步剪贴板 API（需 HTTPS 或 localhost）
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被拒或不为安全上下文，走下面的兜底方案
  }

  // 兜底：临时 textarea + execCommand，兼容 http 环境与旧浏览器
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
