// ねこ部屋の描画。部屋（箱）を mermaid の graph TD のように並べて線でつなぎ、文字の格子に描く。$ に触らない純粋なロジック。
import {
  advanceTrip,
  type Art,
  type Coat,
  isBoss,
  isEnded,
  MAIN_ID,
  parentOf,
  STEP_MS,
  WALK_FRAMES,
  WALKER,
} from '../../plugins/neko-agents/hooks/cats'
import type { Cat, Link } from '../../plugins/neko-agents/types'

/** 左端の通路（1 段以上飛ぶ線が通る）の幅 */
export const LANE = 2
/** 横に並ぶ箱の間隔 */
export const GAP = 1
export const MIN_BOX = 22
export const MAX_BOX = 34
/** 箱の高さ（枠 2 + 中身 3） */
export const BOX_ROWS = 5
/** 段と段の間の行数（縦線・横線・縦線） */
export const GAP_ROWS = 3
const PITCH = BOX_ROWS + GAP_ROWS
/** 箱の中の文字の列：枠 1 + 絵 7 + 空白 1 + 文字 + 枠 1 */
const TEXT_OFFSET = 9

// ---------------------------------------------------------------- 文字の幅

/** 全角（2 桁）になる文字の範囲。あいまい幅の記号は Ink と同じく 1 桁として扱う */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp < 0x1100) return 1
  return WIDE.some(([from, to]) => cp >= from && cp <= to) ? 2 : 1
}

export function textWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/** ちょうど width 桁にする。はみ出す分は … で切り、足りない分は空白で埋める */
export function fit(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return ''
  let out = text
  if (textWidth(text) > width) {
    out = ''
    let used = 0
    for (const ch of text) {
      const w = charWidth(ch)
      if (used + w > width - 1) break
      out += ch
      used += w
    }
    out += '…'
  }
  const pad = ' '.repeat(Math.max(0, width - textWidth(out)))
  return align === 'left' ? out + pad : pad + out
}

// ---------------------------------------------------------------- 文字の格子

export type Style = { readonly color?: string; readonly bg?: string; readonly dim?: boolean; readonly bold?: boolean }
export type Run = { text: string; style: Style }

const PLAIN: Style = {}
const LINE: Style = { color: '#7a7a7a' }
const SPEECH = '#f0c674'
export const SELECTED = '#5fd7ff'
const ALERT = '#ff5f5f'
/** 子猫の箱の枠。色は猫の絵だけで出し、枠はどの子猫も同じ灰色（誰かは名前で分かる）。ボスの枠だけは毛色にして目立たせる */
const BORDER = '#9e9e9e'

/** 1 マス。ch が空文字のマスは全角文字の右半分 */
type Cell = { ch: string; style: Style }

const blank = (): Cell => ({ ch: ' ', style: PLAIN })

export class Canvas {
  readonly cells: Cell[][]

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, blank))
  }

  /** 全角文字の片方だけを上書きするときは、もう片方を空白にする */
  private release(row: Cell[], x: number) {
    const cell = row[x]
    if (!cell) return
    if (cell.ch === '' && x > 0) row[x - 1] = blank()
    else if (charWidth(cell.ch) === 2 && x + 1 < this.width) row[x + 1] = blank()
  }

  put(x: number, y: number, text: string, style: Style = PLAIN) {
    const row = this.cells[y]
    if (!row) return
    let cx = x
    for (const ch of text) {
      const w = charWidth(ch)
      if (cx >= this.width) break
      if (cx >= 0) {
        if (w === 2 && cx + 1 >= this.width) {
          this.release(row, cx)
          row[cx] = { ch: ' ', style }
          break
        }
        this.release(row, cx)
        if (w === 2) this.release(row, cx + 1)
        row[cx] = { ch, style }
        if (w === 2) row[cx + 1] = { ch: '', style }
      }
      cx += w
    }
  }

  /** 行ごとに、同じ見た目の文字をまとめた並び */
  rows(): Run[][] {
    return this.cells.map(row => {
      const runs: Run[] = []
      for (const cell of row) {
        if (cell.ch === '') continue
        const last = runs[runs.length - 1]
        if (last && sameStyle(last.style, cell.style)) last.text += cell.ch
        else runs.push({ text: cell.ch, style: cell.style })
      }
      return runs
    })
  }
}

function sameStyle(a: Style, b: Style): boolean {
  return a.color === b.color && !!a.dim === !!b.dim && !!a.bold === !!b.bold
}

// ---------------------------------------------------------------- 線

const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8

