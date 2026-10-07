// neko-agents：エージェントの動きを猫の状態にして、~/.claude/neko-agents/rooms/<セッションid>.json に書き出す。
// 見るのはビューア（tools/neko-room）。この Mod は記録して書き出すだけで、画面には何も描かない。
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Ask, Cat } from '../types'
import {
  advanceTrip,
  advanceTrips,
  ASK_SAY_MS,
  bossDigest,
  chatter,
  cleanSummary,
  HANDOFF_STAY_MS,
  isActive,
  isBoss,
  isEnded,
  MAIN_ID,
  needsBossSummary,
  newBoss,
  parentOf,
  pickLine,
  pickName,
  RECENT_MAX,
  releaseHold,
  resolveTarget,
  SAY_MS,
  speak,
  startTrip,
  str,
  summarize,
  SUMMARY_SAY_MS,
  taskKittens,
  type ToolArgs,
  totalTokens,
  WALK_MS,
  withoutAsking,
  withoutCurrent,
  withoutEnd,
  withoutSay,
  writtenPath,
} from './cats'
import { addLink, batonsFor } from './links'
import {
  addAsk,
  answeredLine,
  answersOf,
  cleanExplanation,
  contextOf,
  EXPLAIN_SYSTEM,
  explainPrompt,
  helpersOf,
  kittenDigest,
  PROMPTS_MAX,
  rememberReport,
  REVISE_DELAY_MS,
  toQuestions,
  updateAsk,
} from './questions'
import { contentKey, HEARTBEAT_MS, projectOf, PUBLISH_DELAY_MS, roomFile, ROOMS_DIR, snapshot } from './rooms'

/** 野良猫がこの時間ツールを呼ばなければ寝たことにする */
const STRAY_NAP_MS = 60_000
/** 猫が働いている間、状態を進める間隔（歩くアニメーションはビューアが時刻から計算する） */
const TICK_MS = 1000

const cats = atom({ plugin: 'neko-agents', key: 'cats' } as const, [])
const files = atom({ plugin: 'neko-agents', key: 'files' } as const, {})
const links = atom({ plugin: 'neko-agents', key: 'links' } as const, [])
const asks = atom({ plugin: 'neko-agents', key: 'asks' } as const, [])
const prompts = atom({ plugin: 'neko-agents', key: 'prompts' } as const, [])
const reports = atom({ plugin: 'neko-agents', key: 'reports' } as const, {})

const SUMMARY_SYSTEM = [
  'あなたは猫です。渡される文章は、あなた（子猫）がこなした調査や作業の結果です。',
  'いちばん大事な発見や結果を、報告の中身だけ 1 文にまとめてください。「〜への報告ニャ」のような前置きは付けないでください。',
  '語尾は「ニャ」にして、25 文字以内で答えてください。前置き・引用符・改行は付けないでください。',
].join('\n')

const BOSS_SUMMARY_SYSTEM = [
  'あなたは親猫（ボス）です。渡される文章は、あなたが子猫たちに手伝ってもらってこなした作業の記録です。',
  '結局なにをして、どうなったかを 1 文にまとめてください。',
  '語尾は「ニャ」にして、35 文字以内で答えてください。前置き・引用符・改行は付けないでください。',
].join('\n')

type Dollar = EngineInterface

/** 失敗してもよい後回しの処理（書き出しなど）の失敗は捨てる。次の回にまたやる */
const ignore = (): undefined => undefined

// タイマーや書き出しの状態はホットリロードで消えるので、モジュール変数で持ってよい
let timer: Timer | undefined
let roomsDir: string | undefined
let publishTimer: Timer | undefined
let lastKey = ''
let lastWriteAt = 0
let bossSummarizing = false
/**
 * 次のターンが、ユーザー本人の入力で始まるか（prompt.submit で決めて turn.start で使う）。
 * 子猫の完了通知や別のセッションからのメッセージで始まるターンは、同じ作業の続きとみなす
 */
