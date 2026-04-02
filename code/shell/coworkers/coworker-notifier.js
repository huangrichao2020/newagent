import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function cleanText(value) {
  return String(value ?? '').trim()
}

function truncateText(value, maxLength) {
  const normalized = cleanText(value).replace(/\s+/g, ' ')

  if (!normalized || normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function escapeAppleScriptString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
}

function buildNotificationScript({
  title,
  subtitle,
  body
}) {
  const segments = [
    `display notification "${escapeAppleScriptString(body)}"`,
    `with title "${escapeAppleScriptString(title)}"`
  ]

  if (cleanText(subtitle)) {
    segments.push(`subtitle "${escapeAppleScriptString(subtitle)}"`)
  }

  return segments.join(' ')
}

export function createCoworkerNotifier({
  execFileFn = execFileAsync,
  enabled = true,
  logger = null
} = {}) {
  async function notifyRequest(request) {
    if (!enabled) {
      return {
        delivered: false,
        skipped: true,
        reason: 'disabled'
      }
    }

    const requestId = cleanText(request?.id)

    if (!requestId) {
      throw new Error('Missing required request id')
    }

    const title = 'newagent 有新协作消息'
    const subtitle = truncateText(request?.title || `请求 ${requestId}`, 72)
    const body = truncateText(request?.question || '请打开本机 coworker inbox 查看。', 160)
    const script = buildNotificationScript({
      title,
      subtitle,
      body
    })

    await execFileFn('osascript', ['-e', script], {
      maxBuffer: 1024 * 1024
    })

    if (typeof logger === 'function') {
      logger(`notification delivered ${requestId}`)
    }

    return {
      delivered: true,
      skipped: false,
      script,
      title,
      subtitle,
      body
    }
  }

  return {
    notifyRequest
  }
}

export {
  buildNotificationScript,
  escapeAppleScriptString
}
