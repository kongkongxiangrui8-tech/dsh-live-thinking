/**
 * dsh-live-thinking — 客户端半边：把「当前正在做什么」推给桌面悬浮窗。
 *
 * 曾经它还在输入框下方渲染一行实时状态（`🛠 pwsh 运行中 0:00` 那种）。
 * 按用户要求，那一行已经删除：组件不再渲染任何 DOM，只做悬浮窗的数据源。
 *
 * 数据来源全部是会话标准件，不读 DOM：
 *   - `useSession` → `{ running, sessionId }`；
 *   - `useChat` → 聊天快照 `legacy.partial`（正在流式生成的块，含 reasoning 块）、
 *     `legacy.runningCalls`（正在执行的工具）与 `legacy.turnTimings`（本轮起点）；
 *   - `useProjection('llmRetry')` → 请求重试投影（缺失时退回
 *     `sessions.binding(id).session.projections.faceOf('llmRetry')`）。
 *
 * 挂在 `conversation.composer.dock`（输入框卡片下方那一条，内置的
 * 「N 轮 M 步 · tok/s」统计就在同一个 list 槽里），order 为 -1，但渲染 `null`：
 * 槽位里始终是一个零高度的空条目，界面看起来与没装这个插件一样。
 *
 * 插件不写任何配置、不产生网络请求，卸载后界面立即恢复原样。
 */
