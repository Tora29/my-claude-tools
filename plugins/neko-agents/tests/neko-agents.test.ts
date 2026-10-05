import type { AgentInfo, On, ToolCallInput, ToolCallResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import {
  advanceTrip,
  CHAT_EVERY_MS,
  chatter,
  cycle,
  LINES,
  newBoss,
  releaseHold,
  resolveTarget,
  speechOf,
  startTrip,
} from '../hooks/cats'
import { batonsFor } from '../hooks/links'
import { parseRoom } from '../hooks/rooms'
import type { Cat, Room } from '../types'

const DIR = '/home/test/.claude/neko-agents/rooms'
const FILE = `${DIR}/sess-a.json`

const USAGE = {
  input_tokens: 1200,
  output_tokens: 800,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'claude-test',
}

type ToolHook = (e: ToolCallInput) => ToolCallResult | Promise<ToolCallResult>

/**
 * プラグインの下に敷くエンジン役の hook。テストの on は最初に $ を呼ぶ前に
 * 全部登録しておく必要があるので、ツールの答え方もここで受け取る
 */
function engine(on: On, toolCall: ToolHook = () => ({ result: 'ok' })) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const world = {
    agents: [] as AgentInfo[],
    agentLists: 0,
    summary: '「調べ終わったニャ」',
    summaries: 0,
    /** メモリ上のファイル：パス → 中身と更新時刻 */
    files: new Map<string, { text: string; mtimeMs: number }>(),
    writes: 0,
    pruned: 0,
  }
  mock.env(on, { HOME: '/home/test' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'sess-a' }))
  on('session.cwd', () => ({ value: '/work/my-proj' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', (_$, e) => ({ model: 'haiku', agentId: `agent-${e.description}` }))
  on('agent.list', () => {
    world.agentLists++
    return { value: world.agents }
  })
  on('tool.call', (_$, e) => toolCall(e))
  on('classic.PermissionRequest', () => ({}))
  on('fs.write', (_$, e) => {
    world.writes++
    world.files.set(e.path, { text: e.text, mtimeMs: clock.now() })
    return { value: undefined }
  })
  on('process.run', () => {
    world.pruned++
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', () => {
    world.summaries++
    const usage = { input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true as const, text: world.summary, usage } }
  })

  /** 書き出しを待って（0.5 秒まとめてから書く）、書き出された部屋を読む */
  const published = async (): Promise<Room> => {
    await clock.advance(600)
    const room = parseRoom(world.files.get(FILE)?.text ?? '')
    if (!room) throw new Error(`${FILE} が書き出されていない`)
    return room
  }
  return { clock, world, published }
}

function start($: Engine) {
  return $.session.start({ cwd: '/work/my-proj', surface: 'terminal', isInteractive: true })
}

function spawn($: Engine, description: string, subagentType: string) {
  return $.agent.spawn({
    tool_use_id: `toolu-${description}`,
    prompt: description,
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-test',
    background: false,
    fork: false,
  })
}

function finishSubagent($: Engine, agentId: string, reason: 'answer' | 'aborted' | 'error', answer = '') {
  return $.turn.complete({
    answer,
    durationMs: 1000,
    isAborted: reason === 'aborted',
    turnId: `turn-${agentId}`,
    agentId,
    reason,
    usage: USAGE,
  })
}

const catOf = (room: Room, id: string) => room.cats.find(cat => cat.id === id)

/** ツールの答えを手で止めておくための門 */
function gates() {
  const open = new Map<string, () => void>()
  const hook: ToolHook = e =>
    new Promise(resolve =>
      open.set('file_path' in e ? String(e.file_path) : e.tool, () => {
        resolve({ result: 'ok' })
      }),
    )
  return { hook, release: (key: string) => open.get(key)?.() }
}

describe('書き出し', () => {
  test('セッション開始で、ボスをプロジェクト名付きで書き出し、古いファイルを掃除する', async ($, on) => {
    const { world, published } = engine(on)
    await start($)
    const room = await published()
    expect(room.session).toBe('sess-a')
    expect(room.project).toBe('my-proj')
    expect(catOf(room, 'main')?.status).toBe('idle')
    expect(catOf(room, 'main')?.project).toBe('my-proj')
    expect(world.pruned).toBe(1)
  })

  test('中身が変わらなければ書き直さない', async ($, on) => {
    const { clock, world, published } = engine(on)
    await start($)
    await published()
    const writes = world.writes
    await clock.advance(10_000)
    expect(world.writes).toBe(writes)
  })

  test('タブを閉じると「閉じた」と書き出し、/clear で猫がリセットされる', async ($, on) => {
    const { world, published } = engine(on)
    await start($)
    await spawn($, 'gone', 'Explore')
    await published()
    await $.session.end({ reason: 'clear', sessionId: 'sess-a', resume: { id: 'sess-a' } })
    expect(parseRoom(world.files.get(FILE)?.text ?? '')?.closed).toBe(true)
    const room = await published()
    expect(room.cats.map(cat => cat.id)).toEqual(['main'])
  })
})

describe('猫の記録', () => {
  test('agent.spawn で子猫が増え、親の部屋で依頼を受け取る', async ($, on) => {
    const { published } = engine(on)
    await start($)
    await spawn($, '認証の調査', 'Explore')
    const kitten = catOf(await published(), 'agent-認証の調査')
    expect(kitten?.type).toBe('Explore')
    expect(kitten?.description).toBe('認証の調査')
    expect(kitten?.status).toBe('running')
    expect(kitten?.trip).toMatchObject({ to: 'main', reason: 'handoff', phase: 'stay' })
    expect(LINES.spawn.some(line => line === kitten?.say?.text)).toBe(true)
  })

  test('ツールの実行中だけ current が付き、終わると recent に入る', async ($, on) => {
    const gate = gates()
    const { clock, published } = engine(on, gate.hook)
    await start($)
    const call = $.tool.call({ tool: 'Bash', command: 'ls -la' })
    await clock.settle()
    expect(catOf(await published(), 'main')).toMatchObject({ current: '$ ls -la', status: 'running', toolCount: 1 })
    gate.release('Bash')
    await call
    const boss = catOf(await published(), 'main')
    expect(boss?.current).toBeUndefined()
    expect(boss?.recent).toEqual(['$ ls -la'])
  })

  test('並列のツール呼び出しで、先に終わったほうが current を消さない', async ($, on) => {
    const gate = gates()
    const { clock, published } = engine(on, gate.hook)
    await start($)
    const a = $.tool.call({ tool: 'Read', file_path: '/src/a.ts' })
    await clock.settle()
    const b = $.tool.call({ tool: 'Read', file_path: '/src/b.ts' })
    await clock.settle()
    gate.release('/src/a.ts')
    await a
    expect(catOf(await published(), 'main')?.current).toBe('Read b.ts')
    gate.release('/src/b.ts')
    await b
    const boss = catOf(await published(), 'main')
    expect(boss?.current).toBeUndefined()
    expect(boss?.recent).toEqual(['Read b.ts', 'Read a.ts'])
  })

  test('ボスは turn.start で動き出し、turn.complete で寝てトークンを数える', async ($, on) => {
    const { published } = engine(on)
    await start($)
    await $.turn.start({ text: 'やって', turnId: 'turn-1' })
    expect(catOf(await published(), 'main')?.status).toBe('running')
    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      turnId: 'turn-1',
      reason: 'answer',
      usage: USAGE,
    })
    expect(catOf(await published(), 'main')).toMatchObject({ status: 'idle', tokens: 2000 })
  })

  test('子猫の終わり方で状態が決まり、中断以外は親の部屋へ報告に行く', async ($, on) => {
    const { clock, published } = engine(on)
    await start($)
    await spawn($, 'ok', 'Explore')
    await spawn($, 'oops', 'Plan')
    await spawn($, 'stop', 'general-purpose')
    await clock.advance(4000)
    await finishSubagent($, 'agent-ok', 'answer')
    await finishSubagent($, 'agent-oops', 'error')
    await finishSubagent($, 'agent-stop', 'aborted')
    const room = await published()
    expect(catOf(room, 'agent-ok')).toMatchObject({ status: 'completed', trip: { to: 'main', reason: 'report' } })
    expect(catOf(room, 'agent-oops')).toMatchObject({ status: 'failed', trip: { reason: 'report' } })
    expect(catOf(room, 'agent-stop')?.status).toBe('killed')
    expect(catOf(room, 'agent-stop')?.trip).toBeUndefined()
    // 報告のセリフは、親の部屋に着いたころから
    const ok = catOf(room, 'agent-ok')
    expect(LINES.done.some(line => line === ok?.say?.text)).toBe(true)
    expect(ok?.say?.from).toBeGreaterThan(clock.now() - 600)
  })

  test('許可待ちの間だけ asking が付く', async ($, on) => {
    const gate = gates()
    const { clock, published } = engine(on, gate.hook)
    await start($)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    await clock.settle()
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
    const asking = catOf(await published(), 'main')
    expect(asking?.asking).toBe('Bash')
    expect(LINES.asking.some(line => line === asking?.say?.text)).toBe(true)
    gate.release('Bash')
    await call
    expect(catOf(await published(), 'main')?.asking).toBeUndefined()
  })

  test('ツールがエラーになると、しゃべる', async ($, on) => {
    const { published } = engine(on, () => ({ result: 'boom', isError: true }))
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'false' })
    const boss = catOf(await published(), 'main')
    expect(LINES.error.some(line => line === boss?.say?.text)).toBe(true)
  })

  test('agent.list で状態を補正し、働く猫がいなくなるとタイマーが止まる', async ($, on) => {
    const { clock, world, published } = engine(on)
    await start($)
    await spawn($, 'tick', 'Explore')
    await clock.advance(5000)
    world.agents = [{ id: 'agent-tick', type: 'Explore', description: 'tick', status: 'completed' }]
    await clock.advance(1000)
    expect(catOf(await published(), 'agent-tick')?.status).toBe('completed')
    // 全員落ち着いたら、もう agent.list は呼ばない
    await clock.advance(20_000)
    const calls = world.agentLists
    await clock.advance(10_000)
    expect(world.agentLists).toBe(calls)
  })
})

