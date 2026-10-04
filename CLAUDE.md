# Claude Code Terminal Mod

Claude Code を終了せずに、その場で Terminal Pane を開いて操作し、選択したテキストだけを Claude に渡せるようにする Mod。

- 要件の正: `concept-mvp.md`
- 構成と、実機で確認した API の挙動の正: `docs/architecture.md`
- 実装計画(ステップと完了条件)の正: `docs/implementation-plan.md`

## 現在の状態

- Phase 0(Feasibility Spike)は完了。判定は Go。
- MVP は実装済み。Mod 本体は `mod/`。内訳は、Phase 1(Terminal Only)、Phase 2(Context Bridge)、使ってみて出た改善要望 2 回ぶん(フォーカスの表示、送った Context の可視化、選択モード、キーボードでの送信、下の行の整理とヘルプ)。
- 完了条件は、入れ子の Claude Code(検証ハーネス)で確認した。ユーザーも実機で MVP を動かした(2026-10-05)。ただし、実機での項目ごとの結果(色と反転の見え方、打鍵の遅延、`alt+` のキーが届くか、など)は、まだ記録していない。
- 確認が残っているもの: 上の実機の項目、tmux・非フルスクリーン、compaction 後の扱い、vim 画面からのマウス選択での追加。一覧は `docs/architecture.md` の「まだ確認できていないこと」。
- Phase 3(Polish)は、「配布」だけ実施した(Linux x64 のみ、`main` ブランチに同梱)。ほかは未着手。着手前に、各項目をやるかどうかをユーザーと決める。項目は `docs/implementation-plan.md`。
- `spike/phase0/` は Phase 0 の PoC(Python sidecar)と検証ハーネス、`spike/phase1/` は Bun の PTY の確認スクリプト。PoC は参照用。検証ハーネス(`spike/phase0/harness/drive.py`)は、いまも使う。

## 決まっていること

