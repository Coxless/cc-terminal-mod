# 実装計画

Phase 0(Feasibility Spike)の後の計画。要件は `concept-mvp.md`、構成と API の挙動の根拠は `docs/architecture.md`。

- 作成日: 2026-10-05
- 対象: Claude Code v2.1.289 以降 / Linux(macOS は Phase 3)

## 全体

| Phase | 目的 | 終わったと言える状態 |
| :- | :- | :- |
| 1. Terminal Only | ペインの中で普通のシェルが使える | AC-1〜6、9、10 を満たし、ユーザーが実機で vim と大量ログを確認した |
| 2. Context Bridge | 選択したテキストを Claude に渡せる | AC-7、8 を満たし、アイドル時と作業中の両方で Claude が内容を読んだ |
| 3. Polish | 日常的に使える品質にする | 下の各項目を、やる・やらないを決めたうえで完了した |

AC は `concept-mvp.md` §19。

進め方:

- 各ステップは上から順に進める。ステップの「完了条件」を満たしてから次へ行く。
- ステップが終わるたびに、分かった事実を `docs/architecture.md` に、決定を `CLAUDE.md` の「決まっていること」に反映する。
- 公式 API で実現できないことが見つかったら、回避策を積む前に `docs/architecture.md` の「技術的制約」に記録する。

## 成果物の構成

```text
mod/
├── .claude-plugin/plugin.json   # name: "terminal"
├── hooks/hooks.json
├── hooks/register.tsx           # hooks モジュール
├── hooks/keys.tsx               # Client の surface モジュール(キー入力)
├── hooks/*.test.ts              # claude plugin test
├── shared/protocol.ts           # hooks と sidecar が共有する型
├── shared/keys.ts               # キー → バイト列の変換(純関数)
├── shared/payload.ts            # Context Payload の生成(純関数。Phase 2)
├── sidecar/                     # Bun のソースと bun test
└── bin/                         # コンパイル済みの sidecar バイナリ
```

`shared/` には `$` に触れない純関数だけを置く。hooks モジュールからも `bun test` からも import できるようにするため。

---

## Phase 1 — Terminal Only

Claude への受け渡しは作らない。

### Step 1 — Bun の導入と sidecar の技術確認

Bun は導入しただけで、PTY はまだ動かしていない。本実装の前に、Mod と切り離した小さなスクリプトで前提を確かめる。

やること:

- ~~Bun をインストールする~~ 済み。Workshop のプロジェクト内 SDK(`.workshop/bun/`)で Bun 1.4.2 を入れた。コマンドは `CLAUDE.md`
- Bun の PTY でシェルを起動し、stdin、resize、Ctrl+C / Ctrl+D / Ctrl+Z(制御文字)を通す
- `@xterm/headless` に出力を流し、画面を行単位で取り出す(全角、色、カーソル、alternate screen、resize 後の内容)
- `Bun.serve` の Unix ソケットで HTTP を受ける
- 起動コマンドがすぐ返る形で、プロセスを親から切り離す
- `bun build --compile` の単一バイナリで同じことを確かめる

完了条件:

- Phase 0 の `/term-selftest` と同じ項目(`docs/architecture.md` §1 の表)が、コンパイル済みバイナリで通る
- `vi` を起動して終了すると、元の画面に戻る(pyte でできなかったこと)
- ビルドとテストのコマンドが決まり、`CLAUDE.md` に追記されている

切り替え条件: PTY の resize かシグナル、または daemon 化が Bun で成立しなければ、Node.js + `node-pty` にする。`@xterm/headless` と通信部分は変わらない。結果は `docs/architecture.md` に記録する。

### Step 2 — sidecar

やること:

- `shared/protocol.ts`: `/frame` `/input` `/resize` `/kill` `/info` のリクエストとレスポンスの型
- シェルの起動: `$SHELL`、無ければ `/bin/sh`。cwd は引数で受ける
- `/frame` の long-poll: 画面を、行ごとの「テキスト + 前景色 + 背景色 + 太字」の並びで返す。カーソル位置を含める
- `/resize`: 画面内容を保ったまま大きさを変える
- 監視: Claude Code の PID が消えたら、シェルごと終了する
- シェルが終了したら、その事実と終了コードを `/frame` で返す
- すでに同じソケットで動いている場合は、新しく起動せずそのことを返す
- ソケットは 0700 のディレクトリに 0600 で作る

完了条件:

- `bun test` が通る: 入出力、resize、制御文字、全角、alternate screen、大量出力、監視による終了、二重起動
- 2 MB を超える出力を流しても、最後の画面まで取り出せる

