// 文字の格子（Run）を、ターミナルに書ける色付きの文字列にする。
import type { Run, Style } from './graph'

const ESC = '\x1b['

/** '#e0913a' → 24bit カラーの前景色 */
function foreground(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return ''
  const [, r = '0', g = '0', b = '0'] = m
  return `${ESC}38;2;${parseInt(r, 16)};${parseInt(g, 16)};${parseInt(b, 16)}m`
}

export function paint(text: string, style: Style = {}): string {
  const codes = [
    style.bold ? `${ESC}1m` : '',
    style.dim ? `${ESC}2m` : '',
    style.color ? foreground(style.color) : '',
  ].join('')
  return codes ? `${codes}${text}${ESC}0m` : text
}

export function toAnsi(runs: readonly Run[]): string {
  return runs.map(run => paint(run.text, run.style)).join('')
}

/** 色の指定を取り除く（テスト用） */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- 端末の制御文字（ESC）を取り除くのが目的
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}
