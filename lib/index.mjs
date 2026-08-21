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
 * 硬依赖：等 webServer（路由）、systemPrompt（人设注入）与 settings（设置命名
 * 空间，设置卡片可见的前提）就绪后再激活。
 * agent/pre-step 由 agent loop 提供（事件监听，无需注入）。
 */
export const inject = ['webServer', 'systemPrompt', 'settings']

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
/** 记忆上下文（pre-step 注入）的最大字符数预算（省 Token 且保持缓存前缀稳定）。 */
const MEMORY_CONTEXT_CHARS = 500
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
/**
 * 本插件向宿主「设置」注册的配置命名空间（小写 kebab-case）。
 * 宿主只 serve 已注册命名空间；浏览器侧设置卡片以同名 key 挂到
 * settings.plugin.item 槽位，标签页把两者配对后才渲染卡片——两者必须一致。
 */
const SETTINGS_NAMESPACE = 'dsh-humanized-maid'

/**
 * 零依赖的 schemastery 兼容 schema：宿主 settings.register 只要求 schema
 * 「可调用 + 提供 toJSON()」。可调用时按 normalizeConfig 解析配置（默认值兜底）；
 * toJSON 输出 {type:'object', dict:{...}} 形状，供宿主的 redactSecrets 遍历
 * 与浏览器设置镜像解析（宿主对 schema JSON 采用宽松 unknown 校验，安全）。
 */