### Step 3 — hooks モジュール

やること:

- `/term`: sidecar を起動してペインを開く。`/term-hide`: ペインを閉じる(PTY は残す)。どちらも `immediate: true`
- ソケット名は Claude Code の PID から作る
- `session.start` で、既存の sidecar があれば再接続する
- long-poll のループと、`Text` 行での描画
- ペインの大きさに合わせた resize。debounce し、inline 配置では行数を固定する
- `session.end` で sidecar を止める。ただし `reason` が `clear` のときは止めない
- エラー表示(`concept-mvp.md` §14): 起動失敗、切断。`/term` で再接続できる

完了条件:

- シェルで `ls --color`、`git status`、全角を含む出力が正しく表示される(入力は Step 4 までの間、仮の `Input` 要素か検証ハーネスで送る)
- Hide → 再表示、モジュールのリロード、`/clear` の後も、同じシェルが続いている
- sidecar を `kill -9` しても Claude Code のセッションが続き、切断の表示が出る
- `/exit` の後に sidecar が残っていない
- `claude plugin validate ./mod` が通る

### Step 4 — キー入力

やること:

- `hooks/keys.tsx`: `onKey` で受け、連番 + ack で hooks モジュールへ送る
- `shared/keys.ts`: キーからバイト列への変換。矢印、Home / End、PageUp / PageDown、Delete、修飾つきキー、ファンクションキー
- 代替キー: `ctrl+]` = Escape、`alt+c` / `alt+d` / `alt+z` / `alt+x` = Ctrl+C / D / Z / X
- 生のエスケープシーケンスで届くキー(`insert`、ファンクションキー)は、そのまま PTY に流す
- ペインに、代替キーの案内を 1 行で出す
- `$.ui.focus` で、クリックなしに `Client` へフォーカスを移せるかを試す。できれば `/term` の直後に入力できるようにする
- ペーストの代替経路を決める。候補: クリップボードを sidecar が読むキーを用意する、`$.prompt.read` で下書きを読んで送るコマンドを用意する

完了条件:

- `shared/keys.ts` の単体テストが通る
- `vi` でファイルを編集して保存できる。`less`、`top` を操作して終了できる
- `sleep 100` を代替キーの Ctrl+C で止められる
- 速く打っても文字が抜けない、順序が入れ替わらない
- フォーカス移動とペーストについて、できたこと・できなかったことが `docs/architecture.md` に記録されている

### Step 5 — scrollback

やること:

- `@xterm/headless` の履歴を、ペインでどう見せるかを決める。候補: ペイン自体のスクロール(描画する行を増やす)、`/frame` にオフセットを渡して sidecar 側で窓を動かす
- 履歴の上限を決める(`concept-mvp.md` §23)
- 新しい出力が来たときに末尾へ戻る動作

完了条件:

- `seq 1 1000` の後、先頭付近までさかのぼって読め、末尾に戻れる
- さかのぼった位置のテキストを選択できる(Phase 2 で使う)

### Step 6 — 受け入れ確認

自動で確認すること:

- `claude plugin validate ./mod`、`claude plugin test ./mod`、`bun test`、型チェック
- Phase 0 の検証ハーネス(`spike/phase0/harness/drive.py`)で、ペインを開く → 入力 → 表示 → Hide → 再表示の一連を通す

ユーザーが実機(Ghostty)で確認すること。Phase 0 で確認できなかった点:

- bash、vim、less、top、git の操作
- 色の見え方、全角文字の位置ずれ
- 打鍵から表示までの遅延
- マウスでのクリックと選択の感触
- 大量ログ(`cat` で大きなファイル)で UI が固まらないこと
- 代替キーの使い勝手
- tmux の中と、非フルスクリーン表示での挙動

完了条件:

- AC-1(起動)、AC-2(Shell)、AC-3(Interactive command)、AC-4(Claude Code 継続)、AC-5(Working Directory)、AC-6(Selection)、AC-9(persistence)、AC-10(Isolation)
- 実機で見つかった制約が `docs/architecture.md` に記録されている

---

## Phase 2 — Context Bridge

```text
ペイン内の選択 → $.ui.selection() → Context Payload → $.session.append
```

### Step 1 — ペイロードと追加コマンド

やること:

- `shared/payload.ts`: `concept-mvp.md` §9 の形式でペイロードを作る純関数
- `/term-add`(`immediate: true`): 選択を読み、ペイロードを作り、`$.session.append` で追加する
- 選択が無いときは何も追加せず、そのことを伝える

完了条件:

- ペイロード生成の単体テストが通る(複数行、全角、空の選択)
- `claude plugin test` で、選択 → 追加の流れを確認する