- 統合境界は公式 Mods API のみ。Claude Code の private implementation の patch、内部 Context 構造の直接書き換え、非公開 IPC は使わない。
- PTY と VT エミュレーションは sidecar プロセスが持つ。hooks モジュールは画面の状態を持たない。
- sidecar は TypeScript + Bun。PTY は Bun 組み込み、VT エミュレータは `@xterm/headless`。`bun build --compile` で単一バイナリにして Mod に同梱する(Phase 1 Step 1 で成立を確認済み。Node.js への切り替えは不要)。
- hooks モジュールと sidecar の通信は Unix ソケット上の HTTP(`$.http.fetch` の `socketPath`)。出力は long-poll。
- 画面は hooks モジュールが `Text` 行で描く。キーは `Client` で受ける。カーソルは sidecar が反転属性として画面に含める。
- ペインは、Terminal の画面と、その下の 1 行。下の行は左詰めで `[ Terminal input ]` `[ Add to Claude ]` `[ Help ]` と状態。上端には何も置かない。
- `[ Terminal input ]` が `Client`。以下で「帯」と書いているのは、この `Client` のこと。クリックするとキーを受ける。受けている間は `TERMINAL · alt+h: help`、選択モードでは `SELECT` と出す。当たり判定は見出しの上だけ。ポインタが乗っている間、`Button` と同じく反転させる。
- Terminal に入力するには、帯をクリックする。キーボードだけで Terminal に切り替える手段は置かない(ユーザーの判断で見送り。`Input` のコマンド行を試作したが外した)。Terminal の画面のクリックでは入力にならない。
- 状態に出すのは、接続中、シェルの終了、さかのぼっている位置、選択の範囲だけ(画面の大きさなどは出さない)。ボタンに `hotkey` は付けない。
- キーの割り当ての説明は、ペインのヘルプに出す(Terminal の行の代わりに描く)。開くのは `alt+h`(`Client` がキーを受けている間)と `[ Help ]`。どのキーでも閉じ、そのキーは PTY に送らない。文面は `mod/shared/keys.ts` の `HELP_LINES`。
- コマンドは `/term`(開く)、`/term-hide`(閉じる。シェルは残す)、`/term-add`(選択を Claude に渡す)。すべて `immediate: true`。
- キーボードでの選択は「選択モード」。`alt+v` で入り、vi 風のキーで動き、`v` / `V` で始点、`enter` で Claude に渡す、`q` / `ctrl+]` で取り消す。`alt+a` は、マウスで選択したテキストを渡す。どれも帯がキーを受けている間だけ効く。割り当ては `mod/shared/keys.ts`。
- 選択モードの状態とハイライトは sidecar が持つ(フレームに色として含める)。hooks モジュールが覚えるのは、キーをどちらへ送るかだけ。
- 渡した内容は、Toast に加えて `$.ui.log` でトランスクリプトに 1 行出す(見出し + 先頭 3 行 + 残りの行数。Claude には渡らない)。
- 履歴(scrollback)は sidecar が 5000 行まで持ち、`/frame` の `back` で窓を動かす。操作はホイールと `shift+PageUp` / `shift+PageDown`。キーを打つと末尾へ戻る。出力が増えても、さかのぼっている位置は保つ。
- ペーストは Terminal に届けない。`[ Paste prompt text ]` ボタン(プロンプト欄の下書きを Terminal へ送る)は、用途が無いとのユーザーの判断で削除した。クリップボードを直接読むこともしない。
- ペイロードの `Working directory` は、sidecar が返すシェルの実際の cwd。取れなければ行を出さない。会話側の選択(`requestId` つき)は追加しない。
- Escape / Ctrl+C / Ctrl+D / Ctrl+Z / Ctrl+X は Mod に届かないので、代替キーで送る。当面の割り当ては `ctrl+]` = Escape、`alt+c` / `alt+d` / `alt+z` / `alt+x` = Ctrl+C / D / Z / X。
- Claude への受け渡しは `$.session.append`。
- Terminal の内容を Claude に自動で渡さない。渡すのは人間が選択して明示的に操作したときだけ。Mod は選択テキストを解釈・要約・実行しない。
- Terminal 側の失敗で Claude Code のセッションを落とさない。
- 対応するのは Linux x64 だけ。macOS など、ほかのプラットフォームには対応しない(ユーザーの判断、2026-10-05)。
- ブランチは 2 本。開発は `develop`、配布は `main`。リリースは、`develop` を `main` に取り込むこと(pull request。squash せず、マージコミットで入れる)。`main` に直接コミットしない。
- 配布は、このリポジトリをマーケットプレイスにする(`.claude-plugin/marketplace.json`、名前は `coxless`)。プラグインの取得元は `main` の `mod/`。sidecar のバイナリは `main` にだけ入れる。入れるのは CI で、手ではコミットしない(`develop` では `.gitignore` の対象)。
- MVP の Non-goals(`concept-mvp.md` §2)を実装しない: 複数 Terminal、タブ、履歴永続化、Claude による Terminal 自動操作など。
- 公式 API で実現できないことは、回避策を積む前に「技術的制約」として `docs/architecture.md` に記録する。

## Mods API の参照先

API は early access でリリースごとに変わる。記憶や本ファイルより、下の一次情報を優先する。

- 型定義(そのビルドの正): Mod がロードされた後の `<mod>/.claude-plugin/types/claude-code/index.d.ts`。約 2 万行あるので、名前で grep して宣言を読む。
- `plugin-authoring` skill: hooks モジュールを書く・デバッグする前に必ずロードする。
- 公式 Docs: https://code.claude.com/docs/ja/plugins/mods/ 配下の `overview` / `create` / `interface` / `events` / `api` / `test` / `troubleshoot` / `reference`
- 組み込み mod のソース(`/diff` ペインがキーバインドとスクロールの実例): https://github.com/anthropics/claude-code/tree/main/mods

Mods は Claude Code v2.1.287 以降が必要。これまでの確認は、すべて v2.1.289 で行った。

## 構成と開発コマンド

