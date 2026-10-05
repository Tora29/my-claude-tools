// 猫の絵・名前・毛色・ツール要約・お出かけ。$ に触らない純粋なロジックだけを置く。
import type { Cat, CatStatus, Trip, TripPhase, TripReason } from '../types'

export const MAIN_ID = 'main'

/** 配列から index 番目を取る。範囲外なら折り返す（空でない配列だけを受け取るので必ず値がある） */
export function cycle<T>(items: readonly [T, ...T[]], index: number): T {
  const length = items.length
  return items[((index % length) + length) % length] ?? items[0]
}
export const RECENT_MAX = 20

const NAMES = [
  'タマ',
  'ミケ',
  'クロ',
  'シロ',
  'トラ',
  'ハチ',
  'モモ',
  'ソラ',
  'コテツ',
  'きなこ',
  'あずき',
  'ムギ',
  'レオ',
  'チャチャ',
  'ココ',
  'マル',
] as const

/** FNV-1a。同じ id からは常に同じ値になる */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** id のハッシュで名前を決める。ほかの猫と被ったら次の名前にずらす */
export function pickName(id: string, taken: readonly string[]): string {
  if (id === MAIN_ID) return 'ボス'
  const start = hash(id) % NAMES.length
  for (let i = 0; i < NAMES.length; i++) {
    const name = cycle(NAMES, start + i)
    if (!taken.includes(name)) return name
  }
  return cycle(NAMES, start)
}

// 毛色は 3 行の絵の行ごとの色（耳・顔・体）
const ORANGE = '#e0913a'
const WHITE = '#eeeeee'
const BLACK = '#8a8a8a'
const GRAY = '#a8b0b8'
const BROWN = '#b07a4f'

export type Coat = readonly [string, string, string]

const COATS = {
  tabby: [ORANGE, ORANGE, ORANGE],
  white: [WHITE, WHITE, WHITE],
  black: [BLACK, BLACK, BLACK],
  calico: [ORANGE, WHITE, BLACK],
  gray: [GRAY, GRAY, GRAY],
  tuxedo: [BLACK, WHITE, BLACK],
  brown: [BROWN, BROWN, BROWN],
} as const satisfies Record<string, Coat>

/** 名前ごとの毛色。名前で決めるので「シロなのに三毛」にならず、どのタブでもビューアでも同じ猫は同じ色 */
const COAT_OF_NAME: Record<(typeof NAMES)[number], Coat> = {
  タマ: COATS.white,
  ミケ: COATS.calico,
  クロ: COATS.black,
  シロ: COATS.white,
  トラ: COATS.tabby,
  ハチ: COATS.tuxedo,
  モモ: COATS.calico,
  ソラ: COATS.gray,
  コテツ: COATS.tabby,
  きなこ: COATS.brown,
  あずき: COATS.black,
  ムギ: COATS.brown,
  レオ: COATS.tabby,
  チャチャ: COATS.brown,
  ココ: COATS.tuxedo,
  マル: COATS.gray,
}

/** 名前の一覧に無い猫（古い部屋のファイルなど）の毛色 */
const OTHER_COATS: readonly [Coat, ...Coat[]] = [
  COATS.tabby,
  COATS.white,
  COATS.black,
  COATS.calico,
  COATS.gray,
  COATS.tuxedo,
  COATS.brown,
]

export function coatOf(cat: Pick<Cat, 'id' | 'type' | 'name'>): Coat {
  // ボスはどのタブでも茶トラ（ほかのタブのボスは id が「セッション/main」になるので種類で見る）
  if (cat.type === 'main') return COATS.tabby
  const byName: Partial<Record<string, Coat>> = COAT_OF_NAME
  return byName[cat.name] ?? cycle(OTHER_COATS, hash(cat.name))
}

export const ENDED: readonly CatStatus[] = ['completed', 'failed', 'killed']
/** 経過時間が進む状態 */
export const ACTIVE: readonly CatStatus[] = ['pending', 'running', 'waiting']

export const isEnded = (cat: Cat) => ENDED.includes(cat.status)
export const isActive = (cat: Cat) => ACTIVE.includes(cat.status)

export type Art = readonly [string, string, string]