const SOLID: Record<number, string> = {
  [UP]: '│',
  [DOWN]: '│',
  [UP | DOWN]: '│',
  [LEFT]: '─',
  [RIGHT]: '─',
  [LEFT | RIGHT]: '─',
  [DOWN | RIGHT]: '┌',
  [DOWN | LEFT]: '┐',
  [UP | RIGHT]: '└',
  [UP | LEFT]: '┘',
  [UP | DOWN | RIGHT]: '├',
  [UP | DOWN | LEFT]: '┤',
  [DOWN | LEFT | RIGHT]: '┬',
  [UP | LEFT | RIGHT]: '┴',
  [UP | DOWN | LEFT | RIGHT]: '┼',
}

/** マスごとに、どの向きへ線が伸びているかを実線・点線に分けて持つ */
class Lines {
  private readonly solid = new Map<string, number>()
  private readonly dashed = new Map<string, number>()

  private add(x: number, y: number, bits: number, dashed: boolean) {
    const map = dashed ? this.dashed : this.solid
    const key = `${x},${y}`
    map.set(key, (map.get(key) ?? 0) | bits)
  }

  path(cells: readonly (readonly [number, number])[], dashed: boolean) {
    let previous: readonly [number, number] | undefined
    for (const cell of cells) {
      if (previous) {
        const [ax, ay] = previous
        const [bx, by] = cell
        // 隣り合う 2 マスに、互いの向きの線を足す
        const [from, to] =
          bx > ax ? [RIGHT, LEFT] : bx < ax ? [LEFT, RIGHT] : by > ay ? [DOWN, UP] : by < ay ? [UP, DOWN] : [0, 0]
        if (from !== 0) {
          this.add(ax, ay, from, dashed)
          this.add(bx, by, to, dashed)
        }
      }
      previous = cell
    }
  }

  draw(canvas: Canvas) {
    const keys = new Set([...this.solid.keys(), ...this.dashed.keys()])
    for (const key of keys) {
      const [x, y] = key.split(',').map(Number) as [number, number]
      const solid = this.solid.get(key) ?? 0
      const bits = solid | (this.dashed.get(key) ?? 0)
      // 点線で描けるのはまっすぐな線だけ。角や分かれ目は実線の文字を使う
      const vertical = (bits & (LEFT | RIGHT)) === 0
      const horizontal = (bits & (UP | DOWN)) === 0
      const ch = solid === 0 && vertical ? '┆' : solid === 0 && horizontal ? '┄' : SOLID[bits]
      if (ch) canvas.put(x, y, ch, LINE)
    }
  }
}

// ---------------------------------------------------------------- 配置

export type Edge = { from: string; to: string; dashed: boolean }
export type Placed = { cat: Cat; layer: number; band: number; x: number; y: number }
export type Route = { edge: Edge; path: (readonly [number, number])[] }
export type Layout = { width: number; height: number; box: number; placed: Map<string, Placed>; routes: Route[] }

const centerOf = (placed: Placed, box: number) => placed.x + Math.floor(box / 2)

/**
 * 箱を段に並べ、線の通り道を決める。段は「親 → 子」の実線と「つながり元 → 先」の点線を
 * たどった最長の深さ。循環するつながりは段の計算にも線にも使わない
 */