describe('つながり', () => {
  test('お手紙：SendMessage でつながりができ、宛先の部屋へ出かける', async ($, on) => {
    const { clock, published } = engine(on)
    await start($)
    await spawn($, 'mail', 'Explore')
    await clock.advance(4000)
    await $.tool.call({ tool: 'SendMessage', to: 'agent-mail', message: 'よろしく' })
    const room = await published()
    expect(room.links).toContainEqual({ from: 'main', to: 'agent-mail', kind: 'letter' })
    expect(catOf(room, 'main')?.trip).toMatchObject({ to: 'agent-mail', reason: 'letter' })
  })

  test('引き継ぎ：完了した兄弟の後に起動された子猫へ点線を引く', async ($, on) => {
    const { clock, published } = engine(on)
    await start($)
    await spawn($, 'a', 'Explore')
    await spawn($, 'b', 'Explore')
    await clock.advance(4000)
    await finishSubagent($, 'agent-a', 'answer')
    await finishSubagent($, 'agent-b', 'answer')
    await clock.advance(9000)
    await spawn($, 'review', 'general-purpose')
    const room = await published()
    expect(room.links).toContainEqual({ from: 'agent-a', to: 'agent-review', kind: 'baton' })
    expect(room.links).toContainEqual({ from: 'agent-b', to: 'agent-review', kind: 'baton' })
  })
})