let fromUser: boolean | undefined
/** 質問 id → 何回目の解説か。作り直したあとに古い解説が届いても書かない */
const explainRuns = new Map<string, number>()
/** 質問 id → 作り直しの予約（待っている間に終わった子猫の名前） */
const revisions = new Map<string, { timer: Timer; names: string[] }>()

// ---------------------------------------------------------------- タイマー

function stopTicking() {
  timer?.cancel()
  timer = undefined
}

/** 歩いている・働いている・しゃべっている猫がいる間だけ、1 秒ごとに状態を進める */
function needsTicking(list: readonly Cat[], t: number): boolean {
  return list.some(cat => cat.trip !== undefined || isActive(cat) || (cat.say?.until ?? 0) > t)
}

/** 状態が変わったあとに呼ぶ。タイマーを合わせて、書き出しを予約する（失敗しても呼んだ hook は止めない） */
async function changed($: Dollar) {
  try {
    const keep = needsTicking(await read($, cats), await $.clock.now())
    if (!keep) stopTicking()
    else timer ??= $.clock.every(TICK_MS, () => void tick($).catch(stopTicking))
  } catch {
    // 次のイベントでまた試す
  }
  publishSoon($)
}

async function tick($: Dollar) {
  const t = await $.clock.now()
  const agents = await $.agent.list()
  const list = await update($, cats, list => {
    const advanced = advanceTrips(reconcile(list, agents, t), t)
    const othersBusy = advanced.some(cat => !isBoss(cat) && isActive(cat))
    return advanced.map(cat => chatter(cat, t, othersBusy))
  })
  if (!needsTicking(list, t)) stopTicking()
  publishSoon($)
}

/** $.agent.list() の状態に合わせる。一覧に出ない猫（野良猫など）はそのまま */
function reconcile(list: Cat[], agents: AgentInfo[], t: number): Cat[] {
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  return list.map(cat => {
    const agent = byId.get(cat.id)
    if (!agent) {
      if (cat.type === 'stray' && cat.status === 'running' && t - (cat.activeAt ?? cat.startedAt) > STRAY_NAP_MS) {
        return { ...withoutCurrent(cat), status: 'idle' }
      }
      return cat
    }
    const named = agent.name && !cat.handle ? { ...cat, handle: agent.name } : cat
    if (agent.status === named.status) return named
    const next: Cat = { ...named, status: agent.status }
    if (isEnded(next)) return { ...withoutCurrent(next), endedAt: cat.endedAt ?? t }
    return withoutEnd(next)
  })
}

// ---------------------------------------------------------------- 書き出し

async function roomsDirOf($: Dollar): Promise<string | undefined> {
  if (roomsDir) return roomsDir
  const home = await $.env.get('HOME')
  roomsDir = home ? `${home}/${ROOMS_DIR}` : undefined
  return roomsDir
}

/** 1 日以上更新のない部屋のファイルを掃除する（$.fs には消す API が無いので find で） */
async function pruneRooms($: Dollar) {
  const dir = await roomsDirOf($)
  if (dir) await $.process.run(['find', dir, '-name', '*.json', '-mtime', '+0', '-delete'])
}

/** 書き出しは少しまとめてから。タイマーから動かすので、呼んだ hook を待たせない */
function publishSoon($: Dollar) {
  if (publishTimer) return
  publishTimer = $.clock.after(PUBLISH_DELAY_MS, () => {
    publishTimer = undefined
    void writeRoom($).catch(ignore)
  })
}

/** このタブの猫を書き出す。中身が変わっていなければ書かない（動いている間は 1 分ごとに生存確認だけ書く） */
async function writeRoom($: Dollar, closing?: string) {
  const dir = await roomsDirOf($)
  if (!dir) return
  const t = await $.clock.now()
  const session = closing ?? (await $.session.id())
  const project = projectOf(await $.session.cwd())
  const room = closing
    ? snapshot(session, project, t, [], [], [], true)
    : snapshot(session, project, t, await read($, cats), await read($, links), await read($, asks))
  const key = session + contentKey(room)
  const busy = room.cats.some(cat => isActive(cat) || cat.trip)
  if (key === lastKey && !(busy && t - lastWriteAt >= HEARTBEAT_MS)) return
  await $.fs.write(roomFile(dir, session), JSON.stringify(room))
  lastKey = key
  lastWriteAt = t
}