(function () {
  'use strict'

  /** 本插件拥有的 locale 命名空间。 */
  const NS = 'live-thinking'
  /** 槽内条目标识。 */
  const ENTRY_ID = 'live-thinking'

  /** 中文词条（键集的事实来源）。 */
  const LOCALE_ZH = {
    label: '实时状态',
    think: '思考中：{text}',
    tool: '{name} 运行中',
    toolMore: ' · 另有 {count} 个',
    stream: '输出中',
    model: '等待模型响应',
    retry: '请求重试中（第 {attempt} 次）',
    overlayThink: '思考中',
    overlayTool: '正在调用工具',
    overlayStream: '输出中',
    overlayModel: '等待模型响应',
    overlayRetry: '请求重试中',
    overlayAttempt: '第 {attempt} 次',
  }

  /** 英文词条，键集与中文一致。 */
  const LOCALE_EN = {
    label: 'Live status',
    think: 'Thinking: {text}',
    tool: '{name} running',
    toolMore: ' · {count} more',
    stream: 'Writing',
    model: 'Waiting for the model',
    retry: 'Retrying the request (#{attempt})',
    overlayThink: 'Thinking',
    overlayTool: 'Running a tool',
    overlayStream: 'Writing',
    overlayModel: 'Waiting for the model',
    overlayRetry: 'Retrying',
    overlayAttempt: 'attempt {attempt}',
  }

  /** 每种状态的前导图标。 */
  const ICONS = {
    think: '🧠',
    tool: '🛠',
    stream: '✍️',
    model: '🧠',
    retry: '♻️',
  }

  /** 思考预览的最大字符数（按码点计）。 */
  const SNIPPET_LIMIT = 96
  /** 工具参数预览的最大字符数。 */
  const TOOL_PREVIEW_LIMIT = 42
  /** 悬浮窗状态的回传地址（桌面小窗在 127.0.0.1 上监听）。 */
  const STATE_ENDPOINT = 'http://127.0.0.1:17863/state'

  /**
   * 把一行状态推给桌面悬浮窗。跨源但用的是「简单请求」（text/plain + no-cors），
   * 浏览器不会发预检，小窗收到 JSON 即可；小窗没开时请求静默失败。
   * @param {object} payload - 状态快照。
   */
  function postHostState(payload) {
    if (typeof fetch !== 'function') return
    try {
      fetch(STATE_ENDPOINT, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {})
    } catch {
      // 悬浮窗是增强项，失败不影响输入框下的那一行。
    }
  }

  /**
   * 悬浮窗第一行的大字标签。
   * @param {{kind: string}} line - 推导结果。
   * @param {(key: string, params?: object) => string} t - 翻译函数。
   * @returns {string} 标签文本。
   */
  function overlayLabel(line, t) {
    switch (line.kind) {
      case 'retry':
        return t('overlayRetry')
      case 'tool':
        return t('overlayTool')
      case 'stream':
        return t('overlayStream')
      case 'think':
        return t('overlayThink')
      default:
        return t('overlayModel')
    }
  }

  /**
   * 悬浮窗第二行的细节文本。
   * @param {{kind: string, data: object}} line - 推导结果。
   * @param {(key: string, params?: object) => string} t - 翻译函数。
   * @returns {string} 细节文本。
   */
  function overlayDetail(line, t) {
    switch (line.kind) {
      case 'retry':
        return t('overlayAttempt', { attempt: line.data.attempt })
      case 'tool': {
        const preview = line.data.preview === '' ? '' : ': ' + line.data.preview
        return line.data.name + preview
      }
      case 'think':
        return line.data.snippet
      default:
        return ''
    }
  }

  /**
   * 把 `{name}` 占位符替换成参数值。
   * @param {string} template - 词条原文。
   * @param {Record<string, unknown>} [params] - 参数表。
   * @returns {string} 插值后的文本。
   */
  function interpolate(template, params) {
    if (params === undefined || params === null) return template
    return template.replace(/\{(\w+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
    )
  }

  /**
   * 未注册 locale 时的兜底翻译。
   * @param {string} key - 词条键。
   * @param {Record<string, unknown>} [params] - 参数表。
   * @returns {string} 中文文本。
   */
  function fallbackT(key, params) {
    return interpolate(LOCALE_ZH[key] ?? key, params)
  }

  /**
   * 紧凑时长：`0:07`、`1:23`、`1:02:03`。
   * @param {number} ms - 毫秒。
   * @returns {string} 时长文本。
   */
  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000))
    const seconds = total % 60
    const minutes = Math.floor(total / 60) % 60
    const hours = Math.floor(total / 3600)
    const ss = String(seconds).padStart(2, '0')
    if (hours > 0) return hours + ':' + String(minutes).padStart(2, '0') + ':' + ss
    return minutes + ':' + ss
  }

  /**
   * 从一条工具调用的原始参数里取一行可读预览。
   * @param {unknown} argsRaw - 原始 JSON 字符串或已解析对象。
   * @returns {string} 单行预览，取不到时为空串。
   */
  function toolPreview(argsRaw) {
    let args = null
    try {
      args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw
    } catch {
      return ''
    }
    if (args === null || typeof args !== 'object') return ''
    const candidate =
      args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.query ??
      args.queries ?? args.url ?? args.prompt ?? args.tasks ?? args.description
    if (Array.isArray(candidate)) return candidate.length + ' 项'
    if (typeof candidate !== 'string') return ''
    const line = candidate.split('\n')[0].replace(/\s+/g, ' ').trim()
    if (line === '') return ''
    return line.length > TOOL_PREVIEW_LIMIT ? line.slice(0, TOOL_PREVIEW_LIMIT - 1) + '…' : line
  }

  /**
   * 去掉一行 Markdown 的装饰记号，留下可读文本。
   * @param {string} line - 原始行。
   * @returns {string} 清理后的行。
   */
  function cleanLine(line) {
    let text = line.trim()
    if (text === '') return ''
    text = text.replace(/^#{1,6}\s+/, '')
    text = text.replace(/^>\s*/, '')
    text = text.replace(/^([-*+]|\d+[.)])\s+/, '')
    text = text.replace(/```.*$/, '')
    text = text.replace(/\*\*/g, '')
    text = text.replace(/`/g, '')
    text = text.replace(/\s+/g, ' ').trim()
    return text
  }

  /**
   * 取出推理文本里「最新的一行」——流式思考时它一直在往后长。
   * @param {string} text - 完整的推理文本。
   * @returns {string} 单行预览，取不到时为空串。
   */
  function thinkingLine(text) {
    if (typeof text !== 'string' || text === '') return ''
    // 首字符是 `<` 的推理属于自定义渲染（reasoningText 会隐藏它），不做预览。
    if (text[0] === '<') return ''
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    for (let index = lines.length - 1; index >= 0; index--) {
      const candidate = cleanLine(lines[index])
      if (candidate !== '') return candidate
    }
    return ''
  }

  /**
   * 把过长的单行截成「…尾部」，让最新的内容保持在视野里。
   * @param {string} text - 单行文本。
   * @returns {string} 截断后的文本。
   */
  function truncateTail(text) {
    const chars = Array.from(text)
    if (chars.length <= SNIPPET_LIMIT) return text
    return '…' + chars.slice(chars.length - (SNIPPET_LIMIT - 1)).join('')
  }

  /**
   * 从正在流式生成的块里取当前思考预览。
   * @param {unknown} blocks - `legacy.partial.blocks`。
   * @returns {string} 预览文本，没有可显示的思考时为空串。
   */
  function thinkingSnippet(blocks) {
    if (!Array.isArray(blocks)) return ''
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index]
      if (block === null || typeof block !== 'object') continue
      if (block.kind !== 'reasoning') continue
      const line = thinkingLine(block.text)
      if (line !== '') return truncateTail(line)
    }
    return ''
  }

  /**
   * 本轮运行的起点时间，取自时间线里尚未结束的那一轮。
   * @param {unknown} turnTimings - `legacy.turnTimings`（Map 或等价对象）。
   * @returns {number|null} 毫秒时间戳，找不到时为 null。
   */
  function turnAnchor(turnTimings) {
    if (turnTimings !== null && typeof turnTimings === 'object' && typeof turnTimings.forEach === 'function') {
      let anchor = null
      turnTimings.forEach((value) => {
        if (value === null || typeof value !== 'object') return
        if (value.endTime !== undefined) return
        if (typeof value.startTime !== 'number') return
        anchor = anchor === null ? value.startTime : Math.max(anchor, value.startTime)
      })
      if (anchor !== null) return anchor
    }
    return null
  }

  /**
   * 读取重试投影里的最大重试次数。
   * @param {unknown} retry - `llmRetry` 投影值。
   * @returns {number} 0 表示没有重试。
   */
  function retryAttempt(retry) {
    if (retry === null || typeof retry !== 'object') return 0
    let attempt = 0
    for (const entry of Object.values(retry)) {
      if (entry === null || typeof entry !== 'object') continue
      const value = Number(entry.retry)
      if (Number.isFinite(value) && value > attempt) attempt = value
    }
    return attempt
  }

  /**
   * 读取一个投影 face 的当前值，不绑定具体实现形态。
   * @param {unknown} face - `projections.faceOf(...)` 的返回值。
   * @returns {unknown} 当前快照值。
   */
  function readFace(face) {
    if (face === undefined || face === null) return undefined
    if (typeof face.getSnapshot === 'function') return face.getSnapshot()
    if (typeof face.get === 'function') return face.get()
    if ('value' in face) return face.value
    return undefined
  }

  /**
   * 状态机：从会话快照推导出当前该显示的那一行。
   * @param {object} input - 状态输入。
   * @param {boolean} input.running - 会话是否正在运行。
   * @param {unknown} input.calls - `legacy.runningCalls`。
   * @param {unknown} input.partial - `legacy.partial`。
   * @param {unknown} input.turnTimings - `legacy.turnTimings`。
   * @param {unknown} input.retry - 重试投影。
   * @param {number} input.now - 当前时间（毫秒）。
   * @param {number} input.mountedAt - 组件挂载时间，兜底起点。
   * @returns {{kind: string, data: object, elapsedMs: number|null}|null} 为 null 时整行隐藏。
   */
  function deriveLine(input) {
    const { running, calls, partial, turnTimings, retry, now, mountedAt } = input
    if (running !== true) return null

    const anchor = turnAnchor(turnTimings) ?? mountedAt
    const turnElapsed = Math.max(0, now - anchor)

    const attempt = retryAttempt(retry)
    if (attempt > 0) return { kind: 'retry', data: { attempt }, elapsedMs: null }

    const list = Array.isArray(calls) ? calls : []
    if (list.length > 0) {
      let oldest = list[0]
      for (const call of list) {
        const time = call !== null && typeof call === 'object' && typeof call.time === 'number' ? call.time : now
        const oldestTime = oldest !== null && typeof oldest === 'object' && typeof oldest.time === 'number' ? oldest.time : now
        if (time < oldestTime) oldest = call
      }
      const record = oldest !== null && typeof oldest === 'object' ? oldest : {}
      const name = typeof record.name === 'string' && record.name !== '' ? record.name : '工具'
      const preview = toolPreview(record.argsRaw)
      const more = list.length > 1 ? list.length - 1 : 0
      const startedAt = typeof record.time === 'number' ? record.time : anchor
      return {
        kind: 'tool',
        data: { name, preview, more },
        startedAt,
        elapsedMs: Math.max(0, now - startedAt),
      }
    }

    const blocks = partial !== null && typeof partial === 'object' && Array.isArray(partial.blocks) ? partial.blocks : []
    const last = blocks.length > 0 ? blocks[blocks.length - 1] : undefined
    if (last !== null && typeof last === 'object' && last.kind === 'reasoning') {
      const snippet = thinkingSnippet(blocks)
      /* 思考/输出/等待都不带整轮计时：那一轮的起点是回合，不是当前阶段；
         组件会用阶段切换时刻自己算「这个阶段已经多久」。 */
      if (snippet !== '') return { kind: 'think', data: { snippet }, elapsedMs: null }
    }
    if (partial !== null && partial !== undefined) {
      return { kind: 'stream', data: {}, elapsedMs: null }
    }
    return { kind: 'model', data: {}, elapsedMs: null }
  }

  /**
   * 把推导结果渲染成一行文字。
   * @param {{kind: string, data: object}} line - `deriveLine` 的结果。
   * @param {(key: string, params?: object) => string} t - 翻译函数。
   * @returns {string} 展示文本。
   */
  function lineText(line, t) {
    switch (line.kind) {
      case 'retry':
        return t('retry', { attempt: line.data.attempt })
      case 'tool': {
        const preview = line.data.preview === '' ? '' : ': ' + line.data.preview
        const more = line.data.more > 0 ? t('toolMore', { count: line.data.more }) : ''
        return t('tool', { name: line.data.name }) + preview + more
      }
      case 'think':
        return t('think', { text: line.data.snippet })
      case 'stream':
        return t('stream')
      case 'model':
        return t('model')
      default:
        return ''
    }
  }

  /** 未提供会话套件时的空 hook：什么都不订阅。 */
  function NOOP_HOOK() {
    return undefined
  }

  /**
   * 把当前状态合并后推给宿主（输入框那一行与桌面悬浮窗共用同一份推导结果）。
   *
   * 合并策略：文本变化按 250ms 节流（流式推理每几十毫秒就变一次，逐条发会把
   * 本地 HTTP 打满），另每 3 秒补一次心跳；回合结束时立刻推一条 running:false。
   * @param {object} react - 模块表里的 React。
   * @param {object} payload - 当前状态快照。
   * @param {boolean|undefined} running - 会话是否正在运行。
   */
  function useOverlayBridge(react, payload, running) {
    const latest = react.useRef(null)
    const pending = react.useRef(false)
    const alive = react.useRef(true)
    latest.current = payload
    const key = JSON.stringify(payload)

    react.useEffect(() => {
      return () => {
        alive.current = false
        postHostState({ running: false })
      }
    }, [])

    react.useEffect(() => {
      if (typeof fetch !== 'function') return
      if (latest.current.running !== true) {
        postHostState({ running: false })
        return
      }
      if (pending.current) return
      pending.current = true
      setTimeout(() => {
        pending.current = false
        if (alive.current) postHostState(latest.current)
      }, 250)
    }, [key])

    react.useEffect(() => {
      if (running !== true || typeof fetch !== 'function') return undefined
      const timer = setInterval(() => {
        if (alive.current && latest.current.running === true) postHostState(latest.current)
      }, 3000)
      return () => {
        clearInterval(timer)
      }
    }, [running])
  }

  /**
   * 选择本构建提供的聊天快照 hook。
   * @param {object} props - 槽条目 props。
   * @returns {(selector: Function) => unknown} 读取聊天快照的 hook。
   */
  function chatHookOf(props) {
    if (typeof props.useChat === 'function') return props.useChat
    if (typeof props.useConversation === 'function') {
      return (selector) => props.useConversation((conversation) => selector(conversation?.views?.get?.('chat')))
    }
    return NOOP_HOOK
  }

  /**
   * 构造插件主体的 apply。
   * @param {object} react - 模块表里的 React。
   * @returns {(ctx: object) => void} cordis 插件体。
   */
  function makeApply(react) {
    const LiveThinking = react.memo(function LiveThinking(props) {
      const useSession = typeof props.useSession === 'function' ? props.useSession : NOOP_HOOK
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : NOOP_HOOK
      const useChat = chatHookOf(props)
      const t = typeof props.t === 'function' ? props.t : fallbackT

      const [now, setNow] = react.useState(() => Date.now())
      const [mountedAt] = react.useState(() => Date.now())

      const running = useSession((status) => status?.running === true)
      const sessionId = useSession((status) => status?.sessionId)
      const runningCalls = useChat((chat) => chat?.legacy?.runningCalls)
      const partial = useChat((chat) => chat?.legacy?.partial)
      const turnTimings = useChat((chat) => chat?.legacy?.turnTimings)
      const projectedRetry = useProjection('llmRetry')

      react.useEffect(() => {
        if (running !== true) return undefined
        setNow(Date.now())
        const timer = setInterval(() => {
          setNow(Date.now())
        }, 1000)
        return () => {
          clearInterval(timer)
        }
      }, [running])

      let retryValue = projectedRetry
      if (retryValue === undefined && props.sessions !== undefined && sessionId !== undefined) {
        try {
          const face = props.sessions.binding?.(sessionId)?.session?.projections?.faceOf?.('llmRetry')
          retryValue = readFace(face)
        } catch {
          retryValue = undefined
        }
      }

      const line = deriveLine({
        running,
        calls: runningCalls,
        partial,
        turnTimings,
        retry: retryValue,
        now,
        mountedAt,
      })

      /* 阶段起点：阶段一变就重置，于是计时说的是「这个阶段已经多久」，
         而不是整轮已经多久（旧提示容易让人误以为思考了十几分钟）。 */
      const phase = react.useRef({ kind: null, since: 0 })
      if (line !== null && phase.current.kind !== line.kind) {
        phase.current = { kind: line.kind, since: Date.now() }
      }

      /* 桌面悬浮窗与输入框下那一行共用同一份推导结果。 */
      const overlayPayload = line === null
        ? { running: false }
        : {
            running: true,
            kind: line.kind,
            icon: ICONS[line.kind] ?? '🧠',
            label: overlayLabel(line, t),
            detail: overlayDetail(line, t),
            startedAt: line.kind === 'tool' ? line.startedAt : phase.current.since,
            sessionId: typeof sessionId === 'string' ? sessionId : '',
          }
      useOverlayBridge(react, overlayPayload, running)

      /* 输入框下方那一行状态已经按需求移除：组件现在只是悬浮窗的数据源，
         不再渲染任何 DOM，槽位里始终是一个零高度的空条目。 */
      return null
    })

    return function apply(ctx) {
      const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (slots === undefined) return
      const locale = ctx.locale ?? (typeof ctx.get === 'function' ? ctx.get('locale') : undefined)
      const sessions = ctx.sessions ?? (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined)

      let localeReady = false
      if (locale !== undefined && typeof locale.register === 'function') {
        try {
          ctx.effect(
            () => locale.register(NS, { zh: LOCALE_ZH, en: LOCALE_EN }),
            'dsh-live-thinking: dictionaries',
          )
          localeReady = true
        } catch {
          localeReady = false
        }
      }

      /** 槽条目本身：只作为悬浮窗的数据源挂在槽里，不渲染任何内容。 */
      const entry = {
        name: 'conversation.composer.dock',
        id: ENTRY_ID,
        order: -1,
        label: () => (localeReady && typeof locale.bind === 'function' ? locale.bind(NS)('label') : LOCALE_ZH.label),
      }
      if (localeReady) entry.locale = NS

      const register = () =>
        slots.register(entry, (props) => react.createElement(LiveThinking, { ...props, sessions }))

      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => slots.inject('conversation.composer.dock', register),
          'dsh-live-thinking: composer dock entry',
        )
      } else {
        slots.inject('conversation.composer.dock', register)
      }
    }
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
    window.__ModuleLoader__.load({
      id: 'dsh-live-thinking',
      factory(require) {
        const module = { exports: {} }
        const exports = module.exports
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
        const react = require('react')
        exports.name = 'dsh-live-thinking'
        /* 需要宿主提供的 ctx 服务：slots 注册槽位，locale 提供词条，sessions 作为重试投影的兜底。 */
        exports.inject = ['slots', 'locale', 'sessions']
        exports.apply = makeApply(react)
        return module.exports
      },
    })
  }

  /* Node 侧（单元测试）导出纯函数；浏览器里没有 module。 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      deriveLine,
      formatClock,
      lineText,
      overlayDetail,
      overlayLabel,
      readFace,
      retryAttempt,
      thinkingLine,
      thinkingSnippet,
      toolPreview,
      truncateTail,
      turnAnchor,
    }
  }
})()
