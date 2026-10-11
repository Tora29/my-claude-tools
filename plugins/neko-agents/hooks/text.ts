// 部屋に入る文字列から、ターミナルを操作できてしまう文字を取り除く。$ に触らない純粋なロジック。
// ファイル名・コマンド・検索語・質問・要約などはエージェントやリポジトリの中身から来るので、
// ESC（色・画面消去・OSC 52 のクリップボード書き込み等）や BEL がそのままビューアの画面に届かないようにする。

/** 改行と、改行以外の空白にする制御文字 */
const LF = 0x0a
const SPACES = new Set([0x09, 0x0b, 0x0c, 0x0d])

/** 取り除く文字か。C0 制御文字（改行・空白にするものを除く）・DEL・C1 制御文字・双方向テキストの上書き */
function isUnsafe(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
}

/**
 * 制御文字を取り除く。改行（\r\n・\r も）は解説の行分けに使うので \n として残し、
 * タブなどは空白にする（空白をまとめるのは表示する側）
 */
export function cleanText(text: string): string {
  let out = ''
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i)
    if (!isUnsafe(cp) || cp === LF) continue
    out += text.slice(start, i)
    start = i + 1
    if (cp === 0x0d) {
      out += '\n'
      if (text.charCodeAt(i + 1) === LF) {
        i++
        start = i + 1
      }
    } else if (SPACES.has(cp)) out += ' '
  }
  return start === 0 ? text : out + text.slice(start)
}

/** JSON から読んだ値の中の文字列を、全部 cleanText する */
export function cleanDeep(value: unknown): unknown {
  if (typeof value === 'string') return cleanText(value)
  if (Array.isArray(value)) return value.map(cleanDeep)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanDeep(item)]))
  }
  return value
}