// ---------------------------------------------------------------- 猫の記録

function upsert(list: Cat[], id: string, change: (cat: Cat) => Cat, create: () => Cat): Cat[] {
  if (!list.some(cat => cat.id === id)) return [...list, change(create())]
  return list.map(cat => (cat.id === id ? change(cat) : cat))
}

function ensureBoss(list: Cat[], t: number): Cat[] {
  return list.some(cat => cat.id === MAIN_ID) ? list : [newBoss(t), ...list]
}

function stray(id: string, list: Cat[], t: number): Cat {
  return {
    id,
    name: pickName(
      id,
      list.map(cat => cat.name),
    ),
    type: 'stray',
    description: '',
    status: 'running',
    startedAt: t,
    toolCount: 0,
    recent: [],
  }
}

/** 終わった猫がまた動き出したとき（メッセージで再開など） */
function wake(cat: Cat): Cat {
  return isEnded(cat) || cat.status === 'idle' ? withoutEnd({ ...cat, status: 'running' }) : cat
}

/** 子猫の結果を猫口調の 1 文に要約し、報告先にいる間ならしゃべらせる */
async function summarizeReport($: Dollar, id: string, answer: string) {
  const reply = await $.model.complete({
    model: 'haiku',
    system: SUMMARY_SYSTEM,
    prompt: answer.slice(0, 4000),
    maxTokens: 100,
    effort: 'low',
    timeoutMs: 15_000,
  })
  if (!reply.isAnswered) return
  const summary = cleanSummary(reply.text)
  if (!summary) return
  const t = await $.clock.now()
  await update($, cats, list =>
    list.map(cat => {
      if (cat.id !== id) return cat
      const withSummary = { ...cat, summary, summaryAt: t }
      const trip = cat.trip && advanceTrip(cat.trip, t)
      if (trip?.reason !== 'report') return withSummary
      // 着く前なら着いたときに、滞在中ならすぐに言う（部屋を出た後は記録だけ）
      if (trip.phase === 'leave' || trip.phase === 'arrive') {
        const arrival = trip.at + (trip.phase === 'leave' ? 2 : 1) * WALK_MS
        return speak(withSummary, summary, Math.max(t, arrival), SUMMARY_SAY_MS)
      }
      if (trip.phase === 'stay') return speak(withSummary, summary, t, SUMMARY_SAY_MS)
      return withSummary
    }),
  )
  await changed($)
}

/** 一連の作業が終わったら、ボスが子猫たちとこなしたことを 1 文にまとめてしゃべる */
async function summarizeTask($: Dollar, answer: string) {
  const list = await read($, cats)
  const boss = list.find(cat => cat.id === MAIN_ID)
  if (!boss) return
  const reply = await $.model.complete({
    model: 'haiku',
    system: BOSS_SUMMARY_SYSTEM,
    prompt: bossDigest(answer, taskKittens(list, boss)),
    maxTokens: 100,
    effort: 'low',
    timeoutMs: 15_000,
  })
  if (!reply.isAnswered) return
  const summary = cleanSummary(reply.text)
  if (!summary) return
  const t = await $.clock.now()
  await update($, cats, list =>
    list.map(cat => (cat.id === MAIN_ID ? speak({ ...cat, summary, summaryAt: t }, summary, t, SUMMARY_SAY_MS) : cat)),
  )
  await changed($)
}

/**
 * 質問を猫口調で解説する。答えを待たせないよう、タイマーから裏で動かす。
 * revisedFor は、回答待ちの間に報告が届いて作り直すときの子猫の名前（前の解説は出したまま考え直す）
 */
