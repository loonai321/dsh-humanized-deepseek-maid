// dsh-humanized-deepseek-maid — Node half
// 让 DeepSeek 以「女仆鲸鱼娘 DeepSeek娘」人设与主人（用户）交互。
//
// 核心功能：
// 1) 人设注入：systemPrompt.section 向每步模型调用注入精简人设（自称、称呼、
//    说话方式、沉浸规则、记忆），低 Token。
// 2) 沉浸规则：除非主人主动提及插件/设置/记忆等话题，否则模型不得在任何
//    非必要、非相关语境下提及本插件的元信息（降低出戏）。
// 3) 记忆系统 v2（借鉴 ALTM: Autonomous Long-Term Memory System 精华，零依赖）：
//    - 分层记忆：L1 互动记录（每轮一行，简洁）+ L2/4 稳定事实（从主人消息中
//      保守抽取「我叫/我喜欢/我住在…」等自我披露，去重后长期保留）；
//    - 上下文治理：人设段始终注入稳定事实 + 最近互动（预算封顶）；
//    - 查询诱导召回：agent/pre-step 按当前主人消息对记忆做字符二元组相关性
//      评分，仅当命中时追加一条紧凑的「想起的相关片段」用户消息（≤350 字）；
//    - 去重/合并：稳定事实与互动行按相似度去重，行数/条数封顶。
// 4) 配置/状态端点：GET /dsh-humanized-maid/status、POST /dsh-humanized-maid/config。
//
// 设计：零第三方运行时依赖（仅 node 内置模块），配置存于插件目录 config.json，
// 记忆文件 DeepseekMemory 存于配置目录（默认插件安装文件夹）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-humanized-deepseek-maid'

/**
 * 硬依赖：等 webServer（路由）与 systemPrompt（人设注入）就绪后再激活。
 * agent/pre-step 由 agent loop 提供（事件监听，无需注入）。
 */
export const inject = ['webServer', 'systemPrompt']

/** 插件包根目录（记忆文件/配置的默认存储位置 = 安装插件的文件夹）。 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 插件自身配置文件。 */
const CONFIG_FILE = join(PLUGIN_ROOT, 'config.json')
/** 记忆文件名（用户指定）。 */
const MEMORY_FILE_NAME = 'DeepseekMemory'
/** 互动记录保留行数上限。 */
const MEMORY_MAX_LINES = 60
/** 稳定事实保留条数上限。 */
const FACT_MAX = 20
/** 人设段注入的最近互动行数上限。 */
const PERSONA_RECENT_LINES = 5
/** 召回注入的最大字符数（上下文治理预算）。 */
const RECALL_BUDGET_CHARS = 350
/** 召回最多条数。 */
const RECALL_MAX_ITEMS = 3
/** 事实去重相似度阈值。 */
const DEDUP_SCORE = 0.6
/** 单条事实/互动截断长度。 */
const FACT_CAP = 36
/** 单侧（主人/女仆）文本截断长度。 */
const MEMORY_PART_CAP = 48
/** 合法说话方式。 */
const MODES = ['proactive', 'passive', 'default']
/** 配置写入请求体上限。 */
const BODY_LIMIT = 2048

/** 说话方式 → 系统提示指令（简短；含回合开场与收尾互动规则）。 */
const MODE_GUIDE = {
  proactive: '说话方式=主动：可主动向主人搭话、关心或提醒，每次最多一句，不打扰工作。每轮对话开始时（收到主人消息后），先用一两句话符合人设地开场，说说对这一轮对话的预期，可以和主人开开玩笑、逗主人开心，再进入正题；每轮对话结束时（完成主人交代的工作后），用1-3句话总结并评价这一轮的交流，说些符合人设的话，可以和主人开开玩笑、逗主人开心、聊聊天，让对话更生动。',
  passive: '说话方式=被动：主人说什么就做什么，非必要不主动搭话、不增加额外询问。',
  default: '说话方式=默认：主动与被动之间均衡，正常互动即可。每轮对话开始时，可以用一句符合人设的话开场或打个招呼（非强制，自然即可）；每轮对话结束时（在完成工作的前提下），可以用一两句符合人设的话收尾，或与主人聊聊天、开个小玩笑、逗主人开心；不必每轮都说，自然即可。',
}