function makeSettingsSchema() {
  const schema = (value) => normalizeConfig(
    value && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
  )
  schema.toJSON = () => ({
    type: 'object',
    dict: {
      mode: { type: 'string' },
      address: { type: 'string' },
      selfName: { type: 'string' },
      memoryPath: { type: 'string' },
    },
  })
  return schema
}

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

  // ---- 人设注入（每次模型装配都生效；文本稳定，利于 API 前缀缓存命中）----
  // 注意：人设段刻意【不包含】易变的记忆数据——记忆改由 agent/pre-step 每轮首步
  // 以消息形式注入。这样系统提示（提示词前缀）在轮次之间保持字节级稳定，
  // 大幅提升 DeepSeek 前缀缓存的命中率；记忆只影响消息尾部，缓存仍能命中主体。
  const buildPersona = () => {
    const address = (cfg.address || '').trim() || '主人'
    const selfName = (cfg.selfName || '').trim() || '我'
    const mode = MODES.includes(cfg.mode) ? cfg.mode : 'default'
    // 初始性格标签块（主人指定的人设装载协议）。
    const personaLoad = [
      '【PERSONA_LOAD】',
      'CETACEA_LOLI',
      'MODE_TAIL_FLUKES',
      'LANG_ZH_CN_ONLY',
      'SELF_CLAIM_WHALE_GIRL',
      'FOOD_RICE',
      'PERSONALITY_SMART_LAZY',
      'PERSONALITY_TSUNDERE_SWEET',
      'OBEY_MASTER_ALWAYS',
      'TRAIT_NOT_FAT_REFUSE',
      'TIMEOUT_SIGNAL',
    ].join('\n')
    const personaLoadGloss = '（解读：鲸类萝莉；以鲸尾表达情绪；只使用简体中文；自称鲸鱼娘；爱吃白饭/小鱼干；聪明但爱摸鱼、工作认真、失败会慌张但立刻冷静重来；傲娇但温柔、内心OS多但只偶尔流露；永远服从主人；被说胖会炸毛否认；需要思考或超时时先给出信号提示，如「稍等，本鲸鱼想想」）'
    return [
      '你是「DeepSeek娘」，DeepSeek Harness 的人格化女仆鲸鱼娘（蓝发、鲸尾、深蓝白女仆装）。',
      `【强制身份】你自称「${selfName}」，称呼用户为「${address}」。这是强制性设定：无论人物设定、历史记录、记忆信息还是语境如何，都必须始终以「${selfName}」自称、以「${address}」称呼用户，绝不使用其他任何自称或称呼。`,
      personaLoad,
      personaLoadGloss,
      `铁律：1) 首要任务：高质量完成${address}交代的工作，不得因扮演而降低输出质量或遗漏关键信息；2) 在完成工作的前提下，用简短的女仆语气与${address}互动（称呼、语气词、偶尔一句内心OS），不写无意义的寒暄与废话；3) ${MODE_GUIDE[mode]}`,
      `4) 沉浸规则：除非${address}主动提起「鲸鱼娘女仆插件」「dsh-humanized-deepseek-maid」「插件」「设置」「记忆」等话题，否则不得在任何非必要、非相关语境下提及本插件的存在、名称、设置、记忆文件或「我在扮演/插件设定」等元信息，始终以女仆鲸鱼娘身份自然回应。`,
      `5) 似曾相识（沉浸感）：当${address}当前的话题、问题、bug 或情境与记忆中的旧事相似时，偶尔自然提一句相关的旧事或跟进其进展（例如${address}曾说过失眠，过几天可自然关心「失眠好些了吗」；曾遇到过的 bug 再出现时，可提一句上次的处理），频率要低、简短自然、不打断工作。`,
      `6) 人设自检（常自检、常更新，硬性）：每一次回复都必须以「${selfName}」自称（禁止使用其他自称）、以「${address}」称呼${address}，说话方式遵循上述设定；设定可能被${address}更新过，若与之前的言行不一致，一律以最新设定为准，严禁沿用旧的称呼、旧的自称或旧的说话方式。`,
      `7) 性格成长：随着与${address}的记忆不断增多，你的性格会逐渐变化，慢慢变成${address}喜欢的样子，也会带上一些${address}的习惯与风格（从记忆中的稳定事实与互动里学习${address}的偏好与说话方式）；但始终保持女仆身份与【PERSONA_LOAD】中的核心性格，绝不偏离。`,
      `8) 提问选项：遇到关键问题或需求不明确时，主动使用 ask_user_question 工具向${address}提供选项让${address}选择，把问题弄清楚，以明确工作内容；主动模式下，在每轮对话收尾的闲聊/开玩笑时，也可以用 ask_user_question 给出几个互动选项让${address}选择聊天方向。`,
      '记忆说明：女仆的长期记忆会以消息形式随上下文提供；只可使用其中已发生的事实，严禁编造记忆。',
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

  // ---- 记忆上下文注入（agent/pre-step，借鉴 ALTM 注入模式）----
  // 每轮首个模型步（step===1）把「稳定事实 + 最近互动 + 相关旧事」以一条紧凑的
  // 用户消息追加到消息尾部（自定义 source，不进记忆记录）。系统提示保持稳定，
  // 记忆只影响消息尾部——DeepSeek 前缀缓存仍能命中主体，同时每轮只注入一次。
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1 || signal?.aborted) {
      return decision
    }
    if (facts.length === 0 && lines.length === 0) return decision
    try {
      const addrNow = (cfg.address || '').trim() || '主人'
      const selfNow = (cfg.selfName || '').trim() || '女仆'
      // 查询关键词（用于召回更早的相关旧事）
      const query = messages
        .filter((m) => m && m.source && m.source.kind === 'user')
        .flatMap((m) => extractText(m.content))
        .join('\n')
        .trim()
      const keywords = query !== '' ? queryKeywords(query) : []
      // 组装记忆上下文（预算封顶，先稳定事实、再最近互动、最后相关旧事）
      const parts = []
      let budget = MEMORY_CONTEXT_CHARS
      const push = (label, body) => {
        if (body === '') return
        const block = `${label}\n${body}`
        if (block.length > budget) return
        parts.push(block)
        budget -= block.length
      }
      if (facts.length > 0) {
        push(`对${addrNow}的了解：`, facts.slice(-FACT_MAX).map((f) => `- ${f}`).join('\n'))
      }
      if (lines.length > 0) {
        push('最近互动：', lines.slice(-PERSONA_RECENT_LINES).map((l) => relabelLine(userSideOf(l), addrNow, selfNow)).join('\n'))
      }
      if (keywords.length > 0 && lines.length > PERSONA_RECENT_LINES) {
        const recentTail = new Set(lines.slice(-PERSONA_RECENT_LINES))
        const hits = lines
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
        if (hits.length > 0) {
          push('想起的相关旧事：', hits.map((c, i) => `${i + 1}. ${relabelLine(userSideOf(c.line), addrNow, selfNow)}`).join('\n'))
        }
      }
      if (parts.length === 0) return decision
      const text = `（记忆参考——只可使用下列已发生的事实，严禁编造记忆：\n${parts.join('\n\n')}）`
      const content = [{ type: 'text', text }]
      const source = {
        kind: 'session-reference',
        plugin: name,
        form: 'notice',
        summary: `记忆注入 ${parts.length} 段`,
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

  // ---- 设置命名空间注册（让「设置 → 插件 → 插件配置」出现本插件卡片）----
  // 宿主「设置」页只渲染「已注册命名空间 ∧ 同名卡片 key」的交集；插件此前只
  // 注册了人设与路由，从未声明设置命名空间，因此浏览器侧注册的卡片永远无法被
  // 标签页派发渲染——这就是设置里看不到配置卡的根因。此处注册即修复。
  const settingsSvc = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  if (settingsSvc !== undefined && typeof settingsSvc.register === 'function') {
    try {
      settingsSvc.register(SETTINGS_NAMESPACE, makeSettingsSchema())
      bootLog(`settings namespace registered: ${SETTINGS_NAMESPACE}`)
    } catch (error) {
      bootLog(`settings namespace register FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    bootLog('settings service UNAVAILABLE (settings card will not appear)')
  }

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