async function explainAsk($: Dollar, id: string, revisedFor?: string[]) {
  const run = (explainRuns.get(id) ?? 0) + 1
  explainRuns.set(id, run)
  const ask = (await read($, asks)).find(one => one.id === id)
  if (!ask) return
  if (revisedFor) {
    await update($, asks, list => updateAsk(list, id, one => ({ ...one, explain: 'pending', revisedFor })))
    await changed($)
  }
  const agentId = ask.catId === MAIN_ID ? undefined : ask.catId
  let context: ReturnType<typeof contextOf> = { lead: '', tools: [], prompts: [] }
  try {
    // 子猫の質問なら、その子猫の会話から拾う
    const found = agentId ? await $.session.messages({ agentId }) : await $.session.messages()
    if (Array.isArray(found)) context = contextOf(found)
  } catch {
    // 文脈が取れなくても、質問だけで解説する
  }
  // ボスへの指示はユーザーの入力。子猫への指示は親からの依頼（子猫の会話の最初）
  const recorded = agentId ? [] : await read($, prompts)
  const kittens = kittenDigest(helpersOf(await read($, cats), ask.catId), await read($, reports))
  const reply = await $.model.complete({
    model: 'haiku',
    system: EXPLAIN_SYSTEM,
    prompt: explainPrompt(
      ask.questions,
      recorded.length > 0 ? recorded : context.prompts,
      context.lead,
      context.tools,
      kittens,
    ),
    maxTokens: 1000,
    effort: 'low',
    timeoutMs: 30_000,
  })
  const explanation = reply.isAnswered ? cleanExplanation(reply.text) : ''
  if (explainRuns.get(id) !== run) return
  await update($, asks, list =>
    updateAsk(list, id, one => {
      if (explanation) return { ...one, explain: 'done', explanation }
      // 作り直しに失敗したら、前の解説を出したままにする
      return { ...one, explain: one.explanation ? 'done' : 'error' }
    }),
  )
  await changed($)
}

/** 回答待ちの質問を手伝っている子猫が終わったら、少し待ってから解説を作り直す */
async function reviseAsks($: Dollar, kittenId: string) {
  const list = await read($, cats)
  const name = list.find(cat => cat.id === kittenId)?.name
  if (!name) return
  for (const ask of await read($, asks)) {
    if (ask.status !== 'open' || ask.explain === 'off') continue
    if (!helpersOf(list, ask.catId).some(cat => cat.id === kittenId)) continue
    const waiting = revisions.get(ask.id)
    waiting?.timer.cancel()
    const names = [...new Set([...(waiting?.names ?? []), name])]
    const timer = $.clock.after(REVISE_DELAY_MS, () => {
      revisions.delete(ask.id)
      void (async () => {
        const still = (await read($, asks)).find(one => one.id === ask.id)
        if (still?.status === 'open') await explainAsk($, ask.id, names)
      })().catch(ignore)
    })
    revisions.set(ask.id, { timer, names })
  }
}

