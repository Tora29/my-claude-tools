---
name: verify-app
description: my-claude-tools の変更が壊れていないかを確かめる（型チェック・lint・Prettier・plugin validate・テスト・ビューアの起動確認・Mod の version）。コードを変更した後、コミットや PR の前、「動作確認して」「検証して」「check 通して」と言われたときに使う。
---

# verify-app

変更が壊れていないことを、下の順に確かめて結果を報告する。途中で失敗したら、直してから最初からやり直す。

ビルドの手順はない。ビューアは `bun` が TypeScript をそのまま実行し、Mod は Claude Code が `.ts` をそのまま読み込むため。ビルドで見つかるはずの誤りは、1 の型チェックで見つける。

## 1. まとめてチェックする

```sh
bun run check
```

次を順に実行し、最初に失敗したところで止まる（10 秒ほど）。

| script         | 内容                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `typecheck`    | `tools/` と `plugins/*/` の型チェック（`tsc`）                           |
| `lint`         | ESLint（型情報を使う strict な設定）                                     |
| `format:check` | Prettier                                                                 |
| `validate`     | マーケットプレイスと全 Mod の `claude plugin validate`                   |
| `test`         | `bun test tools`（ビューア）と、全 Mod の `claude plugin test`（フック） |

- `format:check` だけが失敗したら `bun run format` で整形して、もう一度 `bun run check` する
- lint の指摘は、ルールを無効にする（`eslint-disable` 等）のではなくコードを直す。どうしても必要なときは理由をユーザーに伝えて判断を仰ぐ
- Mod の型チェックが「型定義が見つからない」で失敗するときは、`plugins/<mod>/.claude-plugin/types/` がまだ生成されていない。一度 `claude --plugin-dir ./plugins/<mod>` で読み込むと生成される（ユーザーに頼む）
- テストを消したり `skip` にしたりして通さない

## 2. ビューアを起動してみる

```sh
.claude/skills/verify-app/smoke.sh
```

一時ディレクトリを HOME にして見本の部屋を 1 つ置き、疑似ターミナルで `tools/neko-room/room.ts` を起動する。猫を描いてから `q` で正常に終了できるかを見る（1 秒ほど）。単体テストでは通らない、起動・キー入力・終了の流れを確かめるためのもの。

- `OK:` で終われば成功。`NG:` のときは、理由と画面の最後の部分が出る
- 実際の `~/.claude/neko-agents/rooms/` には触れない。手元の部屋のファイルには、ほかのプロジェクト名や作業内容が入っているので、確認のために読んだ場合も、その中身を PR・コミット・Issue に書かない

## 3. Mod の version を確かめる

`plugins/<mod>/` の下を main から変更したのに `plugin.json` の `version` が上がっていなければ、上げるようユーザーに伝える（`claude plugin install` 済みの利用者に更新が届かないため。`.claude/rules/git-workflow.md`）。テストや README だけの変更なら不要。

```sh
git diff --stat main -- plugins/
git diff main -- 'plugins/*/.claude-plugin/plugin.json'
```

## 4. 自動では確かめられないこと

Mod が実際の Claude Code の中で正しく動くか（猫の状態が変わる・部屋のファイルが書き出される）は、上の手順では確かめきれない。`plugins/*/hooks/` を変更したときは、確認していないことを報告に書き、次の手順での確認をユーザーに頼む。

```sh
claude --plugin-dir ./plugins/neko-agents   # 別のタブで neko-room を開き、猫が動くかを見る
```

## 報告

手順ごとに、通ったか・失敗して何を直したか・実行しなかったかを短く書く。

```text
- bun run check：OK（テスト 37 件）
- ビューアの起動：OK
- version：neko-agents の hooks を変更したので 0.1.0 → 0.1.1 が必要（未対応）
- 実機での確認：未実施（hooks を変更したため、claude --plugin-dir での確認をお願いします）
```