### Step 2 — シェルの実際の cwd

Phase 0 のスパイクは Claude Code の cwd を入れていた。シェルで `cd` するとずれる。

やること:

- sidecar の `/info` が、シェルの現在の cwd を返す(Linux は `/proc/<pid>/cwd`)
- 取れない場合は `Working directory` の行を出さない(`concept-mvp.md` §8: 確実に取得できる情報だけを使う)

完了条件:

- `cd /tmp` の後に追加したペイロードが `/tmp` になっている

### Step 3 — フィードバック

やること:

- 成功: toast(`Added 142 characters to Claude Context`)と、コマンドの出力行
- 失敗: `Failed to add selection to Claude Context.` と理由。再実行できる
- 選択が読めない環境(非フルスクリーン)では、原因と対処を伝える
- ペイン内の `[ Add to Claude ]` ボタン

完了条件:

- 成功、選択なし、追加の失敗、選択が読めない環境の 4 通りで、それぞれ表示が出る

### Step 4 — 受け入れ確認

確認すること:

- アイドル時: 追加してもターンが始まらない。次のプロンプトで Claude が内容を使う(`concept-mvp.md` §20 Scenario 2)
- 作業中: ツール実行中に追加した内容を、同じターンの中で Claude が読む
- vim の画面から選択して追加できる(Scenario 3)
- 追加した内容が、`/clear` や compaction の後にどう扱われるか

完了条件:

- AC-7(Context 追加)、AC-8(Feedback)
- Terminal で何を実行しても、選択して追加しない限り Claude に渡らない(`concept-mvp.md` §17)。会話の記録を見て確かめる

---

## Phase 3 — Polish

Phase 1、2 を使ってみてから優先度を決める。着手前に、各項目をやるかどうかをユーザーと決める。

| 項目 | 内容 |
| :- | :- |
| ペインを開くキー | `/term` を打たずに開く手段。`Button` の `action`(Claude Code のキーバインドに載せる)が使えるかを調べる |
| 代替キーの見直し | 使ってみた結果で割り当てを変える。`userConfig` で設定できるようにするか決める |
| Kill 操作 | シェルを明示的に終了して作り直す `/term-kill`(`concept-mvp.md` §13) |
| エラー処理 | sidecar のバイナリが無い・実行できない、ソケットを作れない、シェルがすぐ終了する、の各場合の表示 |
| 性能 | 大量出力時の描画回数、sidecar のメモリ、履歴の上限。数値を測ってから手を入れる |
| マウス | Terminal 内のアプリ(vim、less)へのマウス転送。選択と両立しないので、やるなら切り替え方式を決める |
| 画面クリックで入力 | `Client` に画面を描かせて選択を自作する方式(`docs/architecture.md` 技術的制約 3)。クリップボードへのコピーも含む |
| macOS | sidecar のビルドと動作確認。cwd の取得方法が Linux と違う |
| 配布 | プラットフォームごとのバイナリのビルド、Marketplace への登録、README |
| API 追従 | 対象バージョンの明記。Claude Code の更新時に回す確認手順 |

やらないと決めているもの(`concept-mvp.md` §2 の Non-goals): 複数 Terminal、タブ、履歴の永続化、Claude による Terminal の自動操作、出力の自動解析や要約。

---

## テストの分担

| 対象 | 手段 |
| :- | :- |
| `shared/` の純関数 | `bun test` |
| sidecar(PTY、エミュレーション、HTTP) | `bun test`。実際にシェルを起動する |
| hooks モジュールの振る舞い | `claude plugin test ./mod`。描画は検証しない |
| 実際の画面とキー、マウス | Phase 0 の検証ハーネス。入れ子の Claude Code を PTY で動かす |
| 見た目、操作感 | ユーザーが実機で確認する |

## リスク

| リスク | 影響 | 対応 |
| :- | :- | :- |
| Bun の PTY が要件を満たさない | Phase 1 Step 1 で判明 | Node.js + `node-pty` に切り替える |
| Mods API がリリースで変わる | 動かなくなる | 型定義を一次情報とし、更新のたびに validate とテストを回す |
| 実機(Ghostty)でキーの届き方が違う | 代替キーの見直し | Phase 1 Step 6 で確認する。届くキーが増える方向なら割り当てを減らせる |
| tmux や非フルスクリーンで選択が読めない | Phase 2 がその環境で使えない | 制約として記録し、その環境では原因を表示する |
| 打鍵の遅延が体感で大きい | Terminal として使いにくい | Phase 1 Step 6 で測る。long-poll の往復と描画のどちらが効いているかを切り分ける |
