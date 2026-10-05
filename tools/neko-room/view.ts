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
import { foreignCats, foreignLinks } from '../../plugins/neko-agents/hooks/rooms'
import type { Cat, Link, Room } from '../../plugins/neko-agents/types'
import { type BoxContent, draw, type Layout, layout, type Run, textWidth, walkerAt } from './graph'

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
      // 許可待ちは 1 秒ごとに枠を赤く点滅させる
      ...(cat.asking && frame % 2 === 0
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
      busy: !trip && (!!cat.current || !!cat.asking),
    }
  }

  // 最新の報告（要約）。summaryAt の無い古いファイルは終わった時刻で比べる
  const reportedAt = (cat: Cat) => cat.summaryAt ?? cat.endedAt ?? 0
  const reported = list.filter(cat => cat.summary).sort((a, b) => reportedAt(b) - reportedAt(a))[0]

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
    reported,
    doingOf,
    content,
    /** そのタブ（このタブは ''）のプロジェクト名 */
    projectOf: (key: string) =>
      key === ''
        ? list.find(cat => isBoss(cat) && !cat.room)?.project
        : others.find(room => room.session === key)?.project,
  }
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
