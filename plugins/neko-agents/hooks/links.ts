// 猫どうしの点線のつながり（引き継ぎ・レビュー・お手紙）の記録。$ に触らない純粋なロジック。
import type { Cat, Link } from '../types'
import { isBoss, parentOf } from './cats'

const LINKS_MAX = 200

export function addLink(links: readonly Link[], link: Link): Link[] {
  if (link.from === link.to) return [...links]
  if (links.some(one => one.from === link.from && one.to === link.to)) return [...links]
  return [...links, link].slice(-LINKS_MAX)
}

/**
 * 引き継ぎ：親が新しい子猫を起動したとき、その前の起動より後に完了した兄弟は、
 * 結果を新しい子猫に渡したとみなす
 */
export function batonsFor(cats: readonly Cat[], parent: string, child: string): string[] {
  const ids = new Set(cats.map(cat => cat.id))
  const siblings = cats.filter(cat => cat.id !== child && !isBoss(cat) && parentOf(cat, ids) === parent)
  if (siblings.length === 0) return []
  const lastSpawn = Math.max(...siblings.map(cat => cat.startedAt))
  return siblings.filter(cat => cat.status === 'completed' && (cat.endedAt ?? 0) >= lastSpawn).map(cat => cat.id)
}
