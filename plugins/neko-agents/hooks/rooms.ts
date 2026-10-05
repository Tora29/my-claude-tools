// ほかのタブ（セッション）とねこ部屋を共有する。$ に触らない純粋なロジック。
import type { Ask, Cat, Link, Room } from '../types'
import { MAIN_ID } from './cats'

/** ホームディレクトリの下の、部屋のファイルを置く場所 */
export const ROOMS_DIR = '.claude/neko-agents/rooms'
/** この時間更新のないタブは、閉じ忘れとみなして表示しない */
export const STALE_MS = 10 * 60_000
/** 変化がなくても、動いている猫がいる間はこの間隔で書き直して生きていることを示す */
export const HEARTBEAT_MS = 60_000
/** 書き出しをまとめる間隔 */
export const PUBLISH_DELAY_MS = 500

export const roomFile = (dir: string, session: string) => `${dir}/${session}.json`

export function projectOf(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** 書き出す中身。ほかのタブから来た猫（room 付き）は含めない */
export function snapshot(
  session: string,
  project: string,
  t: number,
  cats: readonly Cat[],
  links: readonly Link[],
  asks: readonly Ask[],
  closed = false,
): Room {
  return {
    session,
    project,
    updatedAt: t,
    ...(closed ? { closed: true } : {}),
    cats: cats.filter(cat => !cat.room),
    links: [...links],
    ...(asks.length > 0 ? { asks: [...asks] } : {}),
  }
}

/** 書き出すかどうかを比べるための中身（時刻を除く） */
export const contentKey = (room: Room) =>
  JSON.stringify({ closed: room.closed ?? false, cats: room.cats, links: room.links, asks: room.asks ?? [] })

export function isLive(room: Room, t: number): boolean {
  return !room.closed && t - room.updatedAt < STALE_MS
}

/** 読み込んだファイルの中身を確かめる。壊れていたり形が違ったりしたら捨てる */
export function parseRoom(text: string): Room | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return undefined
    const room = value as Partial<Room>
    if (typeof room.session !== 'string' || typeof room.updatedAt !== 'number' || !Array.isArray(room.cats))
      return undefined
    return {
      session: room.session,
      project: typeof room.project === 'string' ? room.project : '?',
      updatedAt: room.updatedAt,
      ...(room.closed ? { closed: true } : {}),
      cats: room.cats,
      links: Array.isArray(room.links) ? room.links : [],
      ...(Array.isArray(room.asks) && room.asks.length > 0 ? { asks: room.asks } : {}),
    }
  } catch {
    return undefined
  }
}

/** ほかのタブの猫を、自分の猫と id がぶつからないよう「セッション/id」にして取り込む */
export function foreignCats(room: Room): Cat[] {
  const prefix = (id: string) => `${room.session}/${id}`
  return room.cats.map(cat => {
    const isMain = cat.id === MAIN_ID
    return {
      ...cat,
      id: prefix(cat.id),
      room: room.session,
      ...(isMain ? { project: room.project } : { parentId: prefix(cat.parentId ?? MAIN_ID) }),
      ...(cat.trip ? { trip: { ...cat.trip, to: prefix(cat.trip.to) } } : {}),
    }
  })
}

/** ほかのタブの質問。質問した猫の id を foreignCats と同じ「セッション/id」にそろえる */
export function foreignAsks(room: Room): (Ask & { room: string })[] {
  return (room.asks ?? []).map(ask => ({ ...ask, catId: `${room.session}/${ask.catId}`, room: room.session }))
}

export function foreignLinks(room: Room): Link[] {
  return room.links.map(link => ({ ...link, from: `${room.session}/${link.from}`, to: `${room.session}/${link.to}` }))
}