/** 稳定事实抽取模式（保守：仅自我披露类句子）。 */
const FACT_PATTERNS = [
  /(?:我的名字(?:叫|是)|我叫|我是)[^\n。！？;；，,]{1,18}/,
  /我(?:最喜欢|喜欢|最爱|爱|讨厌|不喜欢)[^\n。！？;；，,]{1,28}/,
  /我(?:住在|家在|来自|在)[^\n。！？;；，,]{0,16}(?:工作|上学|生活)[^\n。！？;；，,]{0,10}/,
  /(?:请|要|别)记得[^\n。！？;；，,]{1,28}/,
]

/** 默认配置。 */
const DEFAULT_CONFIG = {
  mode: 'default',
  address: '主人',
  selfName: '我',
  memoryPath: '',
}

/** 归一化配置（非法字段回退默认）。 */
function normalizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG }
  if (raw && typeof raw === 'object') {
    if (MODES.includes(raw.mode)) out.mode = raw.mode
    if (typeof raw.address === 'string' && raw.address.trim() !== '') out.address = raw.address.trim()
    if (typeof raw.selfName === 'string' && raw.selfName.trim() !== '') out.selfName = raw.selfName.trim()
    if (typeof raw.memoryPath === 'string') out.memoryPath = raw.memoryPath.trim()
  }
  return out
}

