# Git・Pull Request ルール

このRepositoryは公開Repositoryで、マージ済みPRはポートフォリオ（`Tora29/my-portfolio`）の Works に紐付けると、Activityとして公開される（my-portfolio の `.users/design/activity-pipeline.md`）。PRのタイトルと本文は、閲覧者（採用担当・エンジニア）が読む前提で書く。

## ブランチ

- main へ直接コミットしない。作業はブランチを切ってPRでマージする
- ブランチ名：`<type>/<短い説明>`（例：`feat/neko-speech`、`fix/room-scroll`）

## コミットメッセージ

Conventional Commits形式で書く。

```text
<type>(<scope>): <内容>
```

| type       | 用途                                  |
| ---------- | ------------------------------------- |
| feat       | 機能の追加                            |
| fix        | 不具合の修正                          |
| perf       | 性能の改善                            |
| refactor   | 挙動を変えない改善                    |
| docs       | ドキュメント（README 等）の追加や修正 |
| style      | 見た目に影響しないコード整形          |
| test       | テストの追加・修正                    |
| build / ci | ビルド設定・ワークフロー              |
| chore      | 上記以外の雑務（依存関係の更新など）  |

- scope は Mod・ツールの名前（`plugins/` と `tools/` のフォルダ名。`neko-agents` / `neko-room` 等）。マーケットプレイスの設定（`.claude-plugin/marketplace.json`）は `marketplace`、Repository全体の設定・ルール（lint・tsconfig・`.claude/` 等）は `repo`
- 内容は日本語で簡潔に書く

## Pull Request

### マージ前の確認

- `bun run check`（型チェック・lint・format・validate・テスト）を通す
- Mod の挙動を変えたときは、`plugins/<mod>/.claude-plugin/plugin.json` の `version` を上げる（`claude plugin install` 済みの利用者に更新を届けるため）

### タイトル

コミットメッセージと同じ形式にし、`: ` の後ろを**閲覧者が読んで分かる日本語**で書く。この部分がActivityの見出しになる。

```text
○ feat(neko-agents): 許可待ちの猫が赤く点滅するようにした
○ fix(neko-room): 図がはみ出したときにスクロールできない問題を修正
× feat(neko-agents): rooms.ts に writeRoom を追加      # 実装の言葉になっている
× fix: いろいろ修正                                    # 何をしたか分からない
```

### 本文

最初の段落がActivityの要約になる。何を変えて、利用者・閲覧者にとって何が良くなったかを1〜2文で書く。

```markdown
子猫が終わったときの報告を、haiku で猫口調の1文に要約して見せるようにした。

## 変更内容

- …

## 確認方法

- …
```

- 最初の段落に、実装の詳細・作業メモ・チェックリストを書かない（見出し以降に書く）
- 公開してよい情報のみを書く。個人情報、業務の顧客名・案件名・社内システム名、所属企業名、ローカル環境の絶対パスやセッションid・トークンなどを書かない（スクリーンショットやログを貼るときも同様）

### ラベル

| ラベル          | 意味                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tech:<id>`     | ActivityのTechを指定する（my-portfolio の `data/tech.yml` の id。例：`tech:claude-code`、`tech:typescript`）。付けない場合は作品のTechを引き継ぐ |
| `activity:skip` | Activityに載せない（type が feat / fix 等でも除外する）                                                                                          |

- chore / ci / build / test / style のPRは自動で除外されるため、`activity:skip` は不要
- 公開済みのActivityを直す・取り下げるときは、my-portfolio 側の確認用PR（`bot/activity`）で行う。このRepositoryでは扱わない
