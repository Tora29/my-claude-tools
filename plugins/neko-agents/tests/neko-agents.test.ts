import type { AgentInfo, On, ToolCallInput, ToolCallResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import {
  advanceTrip,
  catArt,
  CHAT_EVERY_MS,
  chatter,
  cleanSummary,
  coatOf,
  cycle,
  LINES,
  newBoss,
  releaseHold,
  resolveTarget,
  speechOf,
  startTrip,
  SUMMARY_MAX,
} from '../hooks/cats'
import { batonsFor } from '../hooks/links'
import {
  answersOf,
  contextOf,
  EXPLAIN_SYSTEM,
  FREEFORM,
  kittenDigest,
  splitAnswers,
  toQuestions,
} from '../hooks/questions'
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
    /** haiku に渡した文章（新しいものが後ろ） */
    prompts: [] as string[],
    /** haiku に渡した system（prompts と同じ並び） */
    systems: [] as string[],
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
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'ログイン画面を作って', toolUses: [] },
      {
        role: 'assistant',
        text: '方式を決めたいので確認します',
        toolUses: [{ tool_use_id: 'toolu-read', tool: 'Read', input: { file_path: '/src/login.ts' } }],
      },
    ],
  }))
  on('fs.write', (_$, e) => {
    world.writes++
    world.files.set(e.path, { text: e.text, mtimeMs: clock.now() })
    return { value: undefined }
  })
  on('process.run', () => {
    world.pruned++
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', (_$, e) => {
    world.summaries++
    world.prompts.push(e.prompt)
    world.systems.push(e.system ?? '')
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

/** ボスのターン（ユーザーの入力から返事まで）。text が空なら入力のない続きのターン */
async function bossTurn($: Engine, turnId: string, text: string, work?: () => Promise<unknown>) {
  await $.turn.start({ text, turnId })
  await work?.()
  return $.turn.complete({ answer: `${turnId} の返事`, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
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
    // うまくいった子猫は歩きながら親の名前を呼び、失敗した子猫は親の部屋に着いたころにしゃべる
    const ok = catOf(room, 'agent-ok')
    expect(LINES.report.map(line => line.replace('{to}', 'ボス'))).toContain(ok?.say?.text ?? '')
    const oops = catOf(room, 'agent-oops')
    expect(LINES.failed.some(line => line === oops?.say?.text)).toBe(true)
    expect(oops?.say?.from).toBeGreaterThan(clock.now() - 600)
    expect(ok?.say?.from ?? Infinity).toBeLessThan(oops?.say?.from ?? 0)
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

  test('子猫を使った作業が終わると、ボスがまとめてしゃべる', async ($, on) => {
    const { clock, world, published } = engine(on)
    await start($)
    await bossTurn($, 'turn-1', 'useAuth を調べて', async () => {
      await spawn($, 'auth', 'Explore')
      await clock.advance(3000)
      await finishSubagent($, 'agent-auth', 'answer', 'useAuth が重複していました')
      await clock.advance(1000)
    })
    world.summary = '「useAuth の重複を見つけて直したニャ」'
    await clock.advance(1000)
    const boss = catOf(await published(), 'main')
    expect(world.summaries).toBe(2)
    expect(world.prompts[1]).toContain('（Explore・✓ 完了）：auth')
    expect(world.prompts[1]).toContain('turn-1 の返事')
    expect(boss?.summary).toBe('useAuth の重複を見つけて直したニャ')
    expect(boss?.say?.text).toBe('useAuth の重複を見つけて直したニャ')
  })

  test('子猫を使わないターンでは、ボスはまとめない', async ($, on) => {
    const { clock, world, published } = engine(on)
    await start($)
    await bossTurn($, 'turn-1', 'こんにちは')
    await clock.advance(1000)
    expect(world.summaries).toBe(0)
    expect(catOf(await published(), 'main')?.summary).toBeUndefined()
  })

  test('子猫が動いている間はまとめず、続きのターンで全員終わってから 1 回だけまとめる', async ($, on) => {
    const { clock, world } = engine(on)
    await start($)
    await bossTurn($, 'turn-1', '裏で調べて', async () => {
      await spawn($, 'fg', 'Plan')
      await spawn($, 'bg', 'Explore')
      await finishSubagent($, 'agent-fg', 'answer')
    })
    await clock.advance(1000)
    expect(world.summaries).toBe(0)

    await clock.advance(3000)
    await finishSubagent($, 'agent-bg', 'answer', '調べました')
    await clock.advance(1000)
    await bossTurn($, 'turn-2', '')
    await clock.advance(1000)
    expect(world.summaries).toBe(2)
    expect(world.prompts[1]).toContain('：bg')

    // 子猫を使わない続きのターンでは、もうまとめない
    await bossTurn($, 'turn-3', '')
    await clock.advance(1000)
    expect(world.summaries).toBe(2)
  })

  test('新しい入力の作業では、前の作業の子猫を材料にしない', async ($, on) => {
    const { clock, world } = engine(on)
    await start($)
    await bossTurn($, 'turn-1', '調べて', async () => {
      await spawn($, 'old', 'Explore')
      await finishSubagent($, 'agent-old', 'answer', '前の結果')
    })
    await clock.advance(1000)
    await bossTurn($, 'turn-2', '次はこれ', async () => {
      await spawn($, 'new', 'Plan')
      await finishSubagent($, 'agent-new', 'answer', '次の結果')
    })
    await clock.advance(1000)
    const last = world.prompts[world.prompts.length - 1] ?? ''
    expect(last).toContain('：new')
    expect(last).not.toContain('：old')
  })

  test('裏で動いた子猫の完了通知で始まるターンは、同じ作業の続きとみなしてまとめる', async ($, on) => {
    const { clock, world, published } = engine(on)
    await start($)
    await $.prompt.submit({ text: '調べて', wait: false, origin: { kind: 'composer' } })
    await bossTurn($, 'turn-1', '調べて', () => spawn($, 'bg', 'Explore'))
    const taskAt = catOf(await published(), 'main')?.taskAt
    await finishSubagent($, 'agent-bg', 'answer', '裏の結果')
    // 完了通知はユーザーの入力ではない（本文はあるが origin で見分ける）
    await $.prompt.submit({ text: '<agent-message> 報告', wait: false, origin: { kind: 'task-notification' } })
    await bossTurn($, 'turn-2', '<agent-message> 報告')
    await clock.advance(1000)
    expect(catOf(await published(), 'main')?.taskAt).toBe(taskAt)
    expect(world.prompts.at(-1)).toContain('：bg')
  })

  test('裏で動いた子猫は、SubagentHandback で渡した報告を結果として要約する', async ($, on) => {
    const { clock, world, published } = engine(on)
    await start($)
    await spawn($, 'bg', 'Explore')
    // agentId はエンジンが付けるもので、SubagentHandback は $.tool.call の引数の型には無い
    const handback = { tool: 'SubagentHandback', agentId: 'agent-bg', message: 'useAuth が 2 つあった' }
    await $.tool.call(handback as unknown as Parameters<typeof $.tool.call>[0])
    // 裏で動いた子猫の turn.complete は answer が空で届く
    await finishSubagent($, 'agent-bg', 'answer', '')
    await clock.settle()
    expect(world.prompts.at(-1)).toBe('useAuth が 2 つあった')
    expect(catOf(await published(), 'agent-bg')?.summary).toBe('調べ終わったニャ')
  })

  test('要約をオフにすると haiku を呼ばない', { options: { summarize: false } }, async ($, on) => {
    const { clock, world, published } = engine(on)
    await start($)
    await spawn($, 'nosum', 'Explore')
    await clock.advance(5000)
    await finishSubagent($, 'agent-nosum', 'answer', '結果です')
    await bossTurn($, 'turn-1', '')
    await clock.advance(2000)
    expect(world.summaries).toBe(0)
    expect(catOf(await published(), 'agent-nosum')?.summary).toBeUndefined()
  })
})

const QUESTION = {
  question: 'どの方式でログインを作りますか？',
  header: '方式',
  multiSelect: false,
  options: [
    { label: 'OAuth', description: '外部のアカウントで入る' },
    { label: 'パスワード', description: '自前で持つ' },
  ],
}

/** AskUserQuestion の答え方。answer を渡せばその答え、undefined なら答えずに閉じる */
function answering(answer: string | undefined): ToolHook {
  return e =>
    e.tool !== 'AskUserQuestion'
      ? { result: 'ok' }
      : answer === undefined
        ? { result: 'closed', isError: true }
        : { result: { questions: [QUESTION], answers: { [QUESTION.question]: answer } } }
}

const askOf = (room: Room) => room.asks?.at(-1)

describe('質問', () => {
  test('質問した猫がしゃべり、質問・猫口調の解説・答えを部屋に残す', async ($, on) => {
    let release: (() => void) | undefined
    const { clock, world, published } = engine(on, e =>
      e.tool === 'AskUserQuestion'
        ? new Promise(resolve => {
            release = () => {
              resolve({ result: { questions: [QUESTION], answers: { [QUESTION.question]: 'OAuth' } } })
            }
          })
        : { result: 'ok' },
    )
    world.summary = '### いまの指示\nログイン画面を作ってるニャ'
    await start($)
    await $.prompt.submit({ text: 'ログイン画面を作って', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'ログイン画面を作って', turnId: 'turn-1' })
    const call = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu-ask', questions: [QUESTION] })
    await clock.settle()

    const asking = await published()
    expect(askOf(asking)).toMatchObject({ id: 'toolu-ask', catId: 'main', status: 'open', explain: 'done' })
    expect(askOf(asking)?.questions[0]?.options.map(o => o.label)).toEqual(['OAuth', 'パスワード'])
    expect(askOf(asking)?.explanation).toBe('### いまの指示\nログイン画面を作ってるニャ')
    expect(LINES.question.some(line => line === catOf(asking, 'main')?.say?.text)).toBe(true)
    // 「聞きたいニャ」は答えるまで出し続ける（しばらくたっても、ひとりごとで上書きしない）
    await clock.advance(5 * 60_000)
    const waiting = catOf(await published(), 'main')
    expect(LINES.question.some(line => waiting && line === speechOf(waiting, clock.now()))).toBe(true)
    expect(catOf(asking, 'main')?.current).toBe('質問「方式」')
    // 解説の材料：猫口調の指示、ユーザーの入力、直前の Claude の説明、質問
    expect(world.systems.at(-1)).toBe(EXPLAIN_SYSTEM)
    expect(world.prompts.at(-1)).toContain('ログイン画面を作って')
    expect(world.prompts.at(-1)).toContain('方式を決めたいので確認します')
    expect(world.prompts.at(-1)).toContain('パスワード')

    release?.()
    await call
    const answered = await published()
    expect(askOf(answered)).toMatchObject({ status: 'answered', answers: { [QUESTION.question]: 'OAuth' } })
    expect(catOf(answered, 'main')?.say?.text).toBe('「OAuth」にするニャ！')
  })

  test('答えずに閉じたらキャンセルにする', async ($, on) => {
    const { published } = engine(on, answering(undefined))
    await start($)
    await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu-ask', questions: [QUESTION] })
    const room = await published()
    expect(askOf(room)).toMatchObject({ status: 'cancelled', answers: {} })
    expect(catOf(room, 'main')?.say).toBeUndefined()
  })

  test('子猫の質問は子猫のものとして残し、質問は 10 件まで', async ($, on) => {
    const { published } = engine(on, answering('パスワード'))
    await start($)
    await spawn($, 'ask', 'general-purpose')
    for (let i = 0; i < 12; i++) {
      // agentId はエンジンが付けるもので、$.tool.call の引数の型には無い
      const input = {
        tool: 'AskUserQuestion' as const,
        tool_use_id: `toolu-${i}`,
        agentId: 'agent-ask',
        questions: [QUESTION],
      }
      await $.tool.call(input)
    }
    const room = await published()
    expect(room.asks?.length).toBe(10)
    expect(room.asks?.[0]?.id).toBe('toolu-2')
    expect(askOf(room)).toMatchObject({ catId: 'agent-ask', status: 'answered' })
  })

  test('質問のダイアログは許可待ちにしない', async ($, on) => {
    const { published } = engine(on, answering('OAuth'))
    await start($)
    await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] } })
    expect(catOf(await published(), 'main')?.asking).toBeUndefined()
  })

  test('/clear で質問の記録も消える', async ($, on) => {
    const { published } = engine(on, answering('OAuth'))
    await start($)
    await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu-ask', questions: [QUESTION] })
    await published()
    await $.session.end({ reason: 'clear', sessionId: 'sess-a', resume: { id: 'sess-a' } })
    expect((await published()).asks).toBeUndefined()
  })

  test('解説の材料に、今の作業の子猫の結果と、まだ作業中の子猫を渡す', async ($, on) => {
    const { clock, world, published } = engine(on, answering('OAuth'))
    await start($)
    await $.turn.start({ text: 'ログイン画面を作って', turnId: 'turn-1' })
    await spawn($, 'useAuth の調査', 'Explore')
    await spawn($, 'API の調査', 'Explore')
    await finishSubagent($, 'agent-useAuth の調査', 'answer', 'useAuth が 2 か所で定義されていた')
    await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu-ask', questions: [QUESTION] })
    await clock.settle()
    const room = await published()
    const prompt = world.prompts[world.systems.lastIndexOf(EXPLAIN_SYSTEM)] ?? ''
    const done = catOf(room, 'agent-useAuth の調査')?.name ?? '?'
    const running = catOf(room, 'agent-API の調査')?.name ?? '?'
    expect(prompt).toContain(`${done}（Explore）：useAuth の調査\n  結果：useAuth が 2 か所で定義されていた`)
    expect(prompt).toContain(`${running}（Explore）：API の調査 → まだ作業中`)
  })

  test('回答待ちの間に子猫が終わったら、続けて終わった分をまとめて 1 回だけ解説を作り直す', async ($, on) => {
    let release: (() => void) | undefined
    const { clock, world, published } = engine(on, e =>
      e.tool === 'AskUserQuestion'
        ? new Promise(resolve => {
            release = () => {
              resolve({ result: { questions: [QUESTION], answers: { [QUESTION.question]: 'OAuth' } } })
            }
          })
        : { result: 'ok' },
    )
    const explains = () => world.systems.filter(system => system === EXPLAIN_SYSTEM).length
    world.summary = '最初の解説ニャ'
    await start($)
    await $.turn.start({ text: 'ログイン画面を作って', turnId: 'turn-1' })
    await spawn($, 'a', 'Explore')
    await spawn($, 'b', 'Explore')
    const call = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu-ask', questions: [QUESTION] })
    await clock.settle()
    expect(explains()).toBe(1)

    world.summary = '考え直した解説ニャ'
    await finishSubagent($, 'agent-a', 'answer', 'a の結果')
    await clock.advance(1000)
    await finishSubagent($, 'agent-b', 'answer', 'b の結果')
    await clock.advance(1000)
    // b が終わってからまだ 2 秒たっていないので、作り直していない
    expect(explains()).toBe(1)
    await clock.advance(1500)
    expect(explains()).toBe(2)
    const room = await published()
    const names = ['agent-a', 'agent-b'].map(id => catOf(room, id)?.name)
    expect(askOf(room)).toMatchObject({ explain: 'done', explanation: '考え直した解説ニャ', revisedFor: names })
    const prompt = world.prompts[world.systems.lastIndexOf(EXPLAIN_SYSTEM)] ?? ''
    expect(prompt).toContain('a の結果')
    expect(prompt).toContain('b の結果')

    release?.()
    await call
    // 答えたあとに子猫が終わっても、もう作り直さない
    await spawn($, 'c', 'Explore')
    await finishSubagent($, 'agent-c', 'answer', 'c の結果')
    await clock.advance(3000)
    expect(explains()).toBe(2)
  })

  test('解説をオフにすると haiku を呼ばない', { options: { explainQuestions: false } }, async ($, on) => {
    const { world, published } = engine(on, answering('OAuth'))
    await start($)
    await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu-ask', questions: [QUESTION] })
    expect(askOf(await published())?.explain).toBe('off')
    expect(world.summaries).toBe(0)
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

  test('質問：引数と答えを取り出し、複数選択の答えを分ける', () => {
    expect(toQuestions([{ question: 'Q?', options: [{ label: 'A' }], extra: 1 }, 'x'])).toEqual([
      { question: 'Q?', multiSelect: false, options: [{ label: 'A' }] },
      { question: '', multiSelect: false, options: [] },
    ])
    expect(answersOf({ answers: { 'Q?': 'A' }, response: '自分で書いた' })).toEqual({
      'Q?': 'A',
      [FREEFORM]: '自分で書いた',
    })
    expect(answersOf('closed')).toBeUndefined()
    expect(splitAnswers('A, "B, C", "say ""hi"" now"')).toEqual(['A', 'B, C', 'say "hi" now'])
  })

  test('質問の材料は、最後のユーザーの入力より後の説明とツール操作', () => {
    const context = contextOf([
      { role: 'user', text: '前の指示', toolUses: [] },
      { role: 'assistant', text: '前の説明', toolUses: [] },
      { role: 'user', text: '今の指示', toolUses: [] },
      { role: 'assistant', text: '今の説明', toolUses: [{ tool: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{}] },
    ])
    expect(context).toEqual({ lead: '今の説明', tools: ['Bash: ls'], prompts: ['前の指示', '今の指示'] })
  })

  test('子猫の作業の材料：終わった子猫は結果、動いている子猫は「まだ作業中」だけ', () => {
    const kitten = (id: string, status: Cat['status']): Cat => ({
      ...newBoss(0),
      id,
      name: id,
      type: 'Explore',
      description: `${id} の調査`,
      status,
      current: 'Grep "secret"',
    })
    const digest = kittenDigest(
      [kitten('ソラ', 'completed'), kitten('クロ', 'running'), kitten('ハチ', 'failed'), kitten('モモ', 'killed')],
      { ソラ: '見つけた' },
    )
    expect(digest).toBe(
      [
        '- ソラ（Explore）：ソラ の調査\n  結果：見つけた',
        '- クロ（Explore）：クロ の調査 → まだ作業中',
        '- ハチ（Explore）：ハチ の調査 → 失敗',
        '- モモ（Explore）：モモ の調査 → 中断',
      ].join('\n'),
    )
    // 今どのツールを使っているかは渡さない
    expect(digest).not.toContain('Grep')
  })

  test('毛色は名前で決まり、種類や id では変わらない。ボスは茶トラ', () => {
    const white = coatOf({ id: 'a', type: 'stray', name: 'シロ' })
    expect(white).toEqual(coatOf({ id: 'sess/b', type: 'Plan', name: 'シロ' }))
    expect(new Set(white).size).toBe(1)
    expect(coatOf({ id: 'c', type: 'Explore', name: 'ミケ' })).toEqual(['#e0913a', '#eeeeee', '#8a8a8a'])
    expect(coatOf({ id: 'd', type: 'Explore', name: 'クロ' })).toEqual(['#8a8a8a', '#8a8a8a', '#8a8a8a'])
    expect(coatOf(newBoss(0))).toEqual(['#e0913a', '#e0913a', '#e0913a'])
    // 一覧に無い名前でも、同じ名前なら同じ色
    expect(coatOf({ id: 'e', type: 'x', name: 'ポチ' })).toEqual(coatOf({ id: 'f', type: 'y', name: 'ポチ' }))
  })

  test('要約は最初の 1 行の引用符を外し、指示より長くても SUMMARY_MAX 文字までは切らない', () => {
    expect(cleanSummary('\n「見つけたニャ」\n補足')).toBe('見つけたニャ')
    expect(cleanSummary('親猫へのご報告ニャ：重複が3件あったニャ')).toBe('重複が3件あったニャ')
    expect(cleanSummary('「ボスへ報告ニャ！ 型エラーは直ったニャ」')).toBe('型エラーは直ったニャ')
    expect(cleanSummary('報告書の誤字を直したニャ')).toBe('報告書の誤字を直したニャ')
    const long = `ポリシー文書を版0.08から0.09に更新し、根拠ある19件を修正、方針判断1件を残したニャ`
    expect(cleanSummary(long)).toBe(long)
    expect(cleanSummary('あ'.repeat(SUMMARY_MAX + 10))).toHaveLength(SUMMARY_MAX)
  })

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

  test('作業中の猫は気まぐれに足を動かしてキョロキョロし、待っている猫はまばたきだけする', () => {
    // 1 分間を 0.2 秒ごとに描いたときの顔と足
    const times = Array.from({ length: 300 }, (_, i) => i * 200)
    const runner = kitten('agent-art', { status: 'running' })
    const arts = times.map(t => catArt(runner, t))
    expect(arts.every(art => art.every(line => line.length === 7))).toBe(true)
    const faces = new Set(arts.map(art => art[1]))
    for (const face of ['( o.o )', '(o.o  )', '(  o.o)']) expect(faces.has(face)).toBe(true)
    expect([...faces].some(face => face.includes('-.-'))).toBe(true)
    expect(new Set(arts.map(art => art[2]))).toEqual(new Set([' /| |\\ ', ' \\| |/ ']))
    // 同じ 1 秒の中では、まばたき以外は変わらない（描き直してもチラつかない）
    expect(catArt(runner, 5000)[2]).toBe(catArt(runner, 5800)[2])
    // 猫ごとにばらばらに動く
    const other = kitten('agent-art-2', { status: 'running' })
    expect(times.some(t => catArt(runner, t).join() !== catArt(other, t).join())).toBe(true)

    const waiter = kitten('agent-wait', { status: 'waiting' })
    const waits = new Set(times.map(t => catArt(waiter, t).join('|')))
    expect(waits).toEqual(new Set([' /\\_/\\ |( o.o )| /| |\\ ', ' /\\_/\\ |( -.- )| /| |\\ ']))
  })

  test('同じ 30 秒の間に二度はしゃべらない', () => {
    const runner = kitten('agent-y', { startedAt: 0 })
    const t = Array.from({ length: 200 }, (_, i) => i * CHAT_EVERY_MS + 10).find(t => chatter(runner, t, false).say)
    if (t === undefined) throw new Error('一度もしゃべらなかった')
    const once = chatter(runner, t, false)
    expect(chatter(once, t + 5000, false)).toBe(once)
  })
})