export function layout(cats: readonly Cat[], links: readonly Link[], width: number): Layout {
  const ids = new Set(cats.map(cat => cat.id))
  const edges: Edge[] = []
  const next = new Map<string, string[]>()
  const addEdge = (from: string, to: string, dashed: boolean) => {
    edges.push({ from, to, dashed })
    next.set(from, [...(next.get(from) ?? []), to])
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>()
    const stack = [from]
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (id === to) return true
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...(next.get(id) ?? []))
    }
    return false
  }

  // ボス（タブごとに 1 匹）が根。それ以外は親（いなければ同じタブのボス）から実線を引く
  for (const cat of cats) {
    if (isBoss(cat)) continue
    const parent = parentOf(cat, ids)
    if (ids.has(parent)) addEdge(parent, cat.id, false)
  }
  for (const link of links) {
    if (!ids.has(link.from) || !ids.has(link.to) || link.from === link.to) continue
    if (edges.some(edge => edge.from === link.from && edge.to === link.to)) continue
    if (reaches(link.to, link.from)) continue
    addEdge(link.from, link.to, true)
  }

  const layer = new Map(cats.map(cat => [cat.id, 0]))
  const layerOf = (id: string) => layer.get(id) ?? 0
  for (const _ of cats) {
    let changed = false
    for (const edge of edges) {
      const deeper = layerOf(edge.from) + 1
      if (layerOf(edge.to) < deeper) {
        layer.set(edge.to, deeper)
        changed = true
      }
    }
    if (!changed) break
  }

  // すぐ上の段から線が来ている箱には、段を飛ぶ線を引かない（親からの実線は省く）
  const drawn = edges.filter(edge => {
    const to = layerOf(edge.to)
    if (layerOf(edge.from) === to - 1) return true
    return !edges.some(other => other.to === edge.to && layerOf(other.from) === to - 1)
  })

  const usable = Math.max(1, width - LANE)
  const depth = Math.max(0, ...layer.values())
  const layers: Cat[][] = Array.from({ length: depth + 1 }, () => [])
  for (const cat of cats) layers[layerOf(cat.id)]?.push(cat)
  const fits = Math.max(1, Math.floor((usable + GAP) / (MIN_BOX + GAP)))
  const widest = Math.min(fits, Math.max(1, ...layers.map(row => row.length)))
  const box =
    usable < MIN_BOX ? usable : Math.min(MAX_BOX, Math.max(MIN_BOX, Math.floor((usable - (widest - 1) * GAP) / widest)))
  const perBand = Math.max(1, Math.floor((usable + GAP) / (box + GAP)))

  const placed = new Map<string, Placed>()
  let band = 0
  layers.forEach((row, index) => {
    // 線が交差しにくいよう、つながり元の箱の位置の平均で並べる
    const bary = (cat: Cat) => {
      const xs = drawn.flatMap(edge => {
        const source = edge.to === cat.id ? placed.get(edge.from) : undefined
        return source ? [centerOf(source, box)] : []
      })
      return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.POSITIVE_INFINITY
    }
    // 自分のタブのボスを左端に。あとはつながり元の位置、起動した順
    const ordered = [...row].sort(
      (a, b) => Number(b.id === MAIN_ID) - Number(a.id === MAIN_ID) || bary(a) - bary(b) || a.startedAt - b.startedAt,
    )
    for (let start = 0; start < ordered.length; start += perBand) {
      const chunk = ordered.slice(start, start + perBand)
      const total = chunk.length * box + (chunk.length - 1) * GAP
      const left = LANE + Math.max(0, Math.floor((usable - total) / 2))
      chunk.forEach((cat, i) => {
        placed.set(cat.id, { cat, layer: index, band, x: left + i * (box + GAP), y: band * PITCH })
      })
      band++
    }
  })
  const height = band > 0 ? band * BOX_ROWS + (band - 1) * GAP_ROWS : 0

  const routes = drawn.flatMap(edge => {
    const from = placed.get(edge.from)
    const to = placed.get(edge.to)
    return from && to ? [{ edge, path: route(from, to, box) }] : []
  })
  return { width, height, box, placed, routes }
}

/** 上の箱の下端から下の箱の上端までの通り道（段の間のマスと、左端の通路のマス） */
function route(from: Placed, to: Placed, box: number): (readonly [number, number])[] {
  const sx = centerOf(from, box)
  const sy = from.y + BOX_ROWS
  const tx = centerOf(to, box)
  const ty = to.y - 1
  const cells: (readonly [number, number])[] = []
  const go = (x: number, y: number) => {
    const last = cells[cells.length - 1]
    if (!last) return void cells.push([x, y])
    let [cx, cy] = last
    while (cx !== x || cy !== y) {
      if (cx !== x) cx += Math.sign(x - cx)
      else cy += Math.sign(y - cy)
      cells.push([cx, cy])
    }
  }
  go(sx, sy)
  if (to.band === from.band + 1) {
    go(sx, sy + 1)
    go(tx, sy + 1)
    go(tx, ty)
  } else {
    // 1 段以上飛ぶ線は左端の通路を通る
    go(sx, sy + 1)
    go(0, sy + 1)
    go(0, ty - 1)
    go(tx, ty - 1)
    go(tx, ty)
  }
  return cells
}

// ---------------------------------------------------------------- 描画

export type BoxContent = {
  art: Art
  coat: Coat
  name: string
  elapsed: string
  doing: string
  note: string
  /** 吹き出しの候補。収まる最初のものを 3 行目（note）の代わりに出す */
  speech?: readonly string[]
  /** 「▶ 今やっていること」を目立たせる */
  busy: boolean
  /** 枠の強調。selected: 詳細を見ている猫 / alert: 許可待ち（点滅の明るいほうのコマ） */
  highlight?: 'selected' | 'alert'
}

/** 線の上を歩いている猫。speech があれば一緒に動く吹き出しを出す */
export type Walker = { x: number; y: number; color: string; speech?: string }

/** 段の間の行か（箱の行でないか） */
const inGap = (y: number) => y % PITCH >= BOX_ROWS

