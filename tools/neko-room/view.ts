// ねこ部屋の見た目の組み立て。neko-agents（Mod）が書き出した部屋から、ビューアに描くものを作る。
// $ に触らない純粋なロジック。
import {
  advanceTrip,
  advanceTrips,
  AWAY_ART,
  catArt,
  coatOf,
  elapsedOf,
  faceOf,
  formatElapsed,
  formatTokens,
  isActive,
  isBoss,
  isEnded,
  parentOf,
  speechOf,
  statusWord,
  TRIP_TAG,
  typeLabel,
} from '../../plugins/neko-agents/hooks/cats'
import { answerLine, FREEFORM, isChosen } from '../../plugins/neko-agents/hooks/questions'
import { foreignAsks, foreignCats, foreignLinks } from '../../plugins/neko-agents/hooks/rooms'
import type { Ask, Cat, Link, Room } from '../../plugins/neko-agents/types'
import { type BoxContent, charWidth, draw, type Layout, layout, type Run, textWidth, walkerAt } from './graph'

/** 子猫がこの数を超えたら、古い終わった猫から「帰宅した猫」として隠す */
export const MAX_KITTENS = 6
/** 報告（要約）の色。吹き出しと同じ黄色 */
export const REPORT_COLOR = '#f0c674'

/** 子猫が多すぎるときは、古い終わった猫から隠す（出かけ中・お客さんがいる猫は残す） */
export function splitHome(list: readonly Cat[]): { shown: Cat[]; home: Cat[] } {
  const kittens = list.filter(cat => !isBoss(cat))
  const extra = kittens.length - MAX_KITTENS
  if (extra <= 0) return { shown: [...list], home: [] }
  const busy = new Set(list.flatMap(cat => (cat.trip ? [cat.id, cat.trip.to] : [])))
  const home = kittens
    .filter(cat => isEnded(cat) && !busy.has(cat.id))
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    .slice(0, extra)
  return { shown: list.filter(cat => !home.includes(cat)), home }
}

export type SceneInput = {
  /** このタブの猫（ビューアでは空） */
  mine: readonly Cat[]
  myLinks: readonly Link[]
  /** ほかのタブから読み込んだ部屋 */
  others: readonly Room[]
  /** 片付けて隠した、ほかのタブの猫の id */
  hidden?: ReadonlySet<string>
  t: number
  selectedId?: string
}

export type Scene = ReturnType<typeof buildScene>

