// bun test tools/neko-room
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { newBoss } from '../../plugins/neko-agents/hooks/cats'
import type { Cat, Room } from '../../plugins/neko-agents/types'
import { stripAnsi } from './ansi'
import { textWidth } from './graph'
import { frame, loadRooms } from './room'

const T = 1_700_000_000_000

function room(session: string, project: string, extra: Partial<Room> = {}): Room {
  const boss: Cat = { ...newBoss(T), status: 'running', toolCount: 3 }
  const { endedAt: _endedAt, ...kitten } = {
    ...newBoss(T),
    id: `k-${session}`,
    name: 'ソラ',
    type: 'Explore',
    description: `${project} を調査`,
    status: 'running' as const,
  }
  return { session, project, updatedAt: T, cats: [boss, kitten], links: [], ...extra }
}

describe('loadRooms', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'neko-room-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const put = (name: string, value: unknown, mtimeMs = T) => {
    const path = join(dir, name)
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  }

  test('生きている部屋だけを読む', () => {
    put('a.json', room('a', 'alpha'))
    put('b.json', room('b', 'beta', { closed: true }))
    put('c.json', room('c', 'gamma', { updatedAt: T - 11 * 60_000 }), T - 11 * 60_000)
    put('d.json', '{ 書きかけ')
    put('memo.txt', 'not a room')
    expect(loadRooms(dir, T).map(r => r.project)).toEqual(['alpha'])
  })

  test('フォルダが無ければ空', () => {
    expect(loadRooms(join(dir, 'nothing'), T)).toEqual([])
  })
})

describe('frame', () => {
  test('全タブの猫を、タブごとの区画に分けて描く', () => {
    const lines = frame([room('a', 'alpha'), room('b', 'beta')], T, 80).map(stripAnsi)
    expect(lines[0]).toContain('ねこ部屋 · 作業中の子猫 2 匹 · タブ 2 つ')
    const rowOf = (part: string) => lines.findIndex(line => line.includes(part))
    expect(rowOf('── alpha')).toBeGreaterThan(0)
    expect(rowOf('── beta')).toBeGreaterThan(rowOf('── alpha'))
    expect(rowOf('「alpha を調査」')).toBeLessThan(rowOf('── beta'))
    expect(rowOf('「beta を調査」')).toBeGreaterThan(rowOf('── beta'))
  })

  test('同じプロジェクトのタブが複数あれば、セッション id で見分ける', () => {
    const lines = frame([room('aaaaaaaa-1', 'same'), room('bbbbbbbb-2', 'same')], T, 80).map(stripAnsi)
    expect(lines.some(line => line.includes('── same（aaaaaaaa）'))).toBe(true)
    expect(lines.some(line => line.includes('── same（bbbbbbbb）'))).toBe(true)
  })

  test('どの行も画面の幅を超えない', () => {
    for (const width of [50, 80, 120]) {
      for (const line of frame([room('a', 'alpha'), room('b', 'とても長いプロジェクト名のリポジトリ')], T, width)) {
        expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(width)
      }
    }
  })

  test('狭いときは 1 匹 1 行、猫がいなければ案内を出す', () => {
    const narrow = frame([room('a', 'alpha')], T, 30).map(stripAnsi)
    expect(narrow.some(line => line.startsWith('(o.o) ボス'))).toBe(true)
    expect(
      frame([], T, 80)
        .map(stripAnsi)
        .some(line => line.includes('まだ猫がいません')),
    ).toBe(true)
  })

  test('色は 24bit カラーで付く', () => {
    expect(frame([room('a', 'alpha')], T, 80).join('')).toContain('\x1b[38;2;224;145;58m')
  })
})
