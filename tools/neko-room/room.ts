#!/usr/bin/env bun
// ねこ部屋のビューア。各タブの neko-agents が書き出した部屋を読んで、ターミナルの全画面に描く。
// 使い方: bun tools/neko-room/room.ts   （q で終了、↑↓ / PgUp PgDn / ホイールでスクロール）
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isBoss } from '../../plugins/neko-agents/hooks/cats'
import { isLive, parseRoom, ROOMS_DIR, STALE_MS } from '../../plugins/neko-agents/hooks/rooms'
import type { Room } from '../../plugins/neko-agents/types'
import { paint, toAnsi } from './ansi'
import { fit } from './graph'
import { buildScene, headline, narrowLines, REPORT_COLOR, sections } from './view'

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

/** 画面に出す全部の行（スクロール前）。色付き */
export function frame(rooms: readonly Room[], t: number, width: number): string[] {
  const scene = buildScene({ mine: [], myLinks: [], others: rooms, t })
  // 文字の行は、色を付ける前に幅ちょうどに収める（図の行はもともと幅ちょうど）
  const lines = [paint(fit(`ねこ部屋 · ${headline(scene)}`, width), { bold: true })]
  if (rooms.length === 0) {
    lines.push(
      '',
      paint(fit('まだ猫がいません。neko-agents を入れた Claude Code を動かすと、ここに集まります。', width), {
        dim: true,
      }),
    )
    return lines
  }
  if (width < NARROW) {
    for (const line of narrowLines(scene))
      lines.push(paint(fit(line.text, width), { color: line.color, dim: line.dim }))
    return lines
  }
  // 同じプロジェクトのタブが複数あるときは、セッション id の頭で見分ける
  const projects = rooms.map(room => room.project)
  const label = (key: string, project: string) =>
    projects.filter(name => name === project).length > 1 ? `${project}（${key.slice(0, 8)}）` : project
  const groups = sections(scene, width, label)
  for (const group of groups) {
    if (groups.length > 1) lines.push(paint(group.title, { dim: true }))
    for (const runs of group.rows) lines.push(toAnsi(runs))
  }
  const { reported } = scene
  if (reported) {
    const label = isBoss(reported) ? 'まとめ' : '報告'
    lines.push(paint(fit(`${reported.name}の${label}：${reported.summary}`, width), { color: REPORT_COLOR }))
  }
  return lines
}

function main() {
  const dir = join(homedir(), ROOMS_DIR)
  const out = process.stdout
  const input = process.stdin
  let scroll = 0
  let total = 0

  const enter = () => out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h')
  const leave = () => out.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l')

  const render = () => {
    const width = out.columns || 80
    const height = out.rows || 24
    const body = height - 1
    const lines = frame(loadRooms(dir, Date.now()), Date.now(), width)
    total = lines.length
    scroll = Math.max(0, Math.min(scroll, total - body))
    const shown = lines.slice(scroll, scroll + body)
    const more = total > body ? `  ${scroll + 1}-${Math.min(total, scroll + body)} / ${total} 行` : ''
    const footer = paint(fit(`q: 終了  ↑↓ PgUp PgDn ホイール: スクロール${more}`, width), { dim: true })
    let screen = '\x1b[H'
    for (const line of shown) screen += `${line}\x1b[K\r\n`
    screen += '\x1b[J'
    screen += `\x1b[${height};1H${footer}\x1b[K`
    out.write(screen)
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
  })
  out.on('resize', render)
  process.on('SIGTERM', quit)
  const timer = setInterval(render, FRAME_MS)
  render()
}

if (import.meta.main) main()