/** 歩いている猫が今いるマス。通り道（線）が無ければ描かない */
export function walkerAt(lay: Layout, cat: Cat, t: number): readonly [number, number] | undefined {
  const trip = cat.trip && advanceTrip(cat.trip, t)
  if (!trip || trip.phase === 'stay') return undefined
  const found = lay.routes.find(
    ({ edge }) => (edge.from === cat.id && edge.to === trip.to) || (edge.from === trip.to && edge.to === cat.id),
  )
  if (!found) return undefined
  const step = Math.min(WALK_FRAMES - 1, Math.max(0, Math.floor((t - trip.at) / STEP_MS)))
  const p = (step + 1) / WALK_FRAMES
  // 自分の部屋から相手の部屋までの道のりのうち、どこまで来たか（0〜1）
  const away =
    trip.phase === 'leave'
      ? p / 2
      : trip.phase === 'arrive'
        ? 0.5 + p / 2
        : trip.phase === 'depart'
          ? 1 - p / 2
          : 0.5 - p / 2
  const along = found.edge.from === cat.id ? away : 1 - away
  return found.path[Math.round(along * (found.path.length - 1))]
}

export function draw(lay: Layout, content: (cat: Cat) => BoxContent, walkers: readonly Walker[]): Run[][] {
  const canvas = new Canvas(lay.width, lay.height)
  const lines = new Lines()
  for (const { edge, path } of lay.routes) lines.path(path, edge.dashed)
  lines.draw(canvas)

  const box = lay.box
  const textWidth_ = Math.max(1, box - TEXT_OFFSET - 1)
  for (const placed of lay.placed.values()) {
    const { cat, x, y } = placed
    const c = content(cat)
    const ended = isEnded(cat)
    const border: Style =
      c.highlight === 'alert'
        ? { color: ALERT, bold: true }
        : c.highlight === 'selected'
          ? { color: SELECTED, bold: true }
          : { color: isBoss(cat) ? c.coat[0] : BORDER, dim: ended }
    const center = centerOf(placed, box)
    const top = `╭${'─'.repeat(box - 2)}╮`
    const bottom = `╰${'─'.repeat(box - 2)}╯`
    canvas.put(x, y, top, border)
    canvas.put(x, y + BOX_ROWS - 1, bottom, border)
    if (lay.routes.some(({ edge }) => edge.to === cat.id)) canvas.put(center, y, '┴', LINE)
    if (lay.routes.some(({ edge }) => edge.from === cat.id)) canvas.put(center, y + BOX_ROWS - 1, '┬', LINE)

    const elapsed = c.elapsed
    const nameWidth = Math.max(1, textWidth_ - textWidth(elapsed) - 1)
    const texts: readonly [[string, Style], [string, Style], [string, Style]] = [
      [fit(c.name, nameWidth), { bold: !ended, dim: ended }],
      [fit(c.doing, textWidth_), { dim: ended || !c.busy }],
      c.speech && c.speech.length > 0
        ? [
            fit(c.speech.find(text => textWidth(text) <= textWidth_) ?? c.speech.at(-1) ?? '', textWidth_),
            { color: SPEECH },
          ]
        : [fit(c.note, textWidth_), { dim: true }],
    ]
    for (const i of [0, 1, 2] as const) {
      const row = y + 1 + i
      canvas.put(x, row, '│', border)
      canvas.put(x + 1, row, fit(c.art[i], 7), { color: c.coat[i], dim: ended })
      canvas.put(x + 8, row, ' ')
      const [text, style] = texts[i]
      canvas.put(x + TEXT_OFFSET, row, text, style)
      if (i === 0) canvas.put(x + TEXT_OFFSET + nameWidth, row, ` ${elapsed}`, { dim: ended })
      canvas.put(x + box - 1, row, '│', border)
    }
  }

  for (const walker of walkers) {
    if (!inGap(walker.y)) continue
    const left = Math.max(0, Math.min(lay.width - WALKER.length, walker.x - Math.floor(WALKER.length / 2)))
    canvas.put(left, walker.y, WALKER, { color: walker.color, bold: true })
    if (walker.speech) {
      // セリフは猫の右隣。入りきらなければ左隣、それも無理なら右に切って出す
      const bubble = `「${walker.speech}」`
      const width = textWidth(bubble)
      const right = left + WALKER.length
      const x = right + width <= lay.width ? right : left - width >= 0 ? left - width : right
      canvas.put(x, walker.y, fit(bubble, Math.min(width, lay.width - x)), { color: SPEECH })
    }
  }
  return canvas.rows()
}
