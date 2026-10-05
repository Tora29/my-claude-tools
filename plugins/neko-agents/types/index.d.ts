/** エージェントの状態。claude-code の AgentStatus と同じ値 */
export type CatStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/** よその部屋へ行く理由。review: ファイルを読みに / letter: SendMessage / report: 完了の報告 / handoff: 依頼の受け取り */
export type TripReason = 'review' | 'letter' | 'report' | 'handoff'

/**
 * 移動の段階。leave: 自分の部屋から出ていく → arrive: 相手の部屋に入る → stay: 滞在
 * → depart: 相手の部屋から出ていく → return: 自分の部屋に戻る
 */
export type TripPhase = 'leave' | 'arrive' | 'stay' | 'depart' | 'return'

export type Trip = {
  /** 行き先の猫の id */
  to: string
  reason: TripReason
  phase: TripPhase
  /** 今の段階が始まった時刻 */
  at: number
  /** この tool_use_id のツールが終わるまで滞在を続ける（review の Read 中） */
  holdId?: string
  /** 滞在の長さ。省略すると既定の長さ */
  stayMs?: number
}

/** ねこ部屋にいる猫 1 匹 = エージェント 1 つ */
export type Cat = {
  /** agentId。メインは 'main' */
  id: string
  name: string
  /** SendMessage の宛先に使われる名前（Agent({ name }) など） */
  handle?: string
  /** subagentType（Explore など）。メインは 'main'、野良猫は 'stray' */
  type: string
  description: string
  parentId?: string
  status: CatStatus
  startedAt: number
  endedAt?: number
  /** 最後にツールを呼んだ時刻。野良猫が寝たかどうかの判定に使う */
  activeAt?: number
  toolCount: number
  /** 実行中のツールの要約 */
  current?: string
  /** current を出したツール呼び出しの tool_use_id */
  currentId?: string
  /** 直近の操作。新しい順に 20 件まで */
  recent: string[]
  tokens?: number
  /** よその部屋へのお出かけ */
  trip?: Trip
  /** 吹き出し。from から until まで箱の 3 行目に出す */
  say?: Speech
  /** 許可を待っているツールの名前 */
  asking?: string
  /** 終わったときの結果を猫口調で要約した 1 文。ボスは、子猫たちと一緒にこなした作業のまとめ */
  summary?: string
  /** summary を付けた時刻 */
  summaryAt?: number
  /** ボスだけ：今の作業（ユーザーが入力したターン）が始まった時刻。続きのターンでは変わらない */
  taskAt?: number
  /** ほかのタブの猫なら、そのタブのセッション id（自分のタブの猫には無い） */
  room?: string
  /** ボスだけ：そのタブの作業フォルダ名 */
  project?: string
}

/** 各タブが書き出す、自分のねこ部屋の中身 */
export type Room = {
  session: string
  project: string
  updatedAt: number
  /** タブを閉じた・/clear した */
  closed?: boolean
  cats: Cat[]
  links: Link[]
  /** 猫がユーザーにした質問（AskUserQuestion）。古い順 */
  asks?: Ask[]
}

/** AskUserQuestion の質問 1 つ */
export type Question = {
  question: string
  header?: string
  multiSelect: boolean
  options: { label: string; description?: string }[]
}

/**
 * AskUserQuestion 1 回分。猫が質問して、ユーザーが答えるまで
 * open: 回答待ち / answered: 答えた / cancelled: 答えずに閉じた・中断した
 */
export type Ask = {
  /** tool_use_id */
  id: string
  /** 質問した猫の id */
  catId: string
  askedAt: number
  questions: Question[]
  status: 'open' | 'answered' | 'cancelled'
  /** 質問文 → 回答（複数選択はカンマ区切り）。選ばずに書いた答えは FREEFORM のキー */
  answers: Record<string, string>
  /** 質問の解説を猫口調で（haiku）。off: 解説しない設定 */
  explain: 'pending' | 'done' | 'error' | 'off'
  explanation?: string
  /** 回答待ちの間に報告が届いて、解説を作り直したときの子猫の名前 */
  revisedFor?: string[]
}

export type Speech = { text: string; from: number; until: number }

/** 点線でつなぐ関係。review: 書いた猫 → 読んだ猫 / letter: 送った猫 → 宛先 / baton: 完了した兄弟 → 次に起動された猫 */
export type LinkKind = 'review' | 'letter' | 'baton'

export type Link = { from: string; to: string; kind: LinkKind }

declare module 'claude-code' {
  // claude-code の PluginState に足し合わせる（宣言のマージ）ので、ここだけは interface でないといけない
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface PluginState {
    'neko-agents': {
      cats: Cat[]
      /** ファイルのパス → 最後に書いた猫の id（review の判定に使う） */
      files: Record<string, string>
      /** 猫どうしの点線のつながり */
      links: Link[]
      /** 猫がユーザーにした質問。古い順に ASKS_MAX 件まで */
      asks: Ask[]
      /** ユーザーが入力した最近のプロンプト。質問の解説の材料にする */
      prompts: string[]
      /** 子猫の id → 終わったときの結果の本文（先頭だけ）。質問の解説の材料にする。部屋のファイルには書かない */
      reports: Record<string, string>
    }
  }
}
