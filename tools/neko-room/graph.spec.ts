// bun test tools/neko-room
import { describe, expect, test } from 'bun:test'

import { artOf, coatOf, newBoss, speak, startTrip } from '../../plugins/neko-agents/hooks/cats'
import type { Cat, Room } from '../../plugins/neko-agents/types'
import { draw, fit, layout, textWidth } from './graph'
import { buildScene, sections } from './view'

const kitten = (id: string, extra: Partial<Cat> = {}): Cat => ({
  ...newBoss(0),
  id,
  name: id,
  type: 'Explore',
  status: 'running',
  ...extra,
})

const plain = (rows: { text: string }[][]) => rows.map(runs => runs.map(run => run.text).join(''))

describe('layout', () => {
  test('点線でつながった猫はつながり元の 1 段下に置き、親からの段を飛ぶ線は省く', () => {
    const lay = layout(
      [newBoss(0), kitten('a'), kitten('b'), kitten('c')],
      [
        { from: 'a', to: 'c', kind: 'baton' },
        { from: 'b', to: 'c', kind: 'baton' },
      ],
      80,
    )
    expect(lay.placed.get('a')?.layer).toBe(1)
    expect(lay.placed.get('c')?.layer).toBe(2)
    expect(lay.routes.some(({ edge }) => edge.from === 'main' && edge.to === 'c')).toBe(false)
    expect(lay.routes.filter(({ edge }) => edge.to === 'c' && edge.dashed).length).toBe(2)
  })

  test('循環するつながりは段にも線にも使わない', () => {
    const lay = layout(
      [newBoss(0), kitten('a'), kitten('b')],
      [
        { from: 'a', to: 'b', kind: 'letter' },
        { from: 'b', to: 'a', kind: 'letter' },
      ],
      80,
    )
    expect(lay.placed.get('b')?.layer).toBe(2)
    expect(lay.routes.some(({ edge }) => edge.from === 'b' && edge.to === 'a')).toBe(false)
  })
})

describe('draw', () => {
  const content = (cat: Cat) => ({
    art: artOf(cat.status, 0),
    coat: coatOf(cat),
    name: cat.name,
    elapsed: '00:01',
    doing: '▶ Grep "とても長い検索パターン"',
    note: 'Explore · 12 tools',
    busy: true,
  })

  test('どの行もパネルの幅ちょうどで、全角文字は 2 桁として数える', () => {
    expect(textWidth('ボス 00:12')).toBe(10)
    expect(textWidth(fit('とても長い依頼の内容です', 9))).toBe(9)
    const cats = [newBoss(0), kitten('a', { name: 'コテツ' }), kitten('b', { name: 'きなこ' }), kitten('c')]
    for (const row of plain(draw(layout(cats, [], 70), content, []))) expect(textWidth(row)).toBe(70)
  })

  test('親子は箱の下端の ┬ から上端の ┴ へ線でつながる', () => {
    const rows = plain(draw(layout([newBoss(0), kitten('a')], [], 60), content, []))
    expect(rows.some(row => row.includes('┬'))).toBe(true)
    expect(rows.some(row => row.includes('┴'))).toBe(true)
  })

  test('歩く猫のセリフは、右端で入りきらなければ左隣に出る', () => {
    const lay = layout([newBoss(0), kitten('a')], [], 40)
    const rows = plain(draw(lay, content, [{ x: 37, y: 6, color: '#fff', speech: 'お手紙ニャ' }]))
    expect(rows[6]).toContain('「お手紙ニャ」=^.^=')
    expect(textWidth(rows[6] ?? '')).toBe(40)
  })
})

describe('view', () => {
  const room = (cats: Cat[]): Room => ({ session: 's', project: 'proj', updatedAt: 0, cats, links: [] })
  const shown = (cats: Cat[], t: number) => {
    const scene = buildScene({ mine: [], myLinks: [], others: [room(cats)], t })
    return sections(scene, 70, (_key, project) => project).flatMap(section => plain(section.rows))
  }

  test('出かけている猫の箱は留守になり、訪ねた先の箱に名前付きでしゃべる', () => {
    const t = 10_000
    let cats = [newBoss(0), kitten('k', { name: 'タマ', description: '調査' })]
    cats = startTrip(cats, 'k', 'main', 'report', t - 3000)
    cats = cats.map(cat => (cat.id === 'k' ? speak(cat, 'できたニャ！', t - 1000) : cat))
    const rows = shown(cats, t)
    expect(rows.some(row => row.includes('留守 → ボス'))).toBe(true)
    expect(rows.some(row => row.includes('タマ「できたニャ！」'))).toBe(true)
  })

  test('許可待ちの猫は 2 行目が「? ツール の許可待ち」になる', () => {
    const rows = shown([newBoss(0), kitten('k', { asking: 'Bash' })], 0)
    expect(rows.some(row => row.includes('? Bash の許可待ち'))).toBe(true)
  })

  test('寝ている猫の頭の上に zzz が出る', () => {
    const rows = shown([newBoss(0)], 2000)
    expect(rows.some(row => row.includes('zZz'))).toBe(true)
  })
})
