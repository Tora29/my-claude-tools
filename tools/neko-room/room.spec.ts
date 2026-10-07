// bun test tools/neko-room
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { newBoss } from '../../plugins/neko-agents/hooks/cats'
import type { Ask, Cat, Room } from '../../plugins/neko-agents/types'
import { stripAnsi } from './ansi'
import { textWidth } from './graph'
import { frame, hitAt, loadRooms } from './room'
import { wrap } from './view'

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

describe('wrap', () => {
  // 幅 10 桁 = 全角 5 文字
  test('句読点や小さいかなを行の頭に置かず、前の文字ごと次の行へ送る', () => {
    expect(wrap('あいうえお。かき', 10)).toEqual(['あいうえ', 'お。かき'])
    expect(wrap('あいうえニャ', 10)).toEqual(['あいうえ', 'ニャ'])
    expect(wrap('あいうえお」か', 10)).toEqual(['あいうえ', 'お」か'])
  })

  test('開きかっこを行の終わりに置かない', () => {
    expect(wrap('あいうえ（か）', 10)).toEqual(['あいうえ', '（か）'])
  })

  test('英数字の単語は途中で切らず、行の半分より長い単語だけ途中で切る', () => {
    expect(wrap('あいう abc def', 10)).toEqual(['あいう abc', 'def'])
    expect(wrap('あ abcdefghijkl', 10)).toEqual(['あ abcdefg', 'hijkl'])
  })

  test('2 行目からは indent を付け、どの行も幅に収める', () => {
    const lines = wrap('あいうえおかきくけこ。さしすせそ、たちつてと', 12, '  ')
    expect(lines.slice(1).every(line => line.startsWith('  '))).toBe(true)
    expect(lines.every(line => textWidth(line) <= 12)).toBe(true)
    expect(lines.some(line => /^\s*[。、]/.test(line))).toBe(false)
  })
})

const linesOf = (...args: Parameters<typeof frame>) => frame(...args).lines

