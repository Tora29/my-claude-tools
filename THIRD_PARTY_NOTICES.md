# Third-party notices

このリポジトリには、ほかのプロジェクトのコードや文章を元にした部分があります。元のライセンスの条件に従い、著作権表示と許諾文をここに載せます。

## qa-guide（aieo-product/claude_qamods）

- 元: https://github.com/aieo-product/claude_qamods （`plugins/qa-guide/hooks/register.tsx`）
- 使った場所: `plugins/neko-agents/hooks/questions.ts`
  - 複数選択の回答を分ける処理（`splitAnswers`）
  - 質問の解説の構成と指示文（いまの指示・なぜ聞いているか・選択肢ごとの影響・おすすめ。猫口調に書き直し）
  - 解説の材料の集め方（直前の Claude の説明・最後の指示以降のツール操作・全体の長さの上限）

```text
MIT License

Copyright (c) 2026 aieo-product

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
