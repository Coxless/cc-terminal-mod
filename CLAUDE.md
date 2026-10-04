# Claude Code Terminal Mod

Claude Code を終了せずに、その場で Terminal Pane を開いて操作し、選択したテキストだけを Claude に渡せるようにする Mod。

- 要件の正: `concept-mvp.md`
- 構成と、実機で確認した API の挙動の正: `docs/architecture.md`
- 実装計画(ステップと完了条件)の正: `docs/implementation-plan.md`

## 現在の状態

- Phase 0(Feasibility Spike)は完了。判定は Go。
- 開発環境(Workshop + Bun 1.4.2)は用意済み。`bun build --compile` のバイナリがホストでも動くことだけ確認した。
- 次の作業は Phase 1(Terminal Only)。最初のステップは Bun の PTY + `@xterm/headless` の確認(`docs/implementation-plan.md` の Phase 1 Step 1 の残り)。
- Mod 本体はまだ無い。`mod/` に作る。`spike/phase0/` は Phase 0 の PoC(Python sidecar)で、参照用。流用せず作り直す。
- git は初期化済み(ブランチ `main`)。コミットはまだ無い。

## 決まっていること

- 統合境界は公式 Mods API のみ。Claude Code の private implementation の patch、内部 Context 構造の直接書き換え、非公開 IPC は使わない。
- PTY と VT エミュレーションは sidecar プロセスが持つ。hooks モジュールは画面の状態を持たない。
- sidecar は TypeScript + Bun。PTY は Bun 組み込み、VT エミュレータは `@xterm/headless`。`bun build --compile` で単一バイナリにして Mod に同梱する。Bun の PTY が要件を満たさなければ Node.js + `node-pty` に切り替える。
- hooks モジュールと sidecar の通信は Unix ソケット上の HTTP(`$.http.fetch` の `socketPath`)。出力は long-poll。
- 画面は hooks モジュールが `Text` 行で描く。キーは 1 行の `Client` で受ける。
- Escape / Ctrl+C / Ctrl+D / Ctrl+Z / Ctrl+X は Mod に届かないので、代替キーで送る。当面の割り当ては `ctrl+]` = Escape、`alt+c` / `alt+d` / `alt+z` / `alt+x` = Ctrl+C / D / Z / X。
- Claude への受け渡しは `$.session.append`。
- Terminal の内容を Claude に自動で渡さない。渡すのは人間が選択して明示的に操作したときだけ。Mod は選択テキストを解釈・要約・実行しない。
- Terminal 側の失敗で Claude Code のセッションを落とさない。
- MVP の Non-goals(`concept-mvp.md` §2)を実装しない: 複数 Terminal、タブ、履歴永続化、Claude による Terminal 自動操作など。
- 公式 API で実現できないことは、回避策を積む前に「技術的制約」として `docs/architecture.md` に記録する。

## Mods API の参照先

API は early access でリリースごとに変わる。記憶や本ファイルより、下の一次情報を優先する。

- 型定義(そのビルドの正): Mod がロードされた後の `<mod>/.claude-plugin/types/claude-code/index.d.ts`。約 2 万行あるので、名前で grep して宣言を読む。
- `plugin-authoring` skill: hooks モジュールを書く・デバッグする前に必ずロードする。
- 公式 Docs: https://code.claude.com/docs/ja/plugins/mods/ 配下の `overview` / `create` / `interface` / `events` / `api` / `test` / `troubleshoot` / `reference`
- 組み込み mod のソース(`/diff` ペインがキーバインドとスクロールの実例): https://github.com/anthropics/claude-code/tree/main/mods

Mods は Claude Code v2.1.287 以降が必要。Phase 0 の検証環境は v2.1.289。

## 構成と開発コマンド

```text
mod/
├── .claude-plugin/plugin.json   # name: "terminal", version, description
├── hooks/hooks.json             # { "modules": ["./register.tsx"] }
├── hooks/register.tsx           # hooks モジュール。export const register: Register = on => { ... }
├── hooks/keys.tsx               # Client の surface モジュール(キー入力)
├── shared/                      # hooks と sidecar が共有する型と純関数($ に触れない)
├── sidecar/                     # Bun のソース(PTY、@xterm/headless、HTTP サーバ)
└── bin/                         # コンパイル済みの sidecar バイナリ
```