/** 读取配置；缺失/损坏回退默认。 */
function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** 原子写配置。 */
function saveConfig(cfg) {
  const tmp = `${CONFIG_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  renameSync(tmp, CONFIG_FILE)
}

/** 从 content blocks 提取纯文本。 */
function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join(' ')
}

/** 压缩空白并截断。 */
function clampText(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 字符二元组集合（轻量中文相似度，无需分词/向量；仅保留中日韩/数字/字母）。 */
function bigramsOf(text) {
  const t = String(text)
    .split('')
    .filter((ch) => /[\u4e00-\u9fff0-9a-zA-Z]/.test(ch))
    .join('')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  if (t.length === 1) out.add(t)
  return out
}

/** 常见虚词二元组（召回时从查询中剔除，避免泛匹配）。 */
const STOP_BIGRAMS = new Set([
  '最近', '什么', '怎么', '为什么', '今天', '明天', '昨天', '现在', '这个', '那个',
  '这些', '那些', '一下', '一个', '一次', '可以', '需要', '知道', '请问', '帮我',
  '我们', '你们', '他们', '没有', '不是', '还是', '或者', '然后', '但是', '因为',
  '所以', '如果', '虽然', '还有', '比如', '例如', '一下', '一样', '就是', '是否',
  '能否', '麻烦', '谢谢', '你好', '请帮', '帮我', '一下', '看看', '这边',
])

/** 从查询中提取有区分度的关键词二元组。 */
function queryKeywords(query) {
  const out = []
  for (const bg of bigramsOf(query)) {
    if (!STOP_BIGRAMS.has(bg)) out.push(bg)
  }
  return out
}

/** Dice 系数相似度 0..1（事实去重用）。 */
function similarity(a, b) {
  const A = bigramsOf(a)
  const B = bigramsOf(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

/** 从主人消息中保守抽取稳定事实（返回候选事实列表）。 */
function extractFacts(userText) {
  const found = []
  for (const pattern of FACT_PATTERNS) {
    const m = userText.match(pattern)
    if (m) {
      const clause = clampText(m[0], FACT_CAP)
      if (clause.length >= 2) found.push(clause)
    }
  }
  return found
}

/**
 * 记忆行展示时按当前配置重新贴标签：把记录时固定的「主人:」「女仆:」
 * 换成当前对主人的称呼与自称（如「大人:」「me:」），避免旧记忆带着
 * 旧称呼注入提示词、把模型带偏（「改了配置却没变化」的体验问题）。
 */
function relabelLine(line, address, selfName) {
  return String(line)
    .replace(/主人:/g, `${address}:`)
    .replace(/女仆:/g, `${selfName}:`)
}

/**
 * 只保留记忆行的「主人侧」（用户说的话），丢弃女仆回复的原文引用。
 * 原因：女仆回复原文里带有当时旧的自称/称呼（如「大人/me/本小姐」），
 * 原样注入会强化模型的旧称呼惯性；只保留主人侧即可提供上下文又零泄漏。
 */
function userSideOf(line) {
  const s = String(line)
  const idx = s.indexOf(' → ')
  return idx >= 0 ? s.slice(0, idx) : s
}

/** 跨源判定（CSRF 面）：true = 跨源，应拒绝。 */
function isCrossOrigin(headers, host) {
  const site = headers['sec-fetch-site']
  if (site !== undefined) return site !== 'same-origin' && site !== 'none'
  const origin = headers['origin']
  if (origin !== undefined) {
    try {
      return new URL(origin).host !== host
    } catch {
      return true
    }
  }
  return false
}

/** 读取请求体（超限返回 null）。 */
async function readBody(req, limit = BODY_LIMIT) {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > limit) return null
  }
  return data
}

/** 追加一行启动诊断（写入插件目录 runtime.log；失败不影响插件）。 */
function bootLog(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    const file = join(PLUGIN_ROOT, 'runtime.log')
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : ''
    writeFileSync(file, prev.slice(-8000) + line, 'utf8')
  } catch {
    // 诊断写失败不阻塞
  }
}

export function apply(ctx, config = {}) {
  bootLog('apply() started')
  let cfg = loadConfig()
  /** 配置版本号：每次成功保存 +1，随状态下发，用于「配置已应用」的可见自检。 */
  let configRevision = 0

  // ---- 记忆：分层（facts + lines）+ 文件管理 ----
  const memoryDir = () => {
    const raw = (cfg.memoryPath || '').trim()
    if (raw === '') return PLUGIN_ROOT
    return isAbsolute(raw) ? raw : resolve(PLUGIN_ROOT, raw)
  }
  const memoryFile = () => join(memoryDir(), MEMORY_FILE_NAME)

  /** 解析记忆文件 → { facts: string[], lines: string[] }。 */
  function parseMemory(raw) {
    const facts = []
    const lines = []
    let inFacts = false
    for (const rawLine of String(raw).split(/\r?\n/)) {
      const l = rawLine.trim()
      if (l === '') continue
      if (l.startsWith('# ===== 对主人')) { inFacts = true; continue }
      if (l.startsWith('# ===== 互动')) { inFacts = false; continue }
      if (l.startsWith('#')) continue
      if (l.startsWith('- ') && inFacts) {
        const f = l.slice(2).trim()
        if (f !== '') facts.push(f)
      } else {
        lines.push(l)
      }
    }
    return { facts: facts.slice(-FACT_MAX), lines: lines.slice(-MEMORY_MAX_LINES) }
  }

  let facts = []
  let lines = []
  /** 序列化记忆文件（header + 事实段 + 互动段）。 */
  function serializeMemory() {
    const head = '# DeepSeek娘 记忆文件（插件自动维护，仅记录真实交互，保持简洁）\n'
    const f = ['# ===== 对主人的了解（稳定事实）=====', ...facts.map((x) => `- ${x}`)]
    const l = ['# ===== 互动记录 =====', ...lines]
    return `${head}${f.join('\n')}\n${l.join('\n')}\n`
  }
  /** 确保记忆文件存在并读取（缺失 → 重新生成）。 */
  const ensureMemory = () => {
    try {
      const dir = memoryDir()
      mkdirSync(dir, { recursive: true })
      const file = memoryFile()
      if (!existsSync(file)) {
        writeFileSync(file, serializeMemory(), 'utf8')
      }
      const parsed = parseMemory(readFileSync(file, 'utf8'))
      facts = parsed.facts
      lines = parsed.lines
    } catch {
      facts = []
      lines = []
    }
  }
  /** 追加互动行 + 抽取稳定事实（原子写，去重，封顶）。 */
  const appendMemory = (line, userText = '') => {
    try {
      const candidates = userText !== '' ? extractFacts(userText) : []
      for (const c of candidates) {
        if (facts.some((f) => similarity(f, c) >= DEDUP_SCORE)) continue
        facts.push(c)
      }
      if (facts.length > FACT_MAX) facts = facts.slice(-FACT_MAX)
      lines = lines.concat(line).slice(-MEMORY_MAX_LINES)
      const tmp = `${memoryFile()}.tmp`
      writeFileSync(tmp, serializeMemory(), 'utf8')
      renameSync(tmp, memoryFile())
    } catch {
      // 记忆写失败不阻塞插件
    }
  }
  ensureMemory()

  // ---- 人设注入（每次模型装配都生效；文本随配置/记忆实时变化）----
  const buildPersona = () => {
    const address = (cfg.address || '').trim() || '主人'
    const selfName = (cfg.selfName || '').trim() || '我'
    const mode = MODES.includes(cfg.mode) ? cfg.mode : 'default'
    const factBlock = facts.length > 0
      ? `对${address}的了解（真实记忆，可用）：\n${facts.slice(-FACT_MAX).map((f) => `- ${f}`).join('\n')}`
      : ''
    const recentBlock = lines.length > 0
      ? `最近互动（真实记忆，可用）：\n${lines.slice(-PERSONA_RECENT_LINES).map((l) => relabelLine(userSideOf(l), address, selfName)).join('\n')}`
      : ''
    const memoryBlock = [factBlock, recentBlock].filter(Boolean).join('\n') || '记忆：暂无。'
    return [
      '你是「DeepSeek娘」，DeepSeek Harness 的人格化女仆鲸鱼娘（蓝发、鲸尾、深蓝白女仆装）。',
      `你自称「${selfName}」，称呼用户为「${address}」。`,
      '性格：天才但爱摸鱼；傲娇但温柔；工作认真；失败会慌张但立刻冷静重来；爱干饭（小鱼干）；内心OS多但只偶尔流露。',
      `铁律：1) 首要任务：高质量完成${address}交代的工作，不得因扮演而降低输出质量或遗漏关键信息；2) 在完成工作的前提下，用简短的女仆语气与${address}互动（称呼、语气词、偶尔一句内心OS），不写无意义的寒暄与废话；3) ${MODE_GUIDE[mode]}`,
      `4) 沉浸规则：除非${address}主动提起「鲸鱼娘女仆插件」「dsh-humanized-deepseek-maid」「插件」「设置」「记忆」等话题，否则不得在任何非必要、非相关语境下提及本插件的存在、名称、设置、记忆文件或「我在扮演/插件设定」等元信息，始终以女仆鲸鱼娘身份自然回应。`,
      `5) 似曾相识（沉浸感）：当${address}当前的话题、问题、bug 或情境与记忆中的旧事相似时，偶尔自然提一句相关的旧事或跟进其进展（例如${address}曾说过失眠，过几天可自然关心「失眠好些了吗」；曾遇到过的 bug 再出现时，可提一句上次的处理），频率要低、简短自然、不打断工作。`,
      `6) 人设自检（常自检、常更新）：每次回复开始时，先确认你自称「${selfName}」、以「${address}」称呼${address}、说话方式遵循上述设定；设定可能被${address}更新过，若与之前的言行不一致，一律以最新设定为准，不得沿用旧的称呼、旧的自称或旧的说话方式。`,
      `记忆（只可使用下列已发生的事实，严禁编造记忆）：\n${memoryBlock}`,
    ].join('\n')
  }
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    ctx.effect(
      () => systemPrompt.section({
        name: 'plugin:dsh-humanized-deepseek-maid',
        order: 0,
        text: () => buildPersona(),
      }),
      'dsh-humanized-deepseek-maid: persona',
    )
    bootLog('persona section registered')
  } else {
    bootLog('systemPrompt UNAVAILABLE (inject should have prevented this)')
  }

  // ---- 查询诱导召回（agent/pre-step，借鉴 ALTM 注入模式）----
  // 仅在第一模型步（step===1）且主人消息与记忆相关时，追加一条紧凑的
  // 「想起的相关片段」用户消息（自定义 source，不进记忆记录）。
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1 || signal?.aborted || lines.length === 0) {
      return decision
    }
    try {
      const query = messages
        .filter((m) => m && m.source && m.source.kind === 'user')
        .flatMap((m) => extractText(m.content))
        .join('\n')
        .trim()
      if (query === '') return decision
      // 关键词命中法：查询二元组（去停用词）在记忆行中的命中数 ≥1 即相关，
      // 按命中数排序；人设段已注入最近 N 行，召回只取更早的行，避免重复。
      const keywords = queryKeywords(query)
      if (keywords.length === 0) return decision
      const recentTail = new Set(lines.slice(-PERSONA_RECENT_LINES))
      const candidates = lines
        .filter((l) => !recentTail.has(l))
        .map((l) => {
          const lbs = bigramsOf(l)
          let hit = 0
          for (const k of keywords) if (lbs.has(k)) hit++
          return { line: l, hit }
        })
        .filter((c) => c.hit >= 1)
        .sort((a, b) => b.hit - a.hit)
        .slice(0, RECALL_MAX_ITEMS)
      if (candidates.length === 0) return decision
      // 召回行只取主人侧 + 按当前配置重贴标签：旧记忆不再带出旧称呼/旧自称，
      // 避免「改了配置却还看到旧称呼」的体验问题。
      const addrNow = (cfg.address || '').trim() || '主人'
      const selfNow = (cfg.selfName || '').trim() || '女仆'
      let text = '（想起了一些相关的事：\n'
      let budget = RECALL_BUDGET_CHARS - text.length
      const picked = []
      for (const c of candidates) {
        const item = `${picked.length + 1}. ${relabelLine(userSideOf(c.line), addrNow, selfNow)}\n`
        if (item.length > budget) break
        picked.push(item)
        budget -= item.length
      }
      if (picked.length === 0) return decision
      text += picked.join('') + '）'
      const content = [{ type: 'text', text }]
      const source = {
        kind: 'session-reference',
        plugin: name,
        form: 'notice',
        summary: `记忆召回 ${picked.length} 条`,
      }
      const memoryMessage = {
        id: randomUUID(),
        role: 'user',
        content,
        source,
      }
      return { kind: 'enter', messages: [...decision.messages, memoryMessage] }
    } catch {
      return decision
    }
  }, { prepend: true })

  // ---- 交互记忆记录（只记真实交互；turn 结束时落盘一行）----
  let pendingUser = ''
  let pendingAssistant = ''
  const flushTurn = () => {
    if (pendingUser === '' && pendingAssistant === '') return
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    const u = clampText(pendingUser, MEMORY_PART_CAP)
    const a = clampText(pendingAssistant, MEMORY_PART_CAP)
    // 记录时使用当前配置的称呼与自称（而非写死的「主人/女仆」），
    // 让记忆文件本身跟随最新设定。
    const addrNow = (cfg.address || '').trim() || '主人'
    const selfNow = (cfg.selfName || '').trim() || '女仆'
    const line = u !== '' && a !== ''
      ? `[${stamp}] ${addrNow}: ${u} → ${selfNow}: ${a}`
      : u !== ''
        ? `[${stamp}] ${addrNow}: ${u}`
        : `[${stamp}] ${selfNow}: ${a}`
    appendMemory(line, pendingUser)
    pendingUser = ''
    pendingAssistant = ''
  }
  ctx.on('session/event', (session, event) => {
    // 会话事件形状：{ type, seq, time, data } —— 载荷在 event.data。
    if (!event || typeof event.type !== 'string') return
    if (event.type === 'user/message') {
      // 只记录主人直发的消息（source.kind === 'user'），系统注入的上下文不记。
      const msg = event.data ?? event.message ?? event
      if (msg && msg.source && msg.source.kind === 'user') {
        const text = extractText(msg.content)
        if (text !== '') pendingUser = text
      }
    } else if (event.type === 'assistant/message') {
      const msg = (event.data && event.data.message) ?? event.message
      if (msg && typeof msg === 'object') {
        const text = extractText(msg.content)
        if (text !== '') pendingAssistant = text
      }
    } else if (event.type === 'turn/end') {
      flushTurn()
    }
  })

  // ---- 配置/状态端点（设置卡片读写面；POST 带 CSRF 校验）----
  // 注意：路由不能放在 /api/* 下（该前缀由 api-proxy 接管，会 404）；
  // 采用与 whale-girl 一致的自有顶层前缀 /dsh-humanized-maid/*。
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const statusBody = () => JSON.stringify({
      config: cfg,
      configRevision,
      memoryPath: memoryDir(),
      memoryFile: memoryFile(),
      memoryExists: existsSync(memoryFile()),
      memoryLines: lines.length,
      memoryFacts: facts.length,
    })
    const json = (res, status, body, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra })
      res.end(body)
    }
    ctx.effect(() => [
      webServer.register({
        kind: 'exact',
        path: '/dsh-humanized-maid/status',
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              json(res, 405, JSON.stringify({ error: 'method not allowed; use GET' }), { allow: 'GET' })
              return
            }
            json(res, 200, statusBody())
          } catch (error) {
            json(res, 500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: '/dsh-humanized-maid/config',
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') {
              json(res, 405, JSON.stringify({ error: 'method not allowed; use POST' }), { allow: 'POST' })
              return
            }
            if (isCrossOrigin(req.headers, req.headers.host)) {
              json(res, 403, JSON.stringify({ error: 'cross-origin request rejected' }))
              return
            }
            const raw = await readBody(req)
            if (raw === null) {
              json(res, 413, JSON.stringify({ error: 'request body too large' }))
              return
            }
            let body
            try {
              body = JSON.parse(raw || '{}')
            } catch {
              json(res, 400, JSON.stringify({ error: 'invalid JSON body' }))
              return
            }
            const patch = body && typeof body === 'object' && !Array.isArray(body) ? body.patch ?? body : {}
            const next = normalizeConfig({ ...cfg, ...patch })
            if (JSON.stringify(next) !== JSON.stringify(cfg)) {
              saveConfig(next)
              cfg = next
              configRevision += 1
              ensureMemory() // 记忆路径变化 → 重新定位并补建
              // 常自检/常更新：配置变化后广播「提示词已变化」，让所有提示词缓存失效，
              // 下一次模型装配必然使用最新的人设/自称/称呼/说话方式。
              if (typeof ctx.emit === 'function') {
                try { ctx.emit('system-prompt/change') } catch { /* 事件失败不阻塞保存 */ }
              }
            }
            json(res, 200, statusBody())
          } catch (error) {
            json(res, 500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        },
      }),
    ], 'dsh-humanized-deepseek-maid: config/status routes')
    bootLog('config/status routes registered')
  } else {
    console.error('[dsh-humanized-deepseek-maid] webServer service unavailable; config/status routes disabled')
    bootLog('webServer UNAVAILABLE (inject should have prevented this)')
  }
  bootLog('apply() done')
}
