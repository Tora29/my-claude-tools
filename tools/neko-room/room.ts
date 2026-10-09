#!/usr/bin/env bun
// ねこ部屋のビューア。各タブの neko-agents が書き出した部屋を読んで、ターミナルの全画面に描く。
// 使い方: bun tools/neko-room/room.ts   （q で終了、↑↓ / PgUp PgDn / ホイールでスクロール、猫をクリックで詳細）
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isLive, parseRoom, ROOMS_DIR, STALE_MS } from '../../plugins/neko-agents/hooks/rooms'
import type { Room } from '../../plugins/neko-agents/types'
import { paint, toAnsi } from './ansi'
import { BOX_ROWS, fit, SELECTED } from './graph'
import {
  askLines,
  buildScene,
  detailLines,
  fitRuns,
  headline,
  type Line,
  narrowLines,
  REPORT_COLOR,
  reportedIn,
  reportLine,
  sections,
  wrap,
} from './view'

/** 描き直しの間隔。Mod のパネルで猫が歩くときと同じ */
const FRAME_MS = 200
const NARROW = 40

/** 部屋のファイルを読む。閉じたタブ・しばらく更新のないタブ・壊れたファイルは除く */
export function loadRooms(dir: string, t: number): Room[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const rooms: Room[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    try {
      if (t - statSync(path).mtimeMs >= STALE_MS) continue
      const room = parseRoom(readFileSync(path, 'utf8'))
      if (room && isLive(room, t)) rooms.push(room)
    } catch {
      // 書きかけなどで読めなければ、次の回に
    }
  }
  return rooms.sort((a, b) => a.session.localeCompare(b.session))
}

/** 猫の箱が描かれた範囲。top・bottom は lines の行番号、left・right は桁（bottom・right は含まない） */
export type Hit = { id: string; top: number; bottom: number; left: number; right: number }

export type FrameOptions = {
  /** 質問の記録を全部出す */
  history?: boolean
  /** 詳細を見ている猫の id */
  selected?: string
  /** 詳細に使える行数 */
  detailRows?: number
}

export type Frame = {
  /** 画面に出す全部の行（スクロール前）。色付き */
  lines: string[]
  /** クリックした場所の猫を探すための、箱の範囲 */
  hits: Hit[]
  /** 選んだ猫の詳細。画面の下に固定して出す */
  detail: string[]
}

const paintLine = (line: Line, width: number) =>
  line.runs
    ? toAnsi(fitRuns(line.runs, width))
    : paint(fit(line.text, width), { color: line.color, bold: line.bold, dim: line.dim })

export function frame(rooms: readonly Room[], t: number, width: number, options: FrameOptions = {}): Frame {
  const { history = false, selected } = options
  const scene = buildScene({ mine: [], myLinks: [], others: rooms, t, ...(selected ? { selectedId: selected } : {}) })
  // 文字の行は、色を付ける前に幅ちょうどに収める（図の行はもともと幅ちょうど）
  const lines = [paint(fit(`ねこ部屋 · ${headline(scene)}`, width), { bold: true })]
  const hits: Hit[] = []
  const detail = selected
    ? detailLines(scene, selected, width, options.detailRows ?? Number.POSITIVE_INFINITY).map(line =>
        paintLine(line, width),
      )
    : []
  if (rooms.length === 0) {
    lines.push(
      '',
      paint(fit('まだ猫がいません。neko-agents を入れた Claude Code を動かすと、ここに集まります。', width), {
        dim: true,
      }),
    )
    return { lines, hits, detail }
  }
  // 報告と質問は、そのタブの区画の中（図のすぐ下）に出す。key を省くと全タブ分
  const below = (key?: string) => {
    const reported = reportedIn(scene, key)
    // 報告は切らずに折り返す（2 行目からは字下げ）。詳細を見ている猫の報告は詳細の中に出すので、ここでは出さない
    const report =
      reported && reported.id !== selected
        ? wrap(reportLine(reported), width, '  ').map(line => paint(fit(line, width), { color: REPORT_COLOR }))
        : []
    const questions = askLines(scene, width, history, key).map(line => paintLine(line, width))
    return [...report, ...questions]
  }
  if (width < NARROW) {
    for (const line of narrowLines(scene)) {
      hits.push({ id: line.key, top: lines.length, bottom: lines.length + 1, left: 0, right: width })
      const color = line.key === selected ? SELECTED : line.color
      lines.push(paint(fit(line.text, width), { color, dim: line.dim && line.key !== selected }))
    }
    lines.push(...below())
    return { lines, hits, detail }
  }
  // 同じプロジェクトのタブが複数あるときは、セッション id の頭で見分ける
  const projects = rooms.map(room => room.project)
  const label = (key: string, project: string) =>
    projects.filter(name => name === project).length > 1 ? `${project}（${key.slice(0, 8)}）` : project
  const groups = sections(scene, width, label)
  for (const group of groups) {
    if (groups.length > 1) lines.push(paint(group.title, { dim: true }))
    const top = lines.length
    for (const { cat, x, y } of group.lay.placed.values()) {
      hits.push({ id: cat.id, top: top + y, bottom: top + y + BOX_ROWS, left: x, right: x + group.lay.box })
    }
    for (const runs of group.rows) lines.push(toAnsi(runs))
    lines.push(...below(group.key))
  }
  return { lines, hits, detail }
}