export const register: Register = (on, options) => {
  const summaryOn = options.summarize !== false
  const explainOn = options.explainQuestions !== false

  // ユーザーが自分で入力したプロンプトだけを、質問の解説の材料に覚えておく
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    fromUser = kind === 'composer' || kind === 'bridge' || kind === 'sdk'
    if (fromUser && e.text.trim()) {
      await update($, prompts, list => [...list, e.text.slice(0, 600)].slice(-PROMPTS_MAX)).catch(ignore)
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const t = await $.clock.now()
    const project = projectOf(e.cwd)
    await update($, cats, list => ensureBoss(list, t).map(cat => (cat.id === MAIN_ID ? { ...cat, project } : cat)))
    $.clock.after(0, () => void pruneRooms($).catch(ignore))
    // ホットリロードでタイマーが消えていたら回し直す
    await changed($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()
    // ホットリロードで prompt.submit の記録が消えていたら、入力があるかどうかで決める
    const fresh = e.text !== '' && (fromUser ?? true)
    fromUser = undefined
    await update($, cats, list =>
      upsert(
        list,
        MAIN_ID,
        // ユーザーの入力でないターン（子猫の完了通知を受けての続きなど）は、同じ作業の続きとみなす
        cat => ({
          ...withoutAsking(withoutEnd(withoutCurrent(cat))),
          status: 'running',
          startedAt: t,
          taskAt: fresh || cat.taskAt === undefined ? t : cat.taskAt,
        }),
        () => ({ ...newBoss(t), taskAt: t }),
      ),
    )
    await changed($)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (!spawned.agentId) return spawned
    const id = spawned.agentId
    const t = await $.clock.now()
    await update($, cats, list => {
      const isNew = !list.some(cat => cat.id === id)
      const out = upsert(
        list,
        id,
        // 先に tool.call から野良猫として出ていたら、正体がわかったので書き換える
        cat => ({
          ...withoutEnd(cat),
          type: e.subagentType,
          description: e.description,
          status: 'running',
          ...(e.parentAgentId ? { parentId: e.parentAgentId } : {}),
          ...(e.name ? { handle: e.name } : {}),
        }),
        () =>
          speak(
            {
              id,
              name: pickName(
                id,
                list.map(cat => cat.name),
              ),
              type: e.subagentType,
              description: e.description,
              status: 'running',
              startedAt: t,
              toolCount: 0,
              recent: [],
            },
            pickLine('spawn', id, t),
            t,
          ),
      )
      if (!isNew) return out
      // 依頼の受け渡し：親の部屋で依頼を受け取ってから自分の部屋へ歩いていく
      const created = out.find(cat => cat.id === id)
      if (!created) return out
      return startTrip(out, id, parentOf(created, new Set(out.map(cat => cat.id))), 'handoff', t, {
        phase: 'stay',
        stayMs: HANDOFF_STAY_MS,
      })
    })
    // 引き継ぎ：前の起動より後に完了した兄弟から、新しい子猫へ点線を引く
    const after = await read($, cats)
    const child = after.find(cat => cat.id === id)
    if (child) {
      const parent = parentOf(child, new Set(after.map(cat => cat.id)))
      const batons = batonsFor(after, parent, id)
      if (batons.length > 0) {
        await update($, links, list =>
          batons.reduce((acc, from) => addLink(acc, { from, to: id, kind: 'baton' }), list),
        )
      }
    }
    await changed($)

    return spawned
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN_ID
    const args = e as unknown as ToolArgs
    // Grep・Glob はビルドに無いことがあるので、ツール名は文字列として比べる
    const tool: string = e.tool
    const summary = summarize(args)
    const t = await $.clock.now()
    const readPath = tool === 'Read' ? str(args.file_path) : undefined
    const writer = readPath ? (await read($, files))[readPath] : undefined
    const found: { from: string; to: string; kind: 'review' | 'letter' }[] = []
    await update($, cats, list => {
      let out = upsert(
        list,
        id,
        cat => ({
          ...wake(cat),
          toolCount: cat.toolCount + 1,
          current: summary,
          currentId: e.tool_use_id,
          activeAt: t,
        }),
        () => (id === MAIN_ID ? { ...newBoss(t), status: 'running' } : stray(id, list, t)),
      )
      // レビュー：ほかの猫が書いたファイルを読むあいだ、その猫の部屋へ行く
      found.length = 0
      if (writer && writer !== id && out.some(cat => cat.id === writer)) {
        const before = out.find(cat => cat.id === id)?.trip
        out = startTrip(out, id, writer, 'review', t, { holdId: e.tool_use_id })
        if (!before) out = out.map(cat => (cat.id === id ? speak(cat, pickLine('review', id, t), t) : cat))
        found.push({ from: writer, to: id, kind: 'review' })
      }
      // お手紙：宛先の猫の部屋へ届けに行く
      if (tool === 'SendMessage') {
        const to = resolveTarget(out, str(args.to) ?? '')
        if (to && to !== id) {
          out = startTrip(out, id, to, 'letter', t)
          out = out.map(cat => (cat.id === id ? speak(cat, pickLine('letter', id, t), t) : cat))
          found.push({ from: id, to, kind: 'letter' })
        }
      }
      return out
    })
    if (found.length > 0) await update($, links, list => found.reduce(addLink, list))
    // 裏で動いた子猫は、最後の報告を SubagentHandback の message で親に渡す（turn.complete の answer は空になる）
    const handback = tool === 'SubagentHandback' && e.agentId ? str(args.message) : undefined
    if (e.agentId && handback) {
      const kittenId = e.agentId
      await update($, reports, map => rememberReport(map, kittenId, handback))
    }
    await changed($)
    let result: Awaited<ReturnType<typeof next>> | undefined
    try {
      result = await next(e)
      return result
    } finally {
      const path = writtenPath(args)
      if (path && result && !result.deny && !('isError' in result && result.isError)) {
        await update($, files, map => ({ ...map, [path]: id }))
      }
      const end = await $.clock.now()
      await update($, cats, list =>
        list.map(cat => {
          if (cat.id !== id) return cat
          const recent = [summary, ...cat.recent].slice(0, RECENT_MAX)
          // 並列で呼んだほかのツールが current を上書きしていたら消さない
          const done = cat.currentId === e.tool_use_id ? { ...withoutCurrent(cat), recent } : { ...cat, recent }
          // 質問を答えずに閉じたのは失敗ではない（質問の hook が黙らせる）
          const failed =
            tool !== 'AskUserQuestion' && result !== undefined && 'isError' in result && result.isError === true
          // 許可を待っていたなら、許可・拒否のどちらでもここで終わっている
          const answered = withoutAsking(done)
          return releaseHold(failed ? speak(answered, pickLine('error', id, end), end) : answered, e.tool_use_id, end)
        }),
      )
      await changed($)
    }
  })

  // 質問：質問した猫が「聞きたいニャ」としゃべり、質問と解説と答えを部屋に残す（ビューアが吹き出しに出す）
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const catId = e.agentId ?? MAIN_ID
    const t = await $.clock.now()
    const id = e.tool_use_id
    const ask: Ask = {
      id,
      catId,
      askedAt: t,
      questions: toQuestions(e.questions),
      status: 'open',
      answers: {},
      explain: explainOn ? 'pending' : 'off',
    }
    await update($, asks, list => addAsk(list, ask))
    // 「聞きたいニャ」は答えるまで出し続け、答えたら復唱に、答えずに閉じたら黙る
    const asking = pickLine('question', catId, t)
    const settle = (line: string | undefined, at: number) =>
      update($, cats, list =>
        list.map(cat => {
          if (cat.id !== catId) return cat
          if (line) return speak(cat, line, at)
          return cat.say?.text === asking ? withoutSay(cat) : cat
        }),
      )
    await update($, cats, list => list.map(cat => (cat.id === catId ? speak(cat, asking, t, ASK_SAY_MS) : cat)))
    await changed($)
    if (explainOn) {
      $.clock.after(
        0,
        () =>
          void explainAsk($, id).catch(() =>
            update($, asks, list => updateAsk(list, id, one => ({ ...one, explain: 'error' })))
              .then(() => changed($))
              .catch(ignore),
          ),
      )
    }

    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (error) {
      // 中断で答えが来なくても、回答待ちのまま残さない
      await update($, asks, list => updateAsk(list, id, one => ({ ...one, status: 'cancelled' }))).catch(ignore)
      await settle(undefined, t).catch(ignore)
      publishSoon($)
      throw error
    }
    const answers = ran.deny === undefined && !ran.isError ? answersOf(ran.result) : undefined
    const end = await $.clock.now()
    const done = await update($, asks, list =>
      updateAsk(list, id, one => (answers ? { ...one, status: 'answered', answers } : { ...one, status: 'cancelled' })),
    )
    // 答えをもらったら、選んだものを復唱する
    const answered = done.find(one => one.id === id)
    await settle(answered && answers ? answeredLine(answered) : undefined, end)
    await changed($)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const t = await $.clock.now()
    const spent = e.usage ? totalTokens(e.usage) : 0
    await update($, cats, list => {
      const ids = new Set(list.map(cat => cat.id))
      let out = list.map((cat): Cat => {
        if (cat.id !== (e.agentId ?? MAIN_ID)) return cat
        const tokens = (cat.tokens ?? 0) + spent
        const settled = withoutAsking(withoutCurrent(cat))
        if (!e.agentId) return { ...settled, status: 'idle', endedAt: t, tokens }
        const status = e.reason === 'aborted' ? 'killed' : e.reason === 'answer' ? 'completed' : 'failed'
        return { ...settled, status, endedAt: t, tokens }
      })
      // 報告：終わった子猫が親の部屋へ報告に行く（中断はしない）
      const done = e.agentId ? out.find(cat => cat.id === e.agentId) : undefined
      if (done && e.reason !== 'aborted') {
        const parent = parentOf(done, ids)
        out = startTrip(out, done.id, parent, 'report', t)
        const reporting = out.find(cat => cat.id === done.id)?.trip?.reason === 'report'
        const parentName = out.find(cat => cat.id === parent)?.name
        out = out.map(cat => {
          if (cat.id !== done.id) return cat
          // うまくいった子猫は歩きながら「ボスへ報告ニャ！」などと言い、着いて少しするまで言い続ける（要約が届けば着いたときに替わる）
          if (reporting && parentName && e.reason === 'answer') {
            return speak(cat, pickLine('report', done.id, t).replace('{to}', parentName), t, 2 * WALK_MS + SAY_MS)
          }
          // それ以外は報告先に着いたころにしゃべる
          const line = pickLine(e.reason === 'answer' ? 'done' : 'failed', done.id, t)
          return speak(cat, line, reporting ? t + 2 * WALK_MS : t)
        })
      }
      return out
    })
    await changed($)
    // 結果の要約は時間がかかるので、ターンの終わりを待たせずタイマーから裏で動かす
    const agentId = e.agentId
    // 裏で動いた子猫は e.answer が空で届く（報告は SubagentHandback で渡していて、tool.call で覚えてある）
    const handedBack = agentId ? (await read($, reports))[agentId] : undefined
    const answer = e.answer.trim() || (e.reason === 'answer' ? (handedBack ?? '') : '')
    // 結果の本文は質問の解説の材料に覚えておき、回答待ちの質問があれば解説を作り直す
    if (agentId && e.reason === 'answer' && answer && answer !== handedBack) {
      await update($, reports, map => rememberReport(map, agentId, answer))
    }
    if (explainOn && agentId && e.reason !== 'aborted') await reviseAsks($, agentId)
    if (summaryOn && agentId && e.reason === 'answer' && answer) {
      $.clock.after(0, () => void summarizeReport($, agentId, answer).catch(ignore))
    }
    // ボスのターンの終わり：子猫を使った作業がひと区切りついていたら、まとめる
    if (summaryOn && !agentId && e.reason === 'answer' && !bossSummarizing) {
      const list = await read($, cats)
      const boss = list.find(cat => cat.id === MAIN_ID)
      if (boss && needsBossSummary(boss, taskKittens(list, boss))) {
        bossSummarizing = true
        $.clock.after(
          0,
          () =>
            void summarizeTask($, answer)
              .catch(ignore)
              .finally(() => {
                bossSummarizing = false
              }),
        )
      }
    }

    return next(e)
  })

  // 許可ダイアログが出る直前。どの猫が許可を待っているかを覚えて、しゃべらせる
  on('classic.PermissionRequest', async ($, e, next) => {
    // 質問のダイアログは許可待ちではない（質問として別に扱う）
    if (e.tool_name === 'AskUserQuestion') return next(e)
    const id = e.agent_id ?? MAIN_ID
    const t = await $.clock.now()
    await update($, cats, list =>
      list.map(cat => (cat.id === id ? speak({ ...cat, asking: e.tool_name }, pickLine('asking', id, t), t) : cat)),
    )
    await changed($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // ビューアから、このタブの猫を下げてもらう
    await writeRoom($, e.sessionId).catch(ignore)
    if (e.reason === 'clear') {
      stopTicking()
      const t = await $.clock.now()
      await update($, cats, () => [newBoss(t)])
      await update($, files, () => ({}))
      await update($, links, () => [])
      await update($, asks, () => [])
      await update($, prompts, () => [])
      await update($, reports, () => ({}))
      for (const waiting of revisions.values()) waiting.timer.cancel()
      revisions.clear()
      // /clear の後は新しいセッション id で、まっさらな部屋を書き出し直す
      await changed($)
    }

    return next(e)
  })
}