/** 描く材料をそろえる。お出かけは時刻 t まで進めて見せる */
export function buildScene(input: SceneInput) {
  const { others, t, selectedId = '' } = input
  const visitors = others.flatMap(foreignCats).filter(cat => !input.hidden?.has(cat.id))
  const links = [...input.myLinks, ...others.flatMap(foreignLinks)]
  const asks = others.flatMap(foreignAsks).sort((a, b) => a.askedAt - b.askedAt)
  /** 回答を待っている猫 → その質問（同じ猫に複数あれば新しいほう） */
  const waiting = new Map(asks.filter(ask => ask.status === 'open').map(ask => [ask.catId, ask]))
  const list = advanceTrips([...input.mine, ...visitors], t)
  const frame = Math.floor(t / 1000)
  const byId = new Map(list.map(cat => [cat.id, cat]))
  const ids = new Set(byId.keys())
  const nameOf = (id: string) => byId.get(id)?.name ?? '?'
  const tabs = list.filter(isBoss).length
  const { shown, home } = splitHome(list)

  const stayingAt = (host: string) =>
    list.filter(cat => {
      const trip = cat.trip && advanceTrip(cat.trip, t)
      return cat.id !== host && trip?.to === host && trip.phase === 'stay'
    })

  const doingOf = (cat: Cat): string => {
    const trip = cat.trip && advanceTrip(cat.trip, t)
    if (trip) return `留守 → ${nameOf(trip.to)}`
    const ask = waiting.get(cat.id)
    if (ask) return `? 回答待ち「${topicOf(ask)}」`
    if (cat.asking) return `? ${cat.asking} の許可待ち`
    if (cat.current) return `▶ ${cat.current}`
    if (cat.description && !isEnded(cat)) return `「${cat.description}」`
    return statusWord(cat)
  }

  const content = (cat: Cat): BoxContent => {
    const trip = cat.trip && advanceTrip(cat.trip, t)
    const guests = stayingAt(cat.id)
    const first = guests[0]
    const note = first?.trip
      ? `+${first.name}:${TRIP_TAG[first.trip.reason]}${guests.length > 1 ? ` 他${guests.length - 1}` : ''}`
      : [
          isBoss(cat) ? (tabs > 1 ? cat.project : undefined) : typeLabel(cat),
          `${cat.toolCount} tools`,
          cat.tokens ? formatTokens(cat.tokens) : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
    // セリフは猫がいる場所に出す：自分の部屋にいれば自分の箱、訪ねた先ならその箱に名前付きで
    const talking = guests.find(guest => speechOf(guest, t))
    const speech = trip ? undefined : speechOf(cat, t)
    const guestLine = talking && speechOf(talking, t)
    const bubble = speech
      ? [`「${speech}」`]
      : guestLine
        ? [`${talking.name}「${guestLine}」`, `「${guestLine}」`]
        : undefined
    return {
      ...(bubble ? { speech: bubble } : {}),
      // 許可待ち・回答待ちは 1 秒ごとに枠を赤く点滅させる
      ...((cat.asking || waiting.has(cat.id)) && frame % 2 === 0
        ? { highlight: 'alert' as const }
        : cat.id === selectedId
          ? { highlight: 'selected' as const }
          : {}),
      art: trip ? AWAY_ART : catArt(cat, frame),
      coat: coatOf(cat),
      name: cat.name,
      elapsed: formatElapsed(elapsedOf(cat, t)),
      doing: doingOf(cat),
      note,
      busy: !trip && (!!cat.current || !!cat.asking || waiting.has(cat.id)),
    }
  }

  return {
    t,
    list,
    links,
    others,
    byId,
    ids,
    nameOf,
    tabs,
    shown,
    home,
    working: list.filter(cat => !isBoss(cat) && isActive(cat)).length,
    ended: list.filter(cat => !isBoss(cat) && isEnded(cat) && !cat.trip),
    asks,
    doingOf,
    content,
    /** そのタブ（このタブは ''）のプロジェクト名 */
    projectOf: (key: string) =>
      key === ''
        ? list.find(cat => isBoss(cat) && !cat.room)?.project
        : others.find(room => room.session === key)?.project,
  }
}

/** そのタブ（key）の最新の報告（要約）。key を省くと全タブで */
export function reportedIn(scene: Scene, key?: string): Cat | undefined {
  // summaryAt の無い古いファイルは終わった時刻で比べる
  const reportedAt = (cat: Cat) => cat.summaryAt ?? cat.endedAt ?? 0
  return scene.list
    .filter(cat => cat.summary && (key === undefined || (cat.room ?? '') === key))
    .sort((a, b) => reportedAt(b) - reportedAt(a))[0]
}

/** 報告の 1 行。ボスの要約は「まとめ」 */
export function reportLine(cat: Cat): string {
  return `${cat.name}の${isBoss(cat) ? 'まとめ' : '報告'}：${cat.summary ?? ''}`
}

/** ヘッダーの 1 行 */
export function headline(scene: Scene): string {
  return `作業中の子猫 ${scene.working} 匹${scene.tabs > 1 ? ` · タブ ${scene.tabs} つ` : ''}${scene.home.length > 0 ? ` · 帰宅した猫 ×${scene.home.length}` : ''}`
}

export type Section = { key: string; lay: Layout; rows: Run[][]; title: string }

/**
 * タブごとに区画を分けて縦に積む。このタブ（''）が一番上で、区画ごとに幅を全部使って描く。
 * label は区画の見出しの文言（プロジェクト名は解決済みで渡す）
 */
export function sections(scene: Scene, width: number, label: (key: string, project: string) => string): Section[] {
  const keys = [...new Set(scene.shown.map(cat => cat.room ?? ''))].sort((a, b) =>
    a === '' ? -1 : b === '' ? 1 : a.localeCompare(b),
  )
  return keys.map(key => {
    const members = scene.shown.filter(cat => (cat.room ?? '') === key)
    const lay = layout(members, scene.links, width)
    const walkers = members.flatMap(cat => {
      const at = walkerAt(lay, cat, scene.t)
      const speech = speechOf(cat, scene.t)
      return at ? [{ x: at[0], y: at[1], color: coatOf(cat)[1], ...(speech ? { speech } : {}) }] : []
    })
    const head = `── ${label(key, scene.projectOf(key) ?? '?')} `
    return {
      key,
      lay,
      rows: draw(lay, scene.content, walkers),
      title: head + '─'.repeat(Math.max(0, width - textWidth(head))),
    }
  })
}

/** 狭いとき用：1 匹 1 行 */
export function narrowLines(scene: Scene): { key: string; text: string; color: string; dim: boolean }[] {
  return [...scene.shown]
    .sort(
      (a, b) =>
        (a.room ?? '').localeCompare(b.room ?? '') ||
        Number(isBoss(b)) - Number(isBoss(a)) ||
        a.startedAt - b.startedAt,
    )
    .map(cat => {
      const parent = isBoss(cat) ? undefined : scene.byId.get(parentOf(cat, scene.ids))
      const depth = !parent ? 0 : isBoss(parent) ? 1 : 2
      const away = cat.trip ? ` → ${scene.nameOf(cat.trip.to)}` : cat.current ? ` ▶ ${cat.current}` : ''
      return {
        key: cat.id,
        text: `${'  '.repeat(depth)}${faceOf(cat.status)} ${cat.name} ${formatElapsed(elapsedOf(cat, scene.t))}${away}`,
        color: coatOf(cat)[2],
        dim: isEnded(cat),
      }
    })
}

// ---------------------------------------------------------------- 質問の吹き出し

/** 図の下に出す 1 行。幅に折り返し済み */
export type Line = { text: string; color?: string; bold?: boolean; dim?: boolean }

/** 選んだ選択肢の色 */
export const CHOSEN_COLOR = '#8bd17c'
/** 質問した猫が回答の記録で過去の答えを並べる数 */
const PAST_MAX = 5

/** 質問の見出し（最初の質問の header か質問文） */
export function topicOf(ask: Ask): string {
  const first = ask.questions[0]
  return first?.header ?? first?.question ?? '質問'
}

/** 行の頭に置かない文字（句読点・閉じかっこ・小さいかな・のばす音など） */
const NO_START = new Set(
  Array.from('。、，．・：；？！）」』】〕〉》ー…ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ.,:;!?)]}'),
)
/** 行の終わりに置かない文字（開きかっこ） */
const NO_END = new Set(Array.from('（「『【〔〈《([{'))

/**
 * 折り返す位置を決める。chars を [0, cut) と [cut, …) に分け、後ろは next と一緒に次の行へ送る。
 * 英数字の単語の途中なら単語の前で、次の行が句読点などで始まるならその前の文字ごと、
 * 行の終わりが開きかっこならそのかっこごと次の行へ送る（送りすぎて行が空にならない範囲で）
 */
function breakAt(chars: readonly string[], next: string, limit: number): number {
  let cut = chars.length
  // 行の半分より長い単語は、送らずにそのまま途中で切る
  const word = /[!-~]+$/.exec(chars.join(''))?.[0] ?? ''
  if (next !== ' ' && /[!-~]/.test(next) && word.length < chars.length && word.length < limit / 2) {
    cut -= word.length
  }
  for (let moved = true; moved && cut > 1;) {
    moved = false
    if (NO_START.has(chars[cut] ?? next) && cut > 1) {
      cut--
      moved = true
    }
    if (NO_END.has(chars[cut - 1] ?? '') && cut > 1) {
      cut--
      moved = true
    }
  }
  return cut
}

/**
 * 全角を 2 桁として width 桁ごとに折り返す。2 行目からは indent を付ける。
 * 英数字の単語を途中で切らず、句読点や閉じかっこを行の頭に、開きかっこを行の終わりに置かない（禁則）
 */
export function wrap(text: string, width: number, indent = ''): string[] {
  const lines: string[] = []
  let chars: string[] = []
  let used = 0
  const room = Math.max(1, width - textWidth(indent))
  for (const ch of text.replace(/\s+/g, ' ').trim()) {
    const w = charWidth(ch)
    const limit = lines.length === 0 ? width : room
    if (used + w > limit && chars.length > 0) {
      const cut = breakAt(chars, ch, limit)
      lines.push(chars.slice(0, cut).join('').trimEnd())
      chars = chars.slice(cut)
      while (chars[0] === ' ') chars.shift()
      used = textWidth(chars.join(''))
      if (ch === ' ' && chars.length === 0) continue
    }
    chars.push(ch)
    used += w
  }
  if (chars.length > 0 || lines.length === 0) lines.push(chars.join(''))
  return lines.map((part, i) => (i === 0 ? part : indent + part))
}

const out = (text: string, width: number, style: Omit<Line, 'text'> = {}, indent = ''): Line[] =>
  wrap(text, width, indent).map(part => ({ text: part, ...style }))

/** 猫口調の解説（### 見出し付きの Markdown）を、吹き出しの行にする */
function explanationLines(text: string, width: number): Line[] {
  return text.split('\n').flatMap(raw => {
    const plain = raw
      .replace(/\*\*|__|`/g, '')
      .replace(/^(\s*)[-*+]\s+/, '$1・')
      .trimEnd()
    if (!plain.trim()) return []
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(plain)
    if (heading) {
      const title = heading[2] ?? ''
      return out(heading[1] === '###' ? `【${title}】` : title, width - 2, { color: REPORT_COLOR, bold: true }).map(
        line => ({ ...line, text: `  ${line.text}` }),
      )
    }
    const recommend = /^\s*→/.test(plain)
    return out(plain.trim(), width - 4, { color: REPORT_COLOR, bold: recommend }, '  ').map(line => ({
      ...line,
      text: `    ${line.text}`,
    }))
  })
}

/** 質問の欄の見出し。タブの区画の見出し（── ）と見分けられるよう、字下げして点線で引く */
function rule(title: string, width: number): Line {
  const head = `  ┄┄ ${title} `
  return { text: head + '┄'.repeat(Math.max(0, width - textWidth(head))), dim: true }
}

/** 質問の中身：見出し・質問文・選択肢（答えたものは ✔） */
function questionLines(ask: Ask, width: number): Line[] {
  return ask.questions.flatMap((q, qi) => {
    const tag = q.header ? `[${q.header}] ` : ''
    const many = q.multiSelect ? '（複数選べる）' : ''
    const lines = out(`${tag}Q${qi + 1}. ${q.question}${many}`, width - 2, { bold: true }, '  ').map(line => ({
      ...line,
      text: `  ${line.text}`,
    }))
    q.options.forEach((o, oi) => {
      const chosen = isChosen(ask, q, o.label)
      const mark = chosen ? '✔' : `${oi + 1}.`
      const description = o.description ? ` — ${o.description}` : ''
      lines.push(
        ...out(
          `${mark} ${o.label}${description}`,
          width - 4,
          chosen ? { color: CHOSEN_COLOR, bold: true } : {},
          '   ',
        ).map(line => ({ ...line, text: `    ${line.text}` })),
      )
    })
    const answer = ask.answers[q.question]
    if (ask.status === 'answered' && answer !== undefined && !q.options.some(o => isChosen(ask, q, o.label))) {
      lines.push(...out(`→ ${answer}`, width - 4, { color: CHOSEN_COLOR }).map(l => ({ ...l, text: `    ${l.text}` })))
    }
    return lines
  })
}

/** 過去の質問と答え：1 つの質問につき「見出し → 答え」の 1 行 */
/**
 * 過去の質問と答え：1 つの質問につき「名前：[見出し] 質問文 → 答え」の 1 行。
 * 幅が足りなければ答えではなく質問文のほうを縮め、それでも入らなければ質問文を省く
 */
function pastLines(
  list: readonly Ask[],
  nameOf: (id: string) => string,
  width: number,
  indent = '  ',
  suffix = '',
): Line[] {
  return list.flatMap(ask =>
    ask.questions.map(q => {
      const color = ask.status === 'answered' ? CHOSEN_COLOR : undefined
      const head = `${indent}${nameOf(ask.catId)}：${q.header ? `[${q.header}] ` : ''}`
      const tail = `→ ${answerLine(ask, q).replace(/\s+/g, ' ')}${suffix}`
      const room = width - textWidth(head) - textWidth(tail) - 1
      const question = room >= 8 ? `${fitText(q.question, room)} ` : ''
      return { text: fitText(head + question + tail, width), ...(color ? { color } : { dim: true }) }
    }),
  )
}

/**
 * 図の下に出す、質問の吹き出し。回答待ちの質問があれば、質問した猫が質問の中身と
 * 猫口調の解説をしゃべり、同じタブの過去の答えを並べる。history なら全部の質問の記録を出す
 */
export function askLines(scene: Scene, width: number, history = false, key?: string): Line[] {
  const lines: Line[] = []
  // タブの区画の中に出すとき（key あり）は、そのタブの質問だけ。区画の見出しがあるのでタブの名前は付けない
  const asks = key === undefined ? scene.asks : scene.asks.filter(ask => ask.room === key)
  const label = (ask: Ask & { room?: string }) =>
    key === undefined && scene.tabs > 1 ? `（${scene.projectOf(ask.room ?? '') ?? '?'}）` : ''
  const open = asks.filter(ask => ask.status === 'open')
  for (const ask of open) {
    const name = scene.nameOf(ask.catId)
    lines.push(rule(`${name}の質問（回答待ち）${label(ask)}`, width))
    lines.push(...out(`${name}「${topicOf(ask)}について聞きたいニャ」`, width, { color: REPORT_COLOR }))
    lines.push(...questionLines(ask, width))
    // 回答待ちの間に子猫の報告が届いたら、前の解説を出したまま考え直す
    const revised = ask.revisedFor?.join('・')
    if (ask.explain === 'pending') {
      const thinking = revised && ask.explanation ? `${revised}の報告が来たから考え直してるニャ…` : '考え中ニャ…'
      lines.push(...out(`  ${name}「${thinking}」`, width, { dim: true }))
    }
    if (ask.explain === 'error') lines.push({ text: `  ${name}「うまく説明できないニャ…」`, dim: true })
    if ((ask.explain === 'done' || ask.explain === 'pending') && ask.explanation) {
      if (ask.explain === 'done') {
        const intro = revised ? `${revised}の報告が来たから考え直したニャ` : '答える前に聞いてほしいニャ'
        lines.push(...out(`${name}「${intro}」`, width, { color: REPORT_COLOR }))
      }
      lines.push(...explanationLines(ask.explanation, width))
    }
    const past = asks
      .filter(one => one.status !== 'open' && one.room === ask.room)
      .slice(-PAST_MAX)
      .reverse()
    if (past.length > 0) {
      lines.push({ text: '  これまでの答え', bold: true })
      lines.push(...pastLines(past, scene.nameOf, width))
    }
  }
  const done = asks.filter(ask => ask.status !== 'open')
  if (history && done.length > 0) {
    lines.push(rule('質問の記録（新しい順）', width))
    for (const ask of [...done].reverse()) {
      const name = scene.nameOf(ask.catId)
      const tail = ask.status === 'cancelled' ? '（キャンセル）' : ''
      lines.push({ text: `  ${name}の質問${label(ask)}${tail}`, bold: true })
      lines.push(...questionLines(ask, width))
      const freeform = ask.answers[FREEFORM]
      if (freeform) lines.push(...out(`    → ${freeform}`, width, { color: CHOSEN_COLOR }))
    }
  } else if (open.length === 0 && done.length > 0) {
    const last = done[done.length - 1]
    if (last) {
      lines.push(...pastLines([last], scene.nameOf, width, '', '（h で質問の記録）').slice(0, 1))
    }
  }
  return lines
}

// ---------------------------------------------------------------- 猫の詳細

/**
 * クリックした猫の詳細：今の様子・依頼・報告・最近の操作（新しい順）。
 * rows 行に収め、入りきらない分は古い操作から削る。猫が見つからなければ空
 */
export function detailLines(scene: Scene, id: string, width: number, rows: number): Line[] {
  const cat = scene.byId.get(id)
  if (!cat || rows <= 0) return []
  const kind = isBoss(cat) ? (scene.tabs > 1 ? cat.project : undefined) : typeLabel(cat)
  const head = rule(`${cat.name}の詳細${kind ? `（${kind}）` : ''}  Esc で閉じる`, width)
  const stats = [
    scene.doingOf(cat),
    formatElapsed(elapsedOf(cat, scene.t)),
    `${cat.toolCount} tools`,
    cat.tokens ? formatTokens(cat.tokens) : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  const parent = isBoss(cat) ? undefined : scene.byId.get(parentOf(cat, scene.ids))
  const lines: Line[] = [head, ...out(`様子：${stats}`, width - 2, {}, '      ').map(indent)]
  if (cat.description) {
    const from = parent ? `${parent.name}からの依頼` : '依頼'
    lines.push(...out(`${from}：${cat.description}`, width - 2, {}, '  ').map(indent))
  }
  if (cat.summary) {
    const label = isBoss(cat) ? 'まとめ' : '報告'
    lines.push(...out(`${label}：${cat.summary}`, width - 2, { color: REPORT_COLOR }, '  ').map(indent))
  }
  const recent = cat.recent.map(op => ({ text: `    ${fitText(op, width - 4)}`, dim: true }))
  const fixed = lines.slice(0, rows)
  const room = rows - fixed.length - 1
  if (room <= 0) return fixed
  const shown = recent.slice(0, room)
  const title =
    recent.length > shown.length
      ? `最近の操作（新しい順に ${shown.length} / ${recent.length} 件）`
      : '最近の操作（新しい順）'
  return [...fixed, { text: `  ${recent.length > 0 ? title : '最近の操作：まだありません'}`, bold: true }, ...shown]
}

const indent = (line: Line): Line => ({ ...line, text: `  ${line.text}` })

/** はみ出す分を … で切る（埋めはしない） */
function fitText(text: string, width: number): string {
  if (textWidth(text) <= width) return text
  let used = 0
  let cut = ''
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > width - 1) break
    cut += ch
    used += w
  }
  return `${cut}…`
}