/** その場所（lines の行番号・桁）にある猫の id */
export function hitAt(hits: readonly Hit[], line: number, column: number): string | undefined {
  return hits.find(hit => line >= hit.top && line < hit.bottom && column >= hit.left && column < hit.right)?.id
}

function main() {
  const dir = join(homedir(), ROOMS_DIR)
  const out = process.stdout
  const input = process.stdin
  let scroll = 0
  let total = 0
  let history = false
  /** 図に使える行数（詳細とフッターを除く） */
  let body = 0
  let hits: Hit[] = []
  /** 詳細を見ている猫 */
  let selected: string | undefined
  /** 次に描くとき、選んだ猫の箱が詳細に隠れないようスクロールする */
  let reveal = false

  const enter = () => out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h')
  const leave = () => out.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l')

  const render = () => {
    const width = out.columns || 80
    const height = out.rows || 24
    const t = Date.now()
    // 詳細は画面の下半分まで（上の空き 1 行を含む）
    const detailRows = Math.max(4, Math.floor((height - 1) / 2) - 1)
    const drawn = frame(loadRooms(dir, t), t, width, { history, ...(selected ? { selected } : {}), detailRows })
    const { lines, detail } = drawn
    hits = drawn.hits
    // 詳細の上は 1 行空けて、図の下の報告や質問とくっつかないようにする
    body = Math.max(1, height - 1 - (detail.length > 0 ? detail.length + 1 : 0))
    total = lines.length
    const box = reveal ? hits.find(hit => hit.id === selected) : undefined
    if (box) scroll = Math.min(box.top, Math.max(scroll, box.bottom - body))
    reveal = false
    scroll = Math.max(0, Math.min(scroll, total - body))
    const shown = lines.slice(scroll, scroll + body)
    const more = total > body ? `  ${scroll + 1}-${Math.min(total, scroll + body)} / ${total} 行` : ''
    const footer = paint(
      fit(`q: 終了  クリック: 猫の詳細  h: 質問の記録  ↑↓ PgUp PgDn ホイール: スクロール${more}`, width),
      { dim: true },
    )
    let screen = '\x1b[H'
    for (const line of shown) screen += `${line}\x1b[K\r\n`
    screen += '\x1b[J'
    if (detail.length > 0) {
      screen += `\x1b[${height - detail.length};1H`
      for (const line of detail) screen += `${line}\x1b[K\r\n`
    }
    screen += `\x1b[${height};1H${footer}\x1b[K`
    out.write(screen)
  }

  /** 猫を選ぶ。同じ猫や猫のいない場所なら閉じる */
  const select = (id: string | undefined) => {
    selected = id === selected ? undefined : id
    reveal = selected !== undefined
    render()
  }

  const scrollBy = (by: number) => {
    scroll = Math.max(0, scroll + by)
    render()
  }

  const quit = () => {
    clearInterval(timer)
    leave()
    if (input.isTTY) input.setRawMode(false)
    process.exit(0)
  }

  enter()
  if (input.isTTY) input.setRawMode(true)
  input.setEncoding('utf8')
  input.on('data', (key: string) => {
    const page = Math.max(1, (out.rows || 24) - 2)
    if (key === 'q' || key === '\x03') return quit()
    if (key === '\x1b') {
      select(undefined)
      return
    }
    if (key === 'h') {
      history = !history
      render()
      return
    }
    if (key === '\x1b[A' || key === 'k') {
      scrollBy(-1)
      return
    }
    if (key === '\x1b[B' || key === 'j') {
      scrollBy(1)
      return
    }
    if (key === '\x1b[5~') {
      scrollBy(-page)
      return
    }
    if (key === '\x1b[6~') {
      scrollBy(page)
      return
    }
    // マウスのホイール（SGR 形式）：64 が上、65 が下
    // eslint-disable-next-line no-control-regex -- 端末から届く制御文字（ESC）を読むのが目的
    const wheel = /\x1b\[<(64|65);\d+;\d+[Mm]/.exec(key)
    if (wheel) {
      scrollBy(wheel[1] === '64' ? -3 : 3)
      return
    }
    // 左クリック（SGR 形式で押したとき）。桁と行は 1 から数える。詳細とフッターの上では何もしない
    // eslint-disable-next-line no-control-regex -- 端末から届く制御文字（ESC）を読むのが目的
    const click = /\x1b\[<0;(\d+);(\d+)M/.exec(key)
    if (click) {
      const row = Number(click[2]) - 1
      if (row < body) select(hitAt(hits, scroll + row, Number(click[1]) - 1))
      return
    }
  })
  out.on('resize', render)
  process.on('SIGTERM', quit)
  const timer = setInterval(render, FRAME_MS)
  render()
}

if (import.meta.main) main()