describe('frame', () => {
  test('全タブの猫を、タブごとの区画に分けて描く', () => {
    const lines = linesOf([room('a', 'alpha'), room('b', 'beta')], T, 80).map(stripAnsi)
    expect(lines[0]).toContain('ねこ部屋 · 作業中の子猫 2 匹 · タブ 2 つ')
    const rowOf = (part: string) => lines.findIndex(line => line.includes(part))
    expect(rowOf('── alpha')).toBeGreaterThan(0)
    expect(rowOf('── beta')).toBeGreaterThan(rowOf('── alpha'))
    expect(rowOf('「alpha を調査」')).toBeLessThan(rowOf('── beta'))
    expect(rowOf('「beta を調査」')).toBeGreaterThan(rowOf('── beta'))
  })

  test('同じプロジェクトのタブが複数あれば、セッション id で見分ける', () => {
    const lines = linesOf([room('aaaaaaaa-1', 'same'), room('bbbbbbbb-2', 'same')], T, 80).map(stripAnsi)
    expect(lines.some(line => line.includes('── same（aaaaaaaa）'))).toBe(true)
    expect(lines.some(line => line.includes('── same（bbbbbbbb）'))).toBe(true)
  })

  test('どの行も画面の幅を超えない', () => {
    for (const width of [50, 80, 120]) {
      for (const line of linesOf([room('a', 'alpha'), room('b', 'とても長いプロジェクト名のリポジトリ')], T, width)) {
        expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(width)
      }
    }
  })

  test('狭いときは 1 匹 1 行、猫がいなければ案内を出す', () => {
    const narrow = linesOf([room('a', 'alpha')], T, 30).map(stripAnsi)
    expect(narrow.some(line => line.startsWith('(o.o) ボス'))).toBe(true)
    expect(
      linesOf([], T, 80)
        .map(stripAnsi)
        .some(line => line.includes('まだ猫がいません')),
    ).toBe(true)
  })

  test('図の下に最新の要約を出す。ボスの要約は「まとめ」', () => {
    const withSummaries = (bossAt: number) => {
      const base = room('a', 'alpha')
      const [boss, kitten] = base.cats
      return {
        ...base,
        cats: [
          { ...boss!, summary: '全部なおしたニャ', summaryAt: bossAt },
          { ...kitten!, status: 'completed' as const, endedAt: T, summary: '見つけたニャ', summaryAt: T },
        ],
      }
    }
    const last = (r: Room) => stripAnsi(linesOf([r], T + 10_000, 80).at(-1) ?? '')
    expect(last(withSummaries(T + 5000))).toContain('ボスのまとめ：全部なおしたニャ')
    expect(last(withSummaries(T - 5000))).toContain('ソラの報告：見つけたニャ')
  })

  test('長い報告は切らずに折り返す', () => {
    const base = room('a', 'alpha')
    const [boss, kitten] = base.cats
    const summary = 'ポリシー文書を版0.08から0.09に更新し、根拠ある19件を修正、方針判断1件を残したニャ'
    const reported = { ...base, cats: [boss!, { ...kitten!, summary, summaryAt: T }] }
    const lines = linesOf([reported], T, 50).map(line => stripAnsi(line).trim())
    const start = lines.findIndex(line => line.startsWith('ソラの報告：'))
    expect(lines.slice(start).join('')).toContain(summary)
    expect(lines.slice(start).join('')).not.toContain('…')
  })

  const ask = (extra: Partial<Ask> = {}): Ask => ({
    id: 'toolu-ask',
    catId: 'main',
    askedAt: T,
    questions: [
      {
        question: 'どの方式でログインを作りますか？',
        header: '方式',
        multiSelect: false,
        options: [
          { label: 'OAuth', description: '外部のアカウントで入る' },
          { label: 'パスワード', description: '自前で持つ' },
        ],
      },
    ],
    status: 'open',
    answers: {},
    explain: 'done',
    explanation: '### なぜ聞いているか\nどっちでも作れるからニャ\n### おすすめ\n→ 1. OAuth: 楽ニャ',
    ...extra,
  })

  test('回答待ちの質問は、質問した猫が何について聞くかと解説をしゃべり、これまでの答えを並べる', () => {
    const past = ask({
      id: 'old',
      askedAt: T - 1000,
      status: 'answered',
      answers: { 'どの方式でログインを作りますか？': 'OAuth' },
    })
    const lines = linesOf([room('a', 'alpha', { asks: [past, ask()] })], T, 80).map(stripAnsi)
    const text = lines.join('\n')
    expect(text).toContain('┄┄ ボスの質問（回答待ち）')
    expect(text).toContain('ボス「方式について聞きたいニャ」')
    // 質問文と選択肢は Claude Code の画面に出ているので出さない
    expect(text).not.toContain('Q1.')
    expect(text).not.toContain('外部のアカウントで入る')
    expect(text).toContain('【なぜ聞いているか】')
    expect(text).toContain('→ 1. OAuth: 楽ニャ')
    expect(text).toContain('これまでの答え')
    expect(text).toContain('ボス：[方式] どの方式でログインを作りますか？ → OAuth')
    // 箱の 2 行目も回答待ちになる
    expect(text).toContain('? 回答待ち「方式」')
  })

  test('答えたあとは最後の答えだけを出し、h で記録を開くと選んだものに ✔ が付く', () => {
    const answered = room('a', 'alpha', {
      asks: [ask({ status: 'answered', answers: { 'どの方式でログインを作りますか？': 'パスワード' } })],
    })
    const closed = linesOf([answered], T, 80).map(stripAnsi)
    expect(closed.at(-1)).toContain('→ パスワード（h で質問の記録）')
    expect(closed.join('\n')).not.toContain('【なぜ聞いているか】')
    const opened = linesOf([answered], T, 80, { history: true }).map(stripAnsi).join('\n')
    expect(opened).toContain('┄┄ 質問の記録（新しい順）')
    expect(opened).toContain('✔ パスワード')
    expect(opened).toContain('1. OAuth')
  })

  test('回答待ちの間に報告が届いたら、前の解説を出したまま考え直し、考え直したと言う', () => {
    const thinking = linesOf([room('a', 'alpha', { asks: [ask({ explain: 'pending', revisedFor: ['ソラ'] })] })], T, 80)
      .map(stripAnsi)
      .join('\n')
    expect(thinking).toContain('ボス「ソラの報告が来たから考え直してるニャ…」')
    expect(thinking).toContain('【なぜ聞いているか】')
    const revised = linesOf([room('a', 'alpha', { asks: [ask({ revisedFor: ['ソラ', 'クロ'] })] })], T, 80)
      .map(stripAnsi)
      .join('\n')
    expect(revised).toContain('ボス「ソラ・クロの報告が来たから考え直したニャ」')
    expect(revised).not.toContain('答える前に聞いてほしいニャ')
  })

  test('解説の英数字の単語は途中で折り返さず、` は消す', () => {
    const code = ask({
      explanation: `### 選択肢ごとの影響\n${'あ'.repeat(30)}の import を \`../hooks/useAuth\` に変える`,
    })
    const lines = linesOf([room('a', 'alpha', { asks: [code] })], T, 80).map(line => stripAnsi(line).trimEnd())
    expect(
      lines.some(line => line.endsWith('../hooks/useAuth') || line.trimStart().startsWith('../hooks/useAuth')),
    ).toBe(true)
    expect(lines.join('\n')).not.toContain('`')
  })

  test('タブが複数あるときは、報告と質問をそのタブの区画の中に出す', () => {
    const asking = room('a', 'alpha', { asks: [ask({ catId: 'main' })] })
    const [boss, kitten] = asking.cats
    const withReport: Room = {
      ...asking,
      cats: [boss!, { ...kitten!, status: 'completed', endedAt: T, summary: 'alpha で見つけたニャ', summaryAt: T }],
    }
    const lines = linesOf([withReport, room('b', 'beta')], T, 80).map(stripAnsi)
    const rowOf = (part: string) => lines.findIndex(line => line.includes(part))
    expect(rowOf('ソラの報告：alpha で見つけたニャ')).toBeGreaterThan(rowOf('── alpha'))
    expect(rowOf('ソラの報告：alpha で見つけたニャ')).toBeLessThan(rowOf('── beta'))
    expect(rowOf('┄┄ ボスの質問（回答待ち）')).toBeGreaterThan(rowOf('── alpha'))
    expect(rowOf('┄┄ ボスの質問（回答待ち）')).toBeLessThan(rowOf('── beta'))
    // 区画の見出しがあるので、質問の見出しにタブの名前は付けない
    expect(lines.some(line => line.includes('回答待ち）（alpha）'))).toBe(false)
  })

  test('幅が狭くても、過去の答えは切らずに質問文のほうを縮める', () => {
    const question = 'ログイン方式をどうするか選んでください。'
    const long = ask({
      questions: [{ question, header: '方式', multiSelect: false, options: [{ label: 'OAuth' }] }],
      status: 'answered',
      answers: { [question]: 'OAuth' },
    })
    const last = (width: number, asks: Ask[]) =>
      linesOf([room('a', 'alpha', { asks })], T, width)
        .map(line => stripAnsi(line).trimEnd())
        .at(-1) ?? ''
    expect(last(60, [long])).toBe('ボス：[方式] ログイン方式をどうす… → OAuth（h で質問の記録）')
    expect(last(60, [long, ask({ id: 'next' })])).toContain('… → OAuth')
    // 質問文を入れる余地がなければ省く
    expect(last(30, [long])).toBe('ボス：[方式] → OAuth（h で質…')
  })

  test('質問の吹き出しも画面の幅を超えない', () => {
    const long = ask({ explanation: `### いまの指示\n${'とても長い説明ニャ'.repeat(20)}` })
    for (const width of [30, 50, 80]) {
      for (const history of [false, true]) {
        for (const line of linesOf([room('a', 'alpha', { asks: [long] })], T, width, { history })) {
          expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  test('色は 24bit カラーで付く', () => {
    expect(linesOf([room('a', 'alpha')], T, 80).join('')).toContain('\x1b[38;2;224;145;58m')
  })
})

describe('猫の詳細', () => {
  const busy = (r: Room): Room => {
    const [boss, kitten] = r.cats
    return {
      ...r,
      cats: [
        boss!,
        {
          ...kitten!,
          toolCount: 3,
          tokens: 12_000,
          current: 'Read types.ts',
          recent: ['Grep "useAuth"', '$ bun test', 'Read room.ts'],
          summary: 'useAuth が重複してたニャ',
        },
      ],
    }
  }

  test('箱の範囲から、クリックした場所の猫が分かる', () => {
    const { lines, hits } = frame([room('a', 'alpha'), room('b', 'beta')], T, 80)
    const plain = lines.map(stripAnsi)
    for (const [id, text] of [
      ['a/k-a', '「alpha を調査」'],
      ['b/k-b', '「beta を調査」'],
    ] as const) {
      const row = plain.findIndex(line => line.includes(text))
      const column = textWidth(plain[row]!.slice(0, plain[row]!.indexOf(text)))
      expect(hitAt(hits, row, column)).toBe(id)
    }
    expect(hitAt(hits, 0, 0)).toBeUndefined()
  })

  test('狭いときは 1 匹 1 行のどこをクリックしてもその猫', () => {
    const { lines, hits } = frame([room('a', 'alpha')], T, 30)
    const row = lines.map(stripAnsi).findIndex(line => line.includes('ソラ'))
    expect(hitAt(hits, row, 0)).toBe('a/k-a')
    expect(hitAt(hits, row, 29)).toBe('a/k-a')
  })

  test('選んだ猫の様子・依頼・報告・最近の操作を出す', () => {
    const { detail } = frame([busy(room('a', 'alpha'))], T + 15_000, 80, { selected: 'a/k-a' })
    const text = detail.map(stripAnsi).join('\n')
    expect(text).toContain('┄┄ ソラの詳細（Explore）')
    expect(text).toContain('様子：▶ Read types.ts · 00:15 · 3 tools · 12k tok')
    expect(text).toContain('ボスからの依頼：alpha を調査')
    expect(text).toContain('報告：useAuth が重複してたニャ')
    expect(text).toContain('最近の操作（新しい順）')
    expect(text.indexOf('Grep "useAuth"')).toBeLessThan(text.indexOf('Read room.ts'))
  })

  test('詳細を見ている猫の報告は、図の下に重ねて出さない', () => {
    const r = busy(room('a', 'alpha'))
    const [boss, kitten] = r.cats
    const reported: Room = { ...r, cats: [boss!, { ...kitten!, status: 'completed', endedAt: T, summaryAt: T }] }
    const body = (selected?: string) =>
      frame([reported], T, 80, selected ? { selected } : {})
        .lines.map(stripAnsi)
        .join('\n')
    expect(body()).toContain('ソラの報告：useAuth が重複してたニャ')
    expect(body('a/k-a')).not.toContain('ソラの報告')
    expect(body('a/main')).toContain('ソラの報告：useAuth が重複してたニャ')
  })

  test('行数が足りなければ古い操作から削り、何件出したかを書く', () => {
    const detail = frame([busy(room('a', 'alpha'))], T, 80, { selected: 'a/k-a', detailRows: 7 }).detail.map(stripAnsi)
    expect(detail).toHaveLength(7)
    expect(detail.join('\n')).toContain('新しい順に 2 / 3 件')
    expect(detail.join('\n')).not.toContain('Read room.ts')
  })

  test('選んだ猫の箱は水色の枠になり、いない猫や選んでいないときは詳細を出さない', () => {
    const selected = frame([room('a', 'alpha')], T, 80, { selected: 'a/k-a' })
    expect(selected.lines.join('')).toContain('\x1b[38;2;95;215;255m')
    expect(frame([room('a', 'alpha')], T, 80).detail).toEqual([])
    expect(frame([room('a', 'alpha')], T, 80, { selected: 'gone' }).detail).toEqual([])
  })

  test('詳細も画面の幅を超えない', () => {
    const long = busy(room('a', 'alpha'))
    const [boss, kitten] = long.cats
    const cats = [boss!, { ...kitten!, description: 'とても長い依頼ニャ'.repeat(20), recent: ['$ '.padEnd(200, 'x')] }]
    for (const width of [30, 50, 80]) {
      for (const line of frame([{ ...long, cats }], T, width, { selected: 'a/k-a' }).detail) {
        expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(width)
      }
    }
  })
})
