# Claude Code Terminal Mod

Claude Code を終了せずに、その場で Terminal Pane を開いて操作し、選択したテキストだけを Claude に渡せるようにする Mod。

- 要件の正: `concept-mvp.md`
- 構成と、実機で確認した API の挙動の正: `docs/architecture.md`
- 実装計画(ステップと完了条件)の正: `docs/implementation-plan.md`

## 現在の状態

- Phase 0(Feasibility Spike)は完了。判定は Go。
- Phase 1(Terminal Only)の Step 1〜5 と、Phase 2(Context Bridge)の Step 1〜3 は実装済み。Mod 本体は `mod/`。完了条件は、入れ子の Claude Code(検証ハーネス)で確認した。
- 残っているのは、ユーザーが実機(Ghostty)で確認する項目(Phase 1 Step 6)、Phase 2 Step 4 のうち compaction 後の扱いと vim 画面からの追加、tmux・非フルスクリーンでの確認。一覧は `docs/architecture.md` の「まだ確認できていないこと」。
- Phase 3(Polish)は未着手。着手前に、各項目をやるかどうかをユーザーと決める。
- `spike/phase0/` は Phase 0 の PoC(Python sidecar)、`spike/phase1/` は Bun の PTY の確認スクリプト。どちらも参照用。

## 決まっていること

- 統合境界は公式 Mods API のみ。Claude Code の private implementation の patch、内部 Context 構造の直接書き換え、非公開 IPC は使わない。
- PTY と VT エミュレーションは sidecar プロセスが持つ。hooks モジュールは画面の状態を持たない。
- sidecar は TypeScript + Bun。PTY は Bun 組み込み、VT エミュレータは `@xterm/headless`。`bun build --compile` で単一バイナリにして Mod に同梱する(Phase 1 Step 1 で成立を確認済み。Node.js への切り替えは不要)。
- hooks モジュールと sidecar の通信は Unix ソケット上の HTTP(`$.http.fetch` の `socketPath`)。出力は long-poll。
- 画面は hooks モジュールが `Text` 行で描く。キーは 1 行の `Client` で受ける。カーソルは sidecar が反転属性として画面に含める。
- コマンドは `/term`(開く)、`/term-hide`(閉じる。シェルは残す)、`/term-add`(選択を Claude に渡す)。すべて `immediate: true`。
- 履歴(scrollback)は sidecar が 5000 行まで持ち、`/frame` の `back` で窓を動かす。操作はホイールと `shift+PageUp` / `shift+PageDown`。キーを打つと末尾へ戻る。出力が増えても、さかのぼっている位置は保つ。
- ペーストは、プロンプト欄に入った下書きをペインの `[ Paste prompt text ]` ボタンで Terminal へ送る。クリップボードを直接読むことはしない。
- ペイロードの `Working directory` は、sidecar が返すシェルの実際の cwd。取れなければ行を出さない。会話側の選択(`requestId` つき)は追加しない。
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
├── hooks/terminal.test.ts       # claude plugin test 用(*.test.ts)
├── shared/                      # hooks と sidecar が共有する型と純関数($ に触れない)。protocol / keys / payload
├── sidecar/                     # Bun のソース。main(起動と daemon 化)/ session(PTY と画面)/ server(HTTP)
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

変更したら回すもの: `workshop run -- build`、`workshop run -- test`、`workshop run -- lint`、`claude plugin validate ./mod`、`claude plugin test ./mod`。

実際の画面とキーの確認は、検証ハーネスで入れ子の Claude Code を動かす: `python3 spike/phase0/harness/drive.py serve <ctl-dir> 180 45 -- claude --debug --plugin-dir ./mod`。`<ctl-dir>` は Unix ソケットのパス長の制限があるので短い場所(`$XDG_RUNTIME_DIR` の下など)にする。入れ子のセッションでプロンプトを送ると、実際に Claude が応答する(API を使う)。

スパイクは `claude --plugin-dir ./spike/phase0` で動く(`python3` が必要)。コマンドは `docs/architecture.md` の末尾。

## hooks モジュールを書くときの制約

Phase 0〜2 で実機確認したもの。根拠と数値は `docs/architecture.md`。

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
- **`$.ui.focus` では `Client` にフォーカスを移せない**(対象は `Button` / `Input` / `Select` だけ。数秒待って deny が返り、その間コマンドが返らない)。呼ばない。
- キーの連番は `Client` のインスタンスごと。`Client` は自分の id を一緒に送り、hooks 側は id が変わったら数え直す。
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
- ペインは 110 列以上で dock(トランスクリプトの右)、それ未満では inline(プロンプトの上)。
- **inline のペインの `bodyRows` は「中身の高さ」と「レイアウトが許す高さ」の小さいほう。** 中身を `bodyRows` に合わせると縮む一方になる。外側の `Box` の `minHeight` で中身の高さを保ち、Terminal の行数だけを `bodyRows` に合わせる。エラー表示など、どの状態の tree にも同じ `minHeight` を付ける。
- **`Text` の `color` は「テーマのキー、色の名前、hex」だけ。** `ansi:red` は tree ごと拒否される。`red` などの名前は Claude Code 側の RGB になり、端末の ANSI 色にはならない。
- ペインの上のホイールは `ui.scroll` として届く(`by` が行数)。中身を 1 画面ぶんに保ち、hook が `next` を呼ばずに答えれば、窓は動かない。
- 本体側の変化(プロンプト欄が複数行になる、許可ダイアログが出る)でペインの高さが変わる。resize は debounce する。
- ペインはユーザー操作(コマンド)で開く。Claude の作業中に使うコマンドは `immediate: true` で登録する。

## ドキュメントの書き方

- 設計文書と本ファイルは日本語。識別子、API 名、コマンドは原文のまま。
- `concept-mvp.md` と実機の結果が食い違ったら、`docs/architecture.md` に根拠付きで記録し、`concept-mvp.md` の該当箇所も直す。
- 本ファイルの「決まっていること」を変える決定をしたら、同じ変更で本ファイルも直す。
- ステップが終わったら、`docs/implementation-plan.md` の該当箇所と本ファイルの「現在の状態」を更新する。