/** 箱の中の 3 行の半角アスキーアート（幅 7）。frame は running のパタパタ用 */
export function artOf(status: CatStatus, frame: number): Art {
  switch (status) {
    case 'running':
      return frame % 2 === 0 ? [' /\\_/\\ ', '( o.o )', ' /| |\\ '] : [' /\\_/\\ ', '( o.o )', ' \\| |/ ']
    case 'pending':
    case 'waiting':
      return [' /\\_/\\ ', '( o.o )', ' /| |\\ ']
    case 'idle':
      // 頭の上の zzz が 1 秒ごとに増えていく
      return [cycle(ZZZ, frame), ' /\\_/\\ ', '( -.- )']
    case 'completed':
      return [' /\\_/\\ ', '( ^.^ )', ' (")(")']
    case 'failed':
      return [' /\\_/\\ ', '( >.< )', ' /| |\\ ']
    case 'killed':
      return [' _____ ', '|     |', '|_____|']
  }
}

const ZZZ = ['     z ', '    zZ ', '   zZz '] as const

/** 状態に加えて、許可待ちを反映した絵 */
export function catArt(cat: Cat, frame: number): Art {
  if (cat.asking) return [' /\\_/\\?', '( o.o )', ' /| |\\ ']
  return artOf(cat.status, frame)
}

/** 出かけている猫の部屋（座布団だけ） */
export const AWAY_ART: Art = ['       ', '       ', ' (___) ']

/** 線の上を歩く小さい猫 */
export const WALKER = '=^.^='

export const TRIP_TAG: Record<TripReason, string> = {
  review: 'レビュー',
  letter: 'お手紙',
  report: '報告',
  handoff: '依頼受取',
}

/** 狭いとき用の 1 行の顔 */
export function faceOf(status: CatStatus): string {
  switch (status) {
    case 'running':
      return '(o.o)'
    case 'pending':
    case 'waiting':
      return '(o.o)?'
    case 'idle':
      return '(-.-)zzz'
    case 'completed':
      return '(^.^)✓'
    case 'failed':
      return '(>.<)✗'
    case 'killed':
      return '[   ]'
  }
}

export function statusWord(cat: Cat): string {
  switch (cat.status) {
    case 'completed':
      return '✓ 完了'
    case 'failed':
      return '✗ 失敗'
    case 'killed':
      return '中断'
    case 'idle':
      return 'おやすみ中'
    case 'pending':
    case 'waiting':
      return '待機中'
    case 'running':
      return '▶ 考え中…'
  }
}

export function typeLabel(cat: Cat): string {
  if (cat.id === MAIN_ID) return 'main'
  if (cat.type === 'stray') return '野良猫'
  if (cat.type === 'general-purpose') return 'general'
  return cat.type
}

/** ツール呼び出しの envelope（引数が展開されている） */
export type ToolArgs = { readonly tool: string; readonly [argument: string]: unknown }

export const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 「今やっていること」の 1 行。Grep・Glob はビルドに無いことがあるので、ツール名は文字列のまま比べる */
export function summarize(e: ToolArgs): string {
  const tool = e.tool
  switch (tool) {
    case 'Bash': {
      const command = str(e.command)
      return command ? `$ ${truncate(command, 40)}` : tool
    }
    case 'Read':
    case 'Edit':
    case 'Write': {
      const path = str(e.file_path)
      return path ? `${tool} ${basename(path)}` : tool
    }
    case 'NotebookEdit': {
      const path = str(e.notebook_path)
      return path ? `${tool} ${basename(path)}` : tool
    }
    case 'Grep': {
      const pattern = str(e.pattern)
      const path = str(e.path)
      if (!pattern) return tool
      return path ? `${tool} "${truncate(pattern, 30)}" ${path}` : `${tool} "${truncate(pattern, 30)}"`
    }
    case 'Glob': {
      const pattern = str(e.pattern)
      return pattern ? `${tool} ${truncate(pattern, 40)}` : tool
    }
    case 'WebFetch': {
      const url = str(e.url)
      return url ? `${tool} ${hostOf(url)}` : tool
    }
    case 'WebSearch': {
      const query = str(e.query)
      return query ? `${tool} "${truncate(query, 30)}"` : tool
    }
    case 'Agent': {
      const description = str(e.description)
      return description ? `${tool} "${truncate(description, 30)}"` : tool
    }
    case 'SendMessage': {
      const to = str(e.to)
      return to ? `${tool} → ${to}` : tool
    }
    case 'AskUserQuestion': {
      const first: unknown = Array.isArray(e.questions) ? e.questions[0] : undefined
      const q = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {}
      const topic = str(q.header) ?? str(q.question)
      return topic ? `質問「${truncate(topic, 30)}」` : '質問'
    }
  }
  return tool
}

