// @ts-check
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/', 'plugins/*/.claude-plugin/types/'] },
  js.configs.recommended,
  // 型情報を使う、いちばん厳しい組み合わせ
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      // ファイルごとに一番近い tsconfig.json（tools/ や plugins/<mod>/）の型情報を使う
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      // 使っていない値は、頭に _ を付ければ見逃す（分割代入でフィールドを落とすときなど）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      // テンプレート文字列に数値を入れるのは許す（`${n} tools` など）
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // オブジェクトの型は type で書く（interface は、型を足し合わせる必要がある所だけ）
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  {
    // テストでは「ここには必ずある」と分かっている値を ! で取り出すことが多いので許す
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // 設定ファイルなどの JavaScript は型情報なしで見る
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // 見た目は Prettier に任せる
  prettier,
)