describe('要約', () => {
  test('子猫の結果を猫口調の 1 文に要約して残し、報告先でしゃべる', async ($, on) => {
    const { clock, world, published } = engine(on)
    world.summary = '「useAuth が重複してたニャ！」\n'
    await start($)
    await spawn($, 'sum', 'Explore')
    await clock.advance(5000)
    await finishSubagent($, 'agent-sum', 'answer', 'useAuth フックが 3 つのファイルで重複して定義されていました。')
    await clock.advance(2000)
    const kitten = catOf(await published(), 'agent-sum')
    expect(world.summaries).toBe(1)
    expect(kitten?.summary).toBe('useAuth が重複してたニャ！')
    expect(kitten?.say?.text).toBe('useAuth が重複してたニャ！')
  })

  test('要約をオフにすると haiku を呼ばない', { options: { summarize: false } }, async ($, on) => {
    const { clock, world, published } = engine(on)
    await start($)
    await spawn($, 'nosum', 'Explore')
    await clock.advance(5000)
    await finishSubagent($, 'agent-nosum', 'answer', '結果です')
    await clock.advance(2000)
    expect(world.summaries).toBe(0)
    expect(catOf(await published(), 'agent-nosum')?.summary).toBeUndefined()
  })
})

describe('純粋なロジック', () => {
  const kitten = (id: string, extra: Partial<Cat> = {}): Cat => ({
    ...newBoss(0),
    id,
    name: id,
    type: 'Explore',
    status: 'running',
    ...extra,
  })
  const tripOf = (list: Cat[], id: string) => list.find(cat => cat.id === id)?.trip

  test('cycle は範囲外の番号を折り返す', () => {
    expect(cycle(['a', 'b', 'c'], 4)).toBe('b')
    expect(cycle(['a', 'b', 'c'], -1)).toBe('c')
  })

  test('レビュー：Read の間は滞在し続け、終わってから 3 秒で帰る', () => {
    let list = startTrip([newBoss(0), kitten('writer'), kitten('reader')], 'reader', 'writer', 'review', 0, {
      holdId: 'read-1',
    })
    const trip = tripOf(list, 'reader')
    if (!trip) throw new Error('お出かけしていない')
    expect(advanceTrip(trip, 3000)?.phase).toBe('stay')
    expect(advanceTrip(trip, 60_000)?.phase).toBe('stay')

    list = list.map(cat => releaseHold(cat, 'read-1', 60_000))
    const released = tripOf(list, 'reader')
    if (!released) throw new Error('お出かけしていない')
    expect(advanceTrip(released, 62_999)?.phase).toBe('stay')
    expect(advanceTrip(released, 63_000)?.phase).toBe('depart')
    expect(advanceTrip(released, 66_000)).toBeUndefined()
  })

  test('別の部屋へ出かけ中なら新しいお出かけは無視し、同じ部屋なら滞在を延ばす', () => {
    const list = startTrip([newBoss(0), kitten('a'), kitten('b'), kitten('c')], 'c', 'a', 'letter', 0)
    expect(startTrip(list, 'c', 'b', 'review', 100)).toEqual(list)
    const extended = startTrip(list, 'c', 'a', 'review', 100, { holdId: 'r' })
    expect(tripOf(extended, 'c')?.holdId).toBe('r')
  })

  test('SendMessage の宛先は名前・agentId・main のどれでも見つかる', () => {
    const cats = [newBoss(0), kitten('agent-1', { handle: 'scout' })]
    expect(resolveTarget(cats, 'main')).toBe('main')
    expect(resolveTarget(cats, 'agent-1')).toBe('agent-1')
    expect(resolveTarget(cats, 'scout')).toBe('agent-1')
    expect(resolveTarget(cats, 'scout@team')).toBe('agent-1')
    expect(resolveTarget(cats, 'nobody')).toBeUndefined()
  })

  test('引き継ぎは、前の起動より後に完了した兄弟だけ', () => {
    const cats = [
      newBoss(0),
      kitten('old', { status: 'completed', startedAt: 0, endedAt: 5 }),
      kitten('a', { status: 'completed', startedAt: 10, endedAt: 30 }),
      kitten('b', { status: 'completed', startedAt: 20, endedAt: 40 }),
      kitten('c', { startedAt: 50 }),
    ]
    expect(batonsFor(cats, 'main', 'c')).toEqual(['a', 'b'])
  })

  test('ひとりごとは 30 秒ごとに 30% くらい。長引くとぼやき、暇なボスは退屈する', () => {
    const runner = kitten('agent-x', { startedAt: 0 })
    const times = Array.from({ length: 200 }, (_, i) => i * CHAT_EVERY_MS + 10)
    const spoken = times.map(t => chatter(runner, t, false)).filter(cat => cat.say)
    expect(spoken.length).toBeGreaterThan(30)
    expect(spoken.length).toBeLessThan(90)
    for (const cat of spoken) {
      const from = cat.say?.from ?? 0
      const text = speechOf(cat, from)
      const pool: readonly string[] = from - cat.startedAt > 120_000 ? LINES.long : LINES.chat
      expect(pool.some(line => line === text)).toBe(true)
    }

    const boss = newBoss(0)
    expect(times.some(t => chatter(boss, t, false).say)).toBe(false)
    const bored = times.map(t => chatter(boss, t, true)).filter(cat => cat.say)
    expect(bored.length).toBeGreaterThan(0)
    expect(bored.every(cat => LINES.bored.some(line => line === cat.say?.text))).toBe(true)
  })

  test('同じ 30 秒の間に二度はしゃべらない', () => {
    const runner = kitten('agent-y', { startedAt: 0 })
    const t = Array.from({ length: 200 }, (_, i) => i * CHAT_EVERY_MS + 10).find(t => chatter(runner, t, false).say)
    if (t === undefined) throw new Error('一度もしゃべらなかった')
    const once = chatter(runner, t, false)
    expect(chatter(once, t + 5000, false)).toBe(once)
  })
})