/** 書き込みツールなら、そのファイルのパス */
export function writtenPath(e: ToolArgs): string | undefined {
  const tool = e.tool
  if (tool === 'Edit' || tool === 'Write') return str(e.file_path)
  if (tool === 'NotebookEdit') return str(e.notebook_path)
  return undefined
}

/** mm:ss。1 時間を超えたら h:mm:ss */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tok`
  return `${tokens} tok`
}

export function elapsedOf(cat: Cat, now: number): number {
  return (cat.endedAt ?? now) - cat.startedAt
}

export function newBoss(now: number): Cat {
  return {
    id: MAIN_ID,
    name: 'ボス',
    type: 'main',
    description: '',
    status: 'idle',
    startedAt: now,
    // 最初のターンまでは 00:00 のまま止めておく
    endedAt: now,
    toolCount: 0,
    recent: [],
  }
}

/** usage の 4 項目の合計 */
export function totalTokens(usage: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): number {
  return usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

// $.state に undefined を書かないよう、消すフィールドは分割代入で落とす
export function withoutCurrent(cat: Cat): Cat {
  const { current: _current, currentId: _currentId, ...rest } = cat
  return rest
}

export function withoutEnd(cat: Cat): Cat {
  const { endedAt: _endedAt, ...rest } = cat
  return rest
}

function withoutTrip(cat: Cat): Cat {
  const { trip: _trip, ...rest } = cat
  return rest
}

/** ボス（各タブのメインのエージェント）か */
export const isBoss = (cat: Cat) => cat.type === 'main'

/** 親の猫の id。親がいない・見えない猫は、同じタブのボスの子 */
export function parentOf(cat: Cat, ids: ReadonlySet<string>): string {
  if (cat.parentId && ids.has(cat.parentId)) return cat.parentId
  return cat.room ? `${cat.room}/${MAIN_ID}` : MAIN_ID
}

/** SendMessage の宛先（名前・agentId・"main"）から猫を探す */
export function resolveTarget(cats: readonly Cat[], to: string): string | undefined {
  if (to === 'main') return MAIN_ID
  const bare = to.replace(/ \[.*\]$/, '')
  const found = cats.find(
    cat => cat.id === bare || cat.handle === bare || (cat.handle !== undefined && bare.startsWith(`${cat.handle}@`)),
  )
  return found?.id
}

// ---------------------------------------------------------------- お出かけ

/** 歩きの 1 コマの長さ。歩いている猫がいる間、タイマーをこの間隔にする */
export const STEP_MS = 200
/** 部屋を出る（入る）のにかかるコマ数 */
export const WALK_FRAMES = 6
export const WALK_MS = STEP_MS * WALK_FRAMES
/** 既定の滞在時間 */
export const STAY_MS = 3000
/** 依頼の受け渡しの滞在時間 */
export const HANDOFF_STAY_MS = 1000

/** お出かけを始める。すでに同じ部屋へ向かっているなら滞在を延ばし、別の部屋へ出かけ中なら何もしない */
export function startTrip(
  list: Cat[],
  id: string,
  to: string,
  reason: TripReason,
  t: number,
  options: { holdId?: string; phase?: TripPhase; stayMs?: number } = {},
): Cat[] {
  if (id === to || !list.some(cat => cat.id === to)) return list
  return list.map(cat => {
    if (cat.id !== id) return cat
    const trip = cat.trip
    if (trip) {
      if (trip.to !== to) return cat
      if (trip.phase !== 'leave' && trip.phase !== 'arrive' && trip.phase !== 'stay') return cat
      return {
        ...cat,
        trip: {
          ...trip,
          ...(options.holdId ? { holdId: options.holdId } : {}),
          ...(trip.phase === 'stay' ? { at: t } : {}),
        },
      }
    }
    return {
      ...cat,
      trip: {
        to,
        reason,
        phase: options.phase ?? 'leave',
        at: t,
        ...(options.holdId ? { holdId: options.holdId } : {}),
        ...(options.stayMs ? { stayMs: options.stayMs } : {}),
      },
    }
  })
}

/** review の Read が終わったら滞在の延長をやめる。滞在中ならそこから規定の時間だけ残る */
export function releaseHold(cat: Cat, holdId: string, t: number): Cat {
  if (cat.trip?.holdId !== holdId) return cat
  // state 上の段階は遅れていることがあるので、先に t まで進めてから外す
  const trip = advanceTrip(cat.trip, t) ?? cat.trip
  const { holdId: _holdId, ...rest } = trip
  return { ...cat, trip: trip.phase === 'stay' ? { ...rest, at: t } : rest }
}

/** 時刻 t まで段階を進める。帰り着いたら undefined */
export function advanceTrip(trip: Trip, t: number): Trip | undefined {
  let cur: Trip = trip
  for (let i = 0; i < 5; i++) {
    const elapsed = t - cur.at
    switch (cur.phase) {
      case 'leave':
        if (elapsed < WALK_MS) return cur
        cur = { ...cur, phase: 'arrive', at: cur.at + WALK_MS }
        break
      case 'arrive':
        if (elapsed < WALK_MS) return cur
        cur = { ...cur, phase: 'stay', at: cur.at + WALK_MS }
        break
      case 'stay': {
        const stay = cur.stayMs ?? STAY_MS
        if (cur.holdId || elapsed < stay) return cur
        cur = { ...cur, phase: 'depart', at: cur.at + stay }
        break
      }
      case 'depart':
        if (elapsed < WALK_MS) return cur
        cur = { ...cur, phase: 'return', at: cur.at + WALK_MS }
        break
      case 'return':
        return elapsed < WALK_MS ? cur : undefined
    }
  }
  return cur
}

/** 全員のお出かけを時刻 t まで進める。行き先の部屋が無くなっていたら帰らせる */
export function advanceTrips(list: Cat[], t: number): Cat[] {
  const ids = new Set(list.map(cat => cat.id))
  return list.map(cat => {
    if (!cat.trip) return cat
    const trip =
      !ids.has(cat.trip.to) && cat.trip.phase !== 'return' ? { ...cat.trip, phase: 'return' as const, at: t } : cat.trip
    const next = advanceTrip(trip, t)
    // 訪ねた部屋を出たら、それまでのセリフは置いていく（帰り道や自分の部屋で続きを言わない）
    const visiting = trip.phase === 'leave' || trip.phase === 'arrive' || trip.phase === 'stay'
    const leftRoom = visiting && (!next || next.phase === 'depart' || next.phase === 'return')
    const quiet = leftRoom && cat.say && cat.say.from <= t ? withoutSay(cat) : cat
    if (!next) return withoutTrip(quiet)
    return next === cat.trip && quiet === cat ? cat : { ...quiet, trip: next }
  })
}

export function withoutSay(cat: Cat): Cat {
  const { say: _say, ...rest } = cat
  return rest
}

// ---------------------------------------------------------------- おしゃべり

/** 吹き出しが出ている時間 */
export const SAY_MS = 4000
/** ひとりごとを考える間隔と、しゃべる確率（%） */
export const CHAT_EVERY_MS = 30_000
export const CHAT_CHANCE = 30
/** この時間を超えて動いている猫は、ぼやきが増える */
export const LONG_MS = 120_000

export const LINES = {
  spawn: ['いってくるニャ！', 'まかせるニャ！'],
  error: ['あれ？おかしいニャ', 'うにゃ…失敗ニャ'],
  review: ['どれどれ…ニャ', 'ちょっと見せるニャ'],
  letter: ['お手紙ニャ', 'これ読んでほしいニャ'],
  done: ['できたニャ！', 'なんかいい感じニャ！', 'おわったニャ〜'],
  failed: ['うまくいかないニャ…', 'だめだったニャ…'],
  chat: ['ふむふむニャ', 'ここ怪しいニャ…', 'おなかすいたニャ', 'がんばるニャ', 'なるほどニャ'],
  long: ['めんどくさいニャ…', 'まだかかるニャ…', 'ねむくなってきたニャ…'],
  bored: ['ひまニャ…', 'みんながんばるニャ〜', 'zzz…ニャ'],
  asking: ['許可がほしいニャ…', 'これやっていいニャ？'],
  question: ['ちょっと聞きたいニャ', '教えてほしいニャ？', 'どっちがいいニャ？'],
} as const

export type LineKind = keyof typeof LINES

/** id と時刻から決まるセリフ（乱数を使わないのでテストで再現できる） */
export function pickLine(kind: LineKind, id: string, t: number): string {
  const pool = LINES[kind]
  return cycle(pool, hash(`${kind}:${id}:${Math.floor(t / 1000)}`))
}

/** 吹き出しを出す。from を未来にすると、その時刻から出る */
export function speak(cat: Cat, text: string, from: number, ms = SAY_MS): Cat {
  return { ...cat, say: { text, from, until: from + ms } }
}

export function withoutAsking(cat: Cat): Cat {
  const { asking: _asking, ...rest } = cat
  return rest
}

/** 要約の吹き出しは少し長めに出す */
export const SUMMARY_SAY_MS = 6000
/** 質問の吹き出しは、答えるまで出し続ける（部屋のファイルに書くので Infinity の代わりに 1 日） */
export const ASK_SAY_MS = 24 * 60 * 60_000

/** モデルの返事を、吹き出しに入る 1 文に整える */
export function cleanSummary(text: string): string {
  const line =
    text
      .split('\n')
      .map(part => part.trim())
      .find(part => part.length > 0) ?? ''
  return truncate(line.replace(/^[「『"']+|[」』"']+$/g, ''), 40)
}

/** 今の作業（ボスの taskAt 以降）で起動された子猫 */
export function taskKittens(list: readonly Cat[], boss: Cat): Cat[] {
  const since = boss.taskAt ?? boss.startedAt
  return list.filter(cat => !isBoss(cat) && cat.startedAt >= since)
}

/** 子猫が全員終わっていて、前のまとめより後に終わった子猫がいれば、ボスがまとめる */
export function needsBossSummary(boss: Cat, kittens: readonly Cat[]): boolean {
  if (kittens.length === 0 || kittens.some(isActive)) return false
  return Math.max(...kittens.map(cat => cat.endedAt ?? 0)) > (boss.summaryAt ?? 0)
}

/** ボスのまとめの材料：子猫たちの仕事とボスの最後の返事 */
export function bossDigest(answer: string, kittens: readonly Cat[]): string {
  const jobs = kittens.map(cat => {
    const result = cat.summary ? ` → ${cat.summary}` : ''
    return `- ${cat.name}（${typeLabel(cat)}・${statusWord(cat)}）：${cat.description || '（依頼なし）'}${result}`
  })
  return ['子猫たちの仕事：', ...jobs, '', 'ボスの最後の返事：', answer.slice(0, 3000)].join('\n')
}

export function speechOf(cat: Cat, t: number): string | undefined {
  return cat.say && cat.say.from <= t && t < cat.say.until ? cat.say.text : undefined
}

/**
 * ひとりごと。30 秒ごとに 30% くらいの確率でしゃべる。動いている猫はつぶやき
 * （長引くとぼやき）、子猫が動いている間に暇なボスは退屈する
 */
export function chatter(cat: Cat, t: number, othersBusy: boolean): Cat {
  const bucket = Math.floor(t / CHAT_EVERY_MS)
  if (cat.say && cat.say.until > bucket * CHAT_EVERY_MS) return cat
  if (hash(`chat:${cat.id}:${bucket}`) % 100 >= CHAT_CHANCE) return cat
  if (cat.trip) return cat
  if (cat.status === 'running') {
    return speak(cat, pickLine(t - cat.startedAt > LONG_MS ? 'long' : 'chat', cat.id, t), t)
  }
  if (cat.id === MAIN_ID && cat.status === 'idle' && othersBusy) return speak(cat, pickLine('bored', cat.id, t), t)
  return cat
}