```text
.claude-plugin/marketplace.json  # マーケットプレイスの定義(プラグインの取得元は main の mod/)
.github/workflows/ci.yml         # CI(検証)と CD(main への push でバイナリをビルドしてコミット)
mod/
├── .claude-plugin/plugin.json   # name: "terminal", version, description
├── hooks/hooks.json             # { "modules": ["./register.tsx"] }
├── hooks/register.tsx           # hooks モジュール。export const register: Register = on => { ... }
├── hooks/keys.tsx               # Client の surface モジュール(キー入力)
├── hooks/terminal.test.ts       # claude plugin test 用(*.test.ts)
├── shared/                      # hooks と sidecar が共有する型と純関数($ に触れない)。protocol / keys / payload と *.spec.ts
├── sidecar/                     # Bun のソース。main(起動と daemon 化)/ session(PTY、画面、選択モード)/ server(HTTP)と sidecar.spec.ts
└── bin/terminal-sidecar         # コンパイル済みの sidecar バイナリ(git に入れない)
```

テストのファイル名は使い分ける。`bun test` 用は `*.spec.ts`、`claude plugin test` 用は `*.test.ts`。互いに相手の環境では動かない。

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
workshop run -- build               # sidecar を mod/bin/terminal-sidecar にコンパイルする
workshop run -- test                # bun test .spec.ts(引数はそのまま渡る)
workshop run -- lint                # tsc を 2 回: ./mod(hooks。ロード後に型定義が配置される)と ./mod/sidecar(Bun の型)
workshop run -- fmt                 # bunx prettier --write mod(設定は .prettierrc.json)
workshop exec -- bun <args>         # その場限りのコマンド
workshop shell                      # 中に入る
workshop refresh                    # dev.yaml の base / sdks、SDK の hooks を変えた後
```

依存は、ルートの `package.json` に置く(`@xterm/headless`、`typescript`、`@types/bun`、`prettier`)。`mod/` の中に `node_modules/` を作らない。

sidecar のソースを変えたら `workshop run -- build` を実行する。バイナリは git に無いので、clone した直後も必要。中身は `bun build --compile --minify mod/sidecar/main.ts --outfile mod/bin/terminal-sidecar`。

CI と配布(`.github/workflows/ci.yml`):

- `develop` / `main` への push と、pull request のたびに、`bun test`、prettier の確認、`tsc` 2 回、`claude plugin validate`(Mod とマーケットプレイス)、`claude plugin test`、sidecar のビルドを回す。
- `main` への push では、続けて sidecar をビルドし、`mod/bin/terminal-sidecar` を `main` にコミットする(`github-actions[bot]`)。バイナリが前回と同じなら、コミットしない。
- **リリースの手順:** `develop` で `mod/.claude-plugin/plugin.json` の `version` を上げる → `develop` から `main` へ pull request → マージ。`version` を変えないと利用者に更新が届かないので、`main` 向けの pull request は、`version` が `main` と同じだと CI が落ちる。
- `main` には、CI が足したバイナリのコミットがある(`develop` には無い)。次のリリースでも衝突はしない(`develop` はそのパスに触れない)。squash でマージすると履歴が分かれて衝突するので、マージコミットで入れる。
- マージしてから CI がバイナリをコミットするまでの数分は、`main` のバイナリが 1 つ前のもの。
- CI の Claude Code の版は、ワークフローの `CLAUDE_CODE_VERSION` で固定している。Bun の版は `.workshop/bun/hooks/setup-base` から読む。
- hooks の型定義は git に無い。CI では、未ログインのまま `claude --plugin-dir ./mod -p hi` を実行して配置させている(実行は失敗するが、配置はその前に済む。API は呼ばれない)。

変更したら回すもの: `workshop run -- build`、`workshop run -- test`、`workshop run -- lint`、`claude plugin validate ./mod`、`claude plugin test ./mod`。CI も同じものを回す。

実際の画面とキーの確認は、検証ハーネスで入れ子の Claude Code を動かす: `python3 spike/phase0/harness/drive.py serve <ctl-dir> 180 45 -- claude --debug --plugin-dir ./mod`。`<ctl-dir>` は Unix ソケットのパス長の制限があるので短い場所(`$XDG_RUNTIME_DIR` の下など)にする。入れ子のセッションでプロンプトを送ると、実際に Claude が応答する(API を使う)。

スパイクは `claude --plugin-dir ./spike/phase0` で動く(`python3` が必要)。コマンドは `docs/architecture.md` の末尾。

## hooks モジュールを書くときの制約

実際の Claude Code(v2.1.289。入れ子のセッションと検証ハーネス)で確認したもの。根拠と数値は `docs/architecture.md`。

### 実行環境

- hooks モジュールには DOM も Node.js API も無い。外部に届く手段は `$` だけ。
- `import()` を含むモジュールはロードされない。プラグイン内のファイルは静的 `import` で読む。
- **`$` は変数に保存も、関数に渡すこともできない**(`claude plugin validate` が拒否する)。dispatch をまたぐ処理は、`session.start` の `$` を閉じ込めたクロージャの束(`{ fetch: (u, i) => $.http.fetch(u, i), ... }`)を持って呼ぶ。
- モジュール変数はホットリロードで失われる。リロード後は `session.start` が再度走るので、そこで sidecar に再接続する。
- リロード直後は `session.start` の完了より先に `ui.render` が走ることがある。初期化前でも描画が壊れないようにする。
- **`ui.render` の dispatch 内から始めた `$` 呼び出しは、次の再描画で `ui.render: superseded` として中断される。** resize などの副作用は `$.clock.after(0, …)` で dispatch の外へ出す。
- `$.prompt.submit` は `command.run` の hook から直接呼ぶと拒否される。
- `ui.message` など他の dispatch から始める送信や取り直しも、`$.clock.after(0, …)` で外へ出している。PTY への書き込みは 1 本の送信ループで順に行う(並行した POST の到着順は保証されない)。

### sidecar との接続

- `$.process.spawn` は stdin が起動時の 1 回きりで、PTY も resize も無い。子はモジュールのリロードで kill される。シェルの起動には使わない。
- sidecar は `$.process.run` で起動し、daemon 化させる(親がすぐ終了するので待たされない)。
- `$.http.fetch` はボディを読み切ってから解決する。ストリーミングはできないので long-poll にする。
- Bun には `fork` が無い。daemon 化は、`start` が自分自身を `detached: true` で `daemon` モードとして起動する形。
- `Bun.serve` の `idleTimeout` は既定で 10 秒。long-poll より長くしておく(いまは 60)。
- `socketPath` は絶対パスで 100 バイト前後まで。
- **ソケット名に session id を使わない。** `/clear` で変わり、その後 `session.start` も来ない。Claude Code 本体の PID(`$.process.run(['sh', '-c', 'echo $PPID'])`)を使う。
- `session.end` は `/clear` でも来る(`reason: 'clear'`)。sidecar を止めるのは `clear` 以外のときだけ。
- sidecar は Claude Code の PID を監視し、消えたら自分も終了する。

### キー入力

- 生のキーを受け取れるのは `Client` の surface モジュール(`surface.onKey`)だけ。クリックでフォーカスを得る。
- **`$.ui.focus` では `Client` にフォーカスを移せない**(対象は `Button` / `Input` / `Select` だけ。数秒待って deny が返り、その間コマンドが返らない)。呼ばない。`ctrl+x tab` の後の Tab / Enter でも移らない。
- `Input` は `autoFocus` で、`open({ focus: true })` と `ctrl+x tab` のときにキーを受ける。届くのは文字、Backspace、Enter。Tab、上下の矢印、Ctrl / Alt つきのキーは届かない。
- ペインの枠がフォーカスを持っている間に打った文字はプロンプト欄に入り、ペインはフォーカスを失う。`prompt.edit` でキーを消費しても同じ。
- `Button` の `hotkey` は、帯(`Client`)や `Input` がキーを受けている間は効かない。
- キーの連番は `Client` のインスタンスごと。`Client` は自分の id を一緒に送り、hooks 側は id が変わったら数え直す。
- 届かないキー: Escape(`ctrl+[` も)、Ctrl+C、Ctrl+D、Ctrl+X、Ctrl+Z(Claude Code 自体がサスペンドする)、ペースト(プロンプト欄に入る)。
- `insert` とファンクションキーは、`key` に生のエスケープシーケンスが入って届く。**制御文字を含む文字列を `Text` に入れると tree が拒否され、`Client` が unmount される。** 表示前にエスケープする。
- `alt+b` は `{ key: 'left', meta: true }` に正規化されて届く。
- **`Client` がフォーカスを得た・失ったを知る API は無い。** `Pane` の `isFocused` は、`Client` がキーを受けている間も false。帯のクリックとキーの到着で「受けている」と推定し、`prompt.edit` と `isFocused` が true で下ろす。Escape の直後は検知できない。
- ペインの中身(Terminal の行、ボタン)をクリックすると、ペインの枠がフォーカスを持ち、`Client` はキーを失う。
- `surface.post` は 1 フレーム 1 件で後勝ち。キーに連番を振り、ack が来るまで未送達分をまとめて再送する。
- プロンプトにフォーカスがある状態で Claude の作業中に Escape を押すと、ターンが中断される。

### 描画と選択

- `Client` の要素表には `Raster` が無い。`Client` が描いた領域はネイティブの選択対象にならない。
- `Raster` は幅 1 の BMP 文字だけ。全角を出すため、画面は `Text` 行で描く。
- `$.ui.selection()` は、hooks モジュールが描いた `Text` 行の選択を全角も含めて正しく返す。選択後に Escape を押しても残る。
- フルスクリーン表示でないと `$.ui.selection()` は `undefined` になる(Docs。tmux は既定で非フルスクリーン。未検証)。
- ペインは 110 列以上で dock(トランスクリプトの右)、それ未満では inline(プロンプトの上)。
- **inline のペインの `bodyRows` は「中身の高さ」と「レイアウトが許す高さ」の小さいほう。** 中身を `bodyRows` に合わせると縮む一方になる。外側の `Box` の `minHeight` で中身の高さを保ち、Terminal の行数だけを `bodyRows` に合わせる。エラー表示など、どの状態の tree にも同じ `minHeight` を付ける。
- **`Text` の `color` は「テーマのキー、色の名前、hex」だけ。** `ansi:red` は tree ごと拒否される。`red` などの名前は Claude Code 側の RGB になり、端末の ANSI 色にはならない。
- ペインの上のホイールは `ui.scroll` として届く(`by` が行数)。中身を 1 画面ぶんに保ち、hook が `next` を呼ばずに答えれば、窓は動かない。
- 本体側の変化(プロンプト欄が複数行になる、許可ダイアログが出る)でペインの高さが変わる。resize は debounce する。
- `$.ui.log` は改行を出せない(1 行にまとめられる)。行ごとに呼ぶと、あいだに空行が入る。
- `session.start` の `$` を閉じ込めた `$.session.append` / `$.ui.toast` / `$.ui.log` / `$.ui.selection` は、後から呼べる。
- ペインはユーザー操作(コマンド)で開く。Claude の作業中に使うコマンドは `immediate: true` で登録する。

## ドキュメントの書き方

- 設計文書と本ファイルは日本語。識別子、API 名、コマンドは原文のまま。
- `concept-mvp.md` と実機の結果が食い違ったら、`docs/architecture.md` に根拠付きで記録し、`concept-mvp.md` の該当箇所も直す。
- 本ファイルの「決まっていること」を変える決定をしたら、同じ変更で本ファイルも直す。
- ステップが終わったら、`docs/implementation-plan.md` の該当箇所と本ファイルの「現在の状態」を更新する。