開発環境は [Canonical Workshop](https://ubuntu.com/workshop/docs/)(LXD のシステムコンテナ)。定義は `.workshop/dev.yaml`。Bun は Store に SDK が無いので、プロジェクト内 SDK(`.workshop/bun/`)で入れている。バージョンは `.workshop/bun/hooks/setup-base` の `BUN_VERSION`。

Bun はワークショップの中だけにある。Claude Code はホストだけにある。プロジェクトは中で `/project` にマウントされ、`node_modules/` とビルド結果はホストと共有される。中でコンパイルした sidecar バイナリは、そのままホストで動く。

ホストで実行するもの:

```bash
claude --plugin-dir ./mod           # そのセッションだけロード。保存でホットリロード
claude --debug --plugin-dir ./mod   # 拒否された hook / tree の理由をログに出す
claude plugin validate ./mod        # マニフェストと hooks / calls の検証
claude plugin test ./mod            # *.test.ts を実行
```

ワークショップで実行するもの(ホストから `workshop` 経由で呼ぶ):

```bash
workshop launch                     # 初回だけ。環境を作って起動する
workshop start                      # 停止していたら再開する(ホストの再起動後など)
workshop run -- setup               # bun install
workshop run -- test                # bun test(引数はそのまま渡る)
workshop run -- lint                # bunx tsc -p ./mod --noEmit(ロード後に tsconfig が配置される)
workshop run -- fmt                 # bunx prettier --write mod
workshop exec -- bun <args>         # その場限りのコマンド
workshop shell                      # 中に入る
workshop refresh                    # dev.yaml の base / sdks、SDK の hooks を変えた後
```

依存は、ルートの `package.json` に置く(`@xterm/headless`、`typescript`、`@types/bun`、`prettier`)。`mod/` の中に `node_modules/` を作らない。

sidecar のビルドコマンド(`bun build --compile` の入出力)は Step 1 で決めて、ここに追記する。

スパイクは `claude --plugin-dir ./spike/phase0` で動く(`python3` が必要)。コマンドは `docs/architecture.md` の末尾。

## hooks モジュールを書くときの制約

Phase 0 で実機確認したもの。根拠と数値は `docs/architecture.md`。

### 実行環境

- hooks モジュールには DOM も Node.js API も無い。外部に届く手段は `$` だけ。
- `import()` を含むモジュールはロードされない。プラグイン内のファイルは静的 `import` で読む。
- **`$` は変数に保存も、関数に渡すこともできない**(`claude plugin validate` が拒否する)。dispatch をまたぐ処理は、`session.start` の `$` を閉じ込めたクロージャの束(`{ fetch: (u, i) => $.http.fetch(u, i), ... }`)を持って呼ぶ。
- モジュール変数はホットリロードで失われる。リロード後は `session.start` が再度走るので、そこで sidecar に再接続する。
- リロード直後は `session.start` の完了より先に `ui.render` が走ることがある。初期化前でも描画が壊れないようにする。
- **`ui.render` の dispatch 内から始めた `$` 呼び出しは、次の再描画で `ui.render: superseded` として中断される。** resize などの副作用は `$.clock.after(0, …)` で dispatch の外へ出す。
- `$.prompt.submit` は `command.run` の hook から直接呼ぶと拒否される。

### sidecar との接続

- `$.process.spawn` は stdin が起動時の 1 回きりで、PTY も resize も無い。子はモジュールのリロードで kill される。シェルの起動には使わない。
- sidecar は `$.process.run` で起動し、daemon 化させる(親がすぐ終了するので待たされない)。
- `$.http.fetch` はボディを読み切ってから解決する。ストリーミングはできないので long-poll にする。
- `socketPath` は絶対パスで 100 バイト前後まで。
- **ソケット名に session id を使わない。** `/clear` で変わり、その後 `session.start` も来ない。Claude Code 本体の PID(`$.process.run(['sh', '-c', 'echo $PPID'])`)を使う。
- `session.end` は `/clear` でも来る(`reason: 'clear'`)。sidecar を止めるのは `clear` 以外のときだけ。
- sidecar は Claude Code の PID を監視し、消えたら自分も終了する。

### キー入力

- 生のキーを受け取れるのは `Client` の surface モジュール(`surface.onKey`)だけ。クリックでフォーカスを得る。
- 届かないキー: Escape(`ctrl+[` も)、Ctrl+C、Ctrl+D、Ctrl+X、Ctrl+Z(Claude Code 自体がサスペンドする)、ペースト(プロンプト欄に入る)。
- `insert` とファンクションキーは、`key` に生のエスケープシーケンスが入って届く。**制御文字を含む文字列を `Text` に入れると tree が拒否され、`Client` が unmount される。** 表示前にエスケープする。
- `alt+b` は `{ key: 'left', meta: true }` に正規化されて届く。
- `surface.post` は 1 フレーム 1 件で後勝ち。キーに連番を振り、ack が来るまで未送達分をまとめて再送する。
- プロンプトにフォーカスがある状態で Claude の作業中に Escape を押すと、ターンが中断される。

### 描画と選択

- `Client` の要素表には `Raster` が無い。`Client` が描いた領域はネイティブの選択対象にならない。
- `Raster` は幅 1 の BMP 文字だけ。全角を出すため、画面は `Text` 行で描く。
- `$.ui.selection()` は、hooks モジュールが描いた `Text` 行の選択を全角も含めて正しく返す。選択後に Escape を押しても残る。
- フルスクリーン表示でないと `$.ui.selection()` は `undefined` になる(Docs。tmux は既定で非フルスクリーン。未検証)。
- ペインは 110 列以上で dock(トランスクリプトの右)、それ未満では inline(プロンプトの上)。inline のペインは中身の高さに合わせて伸びるので、`bodyRows` から行数を決めると循環する。
- 本体側の変化(プロンプト欄が複数行になる、許可ダイアログが出る)でペインの高さが変わる。resize は debounce する。
- ペインはユーザー操作(コマンド)で開く。Claude の作業中に使うコマンドは `immediate: true` で登録する。

## ドキュメントの書き方

- 設計文書と本ファイルは日本語。識別子、API 名、コマンドは原文のまま。
- `concept-mvp.md` と実機の結果が食い違ったら、`docs/architecture.md` に根拠付きで記録し、`concept-mvp.md` の該当箇所も直す。
- 本ファイルの「決まっていること」を変える決定をしたら、同じ変更で本ファイルも直す。
- ステップが終わったら、`docs/implementation-plan.md` の該当箇所と本ファイルの「現在の状態」を更新する。
