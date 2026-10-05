#!/bin/sh
# ビューア（neko-room）を本物のターミナルに近い形で起動して、猫を描いてから q で終われるかを確かめる。
# 実際の ~/.claude には触れない（一時ディレクトリを HOME にして、見本の部屋を 1 つだけ置く）。
set -eu
cd "$(git rev-parse --show-toplevel)"

home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT INT TERM

# 見本の部屋は Mod のコードで作る（Room の形が変わっても追従する）
HOME="$home" bun -e '
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { newBoss } from "./plugins/neko-agents/hooks/cats"
import { ROOMS_DIR } from "./plugins/neko-agents/hooks/rooms"
const now = Date.now()
const dir = join(homedir(), ROOMS_DIR)
mkdirSync(dir, { recursive: true })
const boss = { ...newBoss(now), status: "running" }
const kitten = { ...newBoss(now), id: "k1", name: "ソラ", type: "Explore", description: "見本", status: "running", endedAt: undefined }
writeFileSync(join(dir, "smoke.json"), JSON.stringify({ session: "smoke", project: "smoke-project", updatedAt: now, cats: [boss, kitten], links: [] }))
'

# script(1) で疑似ターミナルを用意し、1 秒描かせてから q を送る（util-linux と BSD/macOS で書き方が違う）
viewer() {
  if script --version >/dev/null 2>&1; then
    script -qec 'bun tools/neko-room/room.ts' /dev/null
  else
    script -q /dev/null bun tools/neko-room/room.ts
  fi
}
out=$( (sleep 1; printf q) | HOME="$home" viewer 2>&1 ) && code=0 || code=$?

fail() { echo "NG: $1"; printf '%s\n' "$out" | tail -20; exit 1; }
[ "$code" -eq 0 ] || fail "終了コードが $code"
printf '%s' "$out" | grep -q 'ボス' || fail "ボスが描かれていない"
printf '%s' "$out" | grep -q 'ソラ' || fail "子猫が描かれていない"
printf '%s' "$out" | grep -q 'まだ猫がいません' && fail "見本の部屋が読めていない（Room の形と合っていない？）"
echo "OK: neko-room が見本の部屋を描いて、q で終了した"
