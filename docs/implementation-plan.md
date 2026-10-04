# 実装計画

Phase 0(Feasibility Spike)の後の計画。要件は `concept-mvp.md`、構成と API の挙動の根拠は `docs/architecture.md`。

- 作成日: 2026-10-05(同日、進み具合を追記)
- 対象: Claude Code v2.1.289 以降 / Linux x64(ほかのプラットフォームには対応しない)

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

## 進み具合(2026-10-05)

| 対象 | 状態 |
| :- | :- |
| Phase 1 Step 1〜5 | 完了。完了条件は入れ子の Claude Code(検証ハーネス)で確認した |
| Phase 1 Step 6 | 自動で確認する項目は完了。**ユーザーが実機(Ghostty)で確認する項目が残っている** |
| Phase 2 Step 1〜3 | 完了 |
| Phase 2 Step 4 | アイドル時・作業中・会話の記録は確認した。compaction の後の扱いと、vim の画面からの追加(Scenario 3)は未確認 |
| Phase 3 の改善要望 4 件 | 完了(下の「改善要望への対応計画」)。色と反転の見え方は、ユーザーの実機での確認が残っている |
| Phase 3 の改善要望 その 2 | 完了(下の行の整理、ヘルプ)。ショートカットでの切り替えは見送り |
| Phase 3 の配布 | 完了。Linux x64 のみ、`release` ブランチに同梱 |
| Phase 3 のほかの項目 | 未着手。各項目をやるかどうかを、ユーザーと決めるところから |

ユーザーは実機で MVP を動かした(2026-10-05)。実機での項目ごとの結果(Phase 1 Step 6 の一覧)は、まだ記録していない。

確認した内容と数値は `docs/architecture.md` の「Phase 1・2 で確認したこと」。残っている確認の一覧は、同じ文書の「まだ確認できていないこと」。

以下の各ステップの「やること」は、着手前に書いた計画のまま残している。計画から変わった点は、各ステップの「結果」に書いた。いまの仕様は `CLAUDE.md` の「決まっていること」が正。

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
├── shared/*.spec.ts             # bun test
├── sidecar/                     # Bun のソースと bun test(*.spec.ts)
└── bin/                         # コンパイル済みの sidecar バイナリ
```

`shared/` には `$` に触れない純関数だけを置く。hooks モジュールからも `bun test` からも import できるようにするため。

---

## Phase 1 — Terminal Only

Claude への受け渡しは作らない。

### Step 1 — Bun の導入と sidecar の技術確認

**完了(2026-10-05)。** Bun の PTY で成立し、Node.js への切り替えは不要だった。確認スクリプトは `spike/phase1/pty-check.ts`、結果は `docs/architecture.md`。

本実装の前に、Mod と切り離した小さなスクリプトで前提を確かめる。

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

**完了(2026-10-05)。**

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

**完了(2026-10-05)。** 結果: inline 配置の行数は固定せず、外側の `Box` の `minHeight` で中身の高さを保つ形にした。

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

**完了(2026-10-05)。** 結果:

- `$.ui.focus` では `Client` にフォーカスを移せなかった。クリックが要る(技術的制約 7)。
- ペーストの代替として `[ Paste prompt text ]` ボタンを作ったが、後で削除した。いまはペーストの手段が無い(技術的制約 2)。
- 代替キーの案内は、1 行の表示ではなくペインのヘルプ(`alt+h`、`[ Help ]`)になった。

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

**完了(2026-10-05)。** 結果: sidecar 側で窓を動かす方式(`/frame` の `back`)。上限は 5000 行。キーを打つと末尾へ戻る。出力が増えても、さかのぼっている位置は保つ。

やること:

- `@xterm/headless` の履歴を、ペインでどう見せるかを決める。候補: ペイン自体のスクロール(描画する行を増やす)、`/frame` にオフセットを渡して sidecar 側で窓を動かす
- 履歴の上限を決める(`concept-mvp.md` §23)
- 新しい出力が来たときに末尾へ戻る動作

完了条件:

- `seq 1 1000` の後、先頭付近までさかのぼって読め、末尾に戻れる
- さかのぼった位置のテキストを選択できる(Phase 2 で使う)

### Step 6 — 受け入れ確認

**自動で確認する項目は完了。ユーザーが確認する項目は、結果をまだ記録していない。**

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

**完了(2026-10-05)。** 結果: テストキットではプラグインの `$.session.append` を受けられなかったので、`claude plugin test` で確認しているのは失敗時の表示。追加の成功は入れ子のセッションで確認した。

やること:

- `shared/payload.ts`: `concept-mvp.md` §9 の形式でペイロードを作る純関数
- `/term-add`(`immediate: true`): 選択を読み、ペイロードを作り、`$.session.append` で追加する
- 選択が無いときは何も追加せず、そのことを伝える

完了条件:

- ペイロード生成の単体テストが通る(複数行、全角、空の選択)
- `claude plugin test` で、選択 → 追加の流れを確認する

### Step 2 — シェルの実際の cwd

**完了(2026-10-05)。**

Phase 0 のスパイクは Claude Code の cwd を入れていた。シェルで `cd` するとずれる。

やること:

- sidecar の `/info` が、シェルの現在の cwd を返す(Linux は `/proc/<pid>/cwd`)
- 取れない場合は `Working directory` の行を出さない(`concept-mvp.md` §8: 確実に取得できる情報だけを使う)

完了条件:

- `cd /tmp` の後に追加したペイロードが `/tmp` になっている

### Step 3 — フィードバック

**完了(2026-10-05)。** 結果: 失敗時は `[Retry]` ではなく、`/term-add` でやり直す案内を出す。「選択が読めない環境」の表示は、実機では出していない。

やること:

- 成功: toast(`Added 142 characters to Claude Context`)と、コマンドの出力行
- 失敗: `Failed to add selection to Claude Context.` と理由。再実行できる
- 選択が読めない環境(非フルスクリーン)では、原因と対処を伝える
- ペイン内の `[ Add to Claude ]` ボタン

完了条件:

- 成功、選択なし、追加の失敗、選択が読めない環境の 4 通りで、それぞれ表示が出る

### Step 4 — 受け入れ確認

**一部が未確認。** アイドル時、作業中、`/clear` の後、会話の記録は確認した。残りは、vim の画面からマウスで選択しての追加と、compaction の後の扱い。

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
| ペインを開くキー | `/term` を打たずに開く手段。`Button` の `action="app:toggleTerminal"` は、プロンプトからは押されなかった(確認済み)。ほかの手段があるかを調べる |
| 代替キーの見直し | 使ってみた結果で割り当てを変える。`userConfig` で設定できるようにするか決める |
| Kill 操作 | シェルを明示的に終了して作り直す `/term-kill`(`concept-mvp.md` §13) |
| エラー処理 | ソケットを作れない、シェルがすぐ終了する、の各場合の表示。バイナリが無い場合は `Failed to start shell.` と理由、`[ Retry ]` が出る(確認済み) |
| 性能 | 大量出力時の描画回数、sidecar のメモリ、履歴の上限。数値を測ってから手を入れる |
| マウス | Terminal 内のアプリ(vim、less)へのマウス転送。選択と両立しないので、やるなら切り替え方式を決める |
| 画面クリックで入力 | `Client` に画面を描かせて選択を自作する方式(`docs/architecture.md` 技術的制約 3)。クリップボードへのコピーも含む |
| ~~macOS~~ | やらない。対応は Linux x64 だけ(ユーザーの判断、2026-10-05) |
| 配布 | 実施済み(2026-10-05)。Linux x64 のバイナリを `release` ブランチに同梱する(`scripts/release.sh`)。このリポジトリがマーケットプレイス(`.claude-plugin/marketplace.json`)。README を追加した。CI(`.github/workflows/ci.yml`)が、`main` で `version` が変わったときにビルドして `release` を作り直す |
| API 追従 | 対象バージョンの明記。Claude Code の更新時に回す確認手順。CI は `CLAUDE_CODE_VERSION` で版を固定しているので、上げて CI を回せば、validate・型チェック・テストまでは確認できる |

### 使ってみて出た改善要望(2026-10-05)

ユーザーが `/term`、ペースト、`/term-add` を実際に使って挙げたもの。4 件とも実装済み。

| 項目 | 内容 |
| :- | :- |
| キーボードでの選択 | Terminal 内のテキスト選択を、マウスのドラッグではなくショートカットで行う。マウスでの選択はわかりづらい。上の「画面クリックで入力」(選択の自作)と関係する |
| 選択中のハイライト | どちらを選択しているかわからないので、ターミナル選択時にハイライトを出す。意味は「Terminal にフォーカスが移ったときに、それがわかるようにしたい」(2026-10-05 にユーザーに確認。`/term` の直後に入力できず、`click here to type` のクリックが必要だと気づけなかった) |
| キーボードでの送信 | 選択した部分を Claude に送る操作を、ショートカットで行う。マウスでは直感的でない |
| 送った Context の可視化 | Claude Code 側にどんな Context が送られたのかを、ユーザーが見てわかるようにする |

対応計画は下の「改善要望への対応計画」。

### 使ってみて出た改善要望 その 2(2026-10-05)

| 項目 | 内容 | 対応 |
| :- | :- | :- |
| ショートカットでの切り替え | Claude Code と Terminal の切り替えを、ショートカットで行う | 見送り。ペインにコマンド行(`Input`)を置いて試したが、4 行目の判断で外した。切り替えは `[ Terminal input ]` のクリック(技術的制約 7) |
| `a:` / `p:` の使い方 | 下の `a: Add to Claude` / `p: Paste prompt text` の使い方がわからない。`p` を押すと Terminal に `p` が入った | 実装済み。`hotkey` を外し、`[ Add to Claude ]` のボタンにした(`[ Paste prompt text ]` は 4 行目で削除) |
| 上端の帯の削除とヘルプ | 見栄えのため、上端の `click here for all keys …` を消す。代わりに、ショートカットでヘルプを出す | 実装済み。`Client` は下の行に移した(見出しは 4 行目で `[ Terminal input ]` に改名)。ヘルプは `alt+h` と `[ Help ]` |
| 下の行の整理 | ショートカットでの切り替えは、いったん諦める。`run:` を消す。`[ All keys ]` を分かりやすい名前にする。`[ Paste prompt text ]` は用途が無いので消す。`[ Help ]` は残す | 実装済み。コマンド行を外し、`[ Terminal input ]` に改名し、ペーストのボタンを削除した |

確認した内容は `docs/architecture.md` の「キーボードでの切り替えとコマンド行」と「下の行の整理」。ユーザーの実機での確認が残っているもの: Ghostty で `alt+h` が届くか、inline(110 列未満)での下の行の見え方。

### 改善要望への対応計画(2026-10-05)

状態: **Step A〜D を実装済み(2026-10-05)。** 完了条件は `bun test`、`claude plugin test`、検証ハーネスで確認した。確認した内容は `docs/architecture.md` の「改善要望への対応」。

計画から変えた点:

- Step A: `Client` のフォーカスは `isFocused` では分からなかった(技術的制約 9)。帯のクリックとキーの到着、`prompt.edit` から推定する形にした。Escape の直後は、プロンプト欄に 1 文字入るまで帯が戻らない。
- Step B: `$.ui.log` が改行を出せないので、見出しと先頭 3 行を 1 行にまとめた。
- Step C: `[ Select ]` ボタンは作らなかった(押すとキーが `Client` に届かなくなる)。入り口は `alt+v` だけ。
- Step D: プロンプトにフォーカスがあるままのショートカット(`Button` の `action`)は、この時点では調べていない。→ その 2 で `action="app:toggleTerminal"` を試したが、プロンプトからは押されなかった(`docs/architecture.md` の「キーボードでの切り替えとコマンド行」)。

その 2 でさらに変わった点(下の Step A〜D の「やること」には反映していない):

- 帯は上端ではなく、下の行の `[ Terminal input ]`。受けている間の表示は `TERMINAL · alt+h: help`。
- ボタンの `hotkey`(`a:` / `p:`)は外した。`[ Paste prompt text ]` は削除した。
- ペインの状態の行に `added 3 lines` は出さない。選択モードの状態は、選択の範囲だけを出す。キーの説明はヘルプに移した。

ユーザーの実機での確認が残っているもの: 選択範囲の反転と選択カーソルの色、帯の色、`alt+v` / `alt+a` が Ghostty で届くか、非フルスクリーンと tmux での選択モード。

#### 調べて分かったこと

型定義(v2.1.289 の `index.d.ts`)と現在の `mod/` を読んだ結果。実機では未確認。

| # | 事実 | 計画への影響 |
| :- | :- | :- |
| 1 | `$.ui.selection()` が返すのは「マウスで最後に選択したもの」。選択を Mod から作る・動かす API は無い | キーボードでの選択は、ネイティブの選択には乗せられない。Mod が自前で持つ |
| 2 | ネイティブの選択のハイライトは、コマンドやボタンが走る前に、キーかクリックで消える(選択の中身は残る) | `/term-add` と打った時点でハイライトが消える。「どちらを選択しているかわからない」の原因の 1 つと推測する |
| 3 | `Pane` の props に `isFocused`(ペインがキーボードを持っている間 true)がある。`Client` 側には、フォーカスを得た・失ったを知る API が無い(Escape は届かない) | フォーカスの表示は、`isFocused` と `Client` 自身の「クリックされた・キーが来た」を組み合わせて作る。`Client` がキーを持っている間 `isFocused` がどうなるかは未確認 |
| 4 | `Button` の `hotkey` は、ペインがフォーカスを持っている間だけ効く(`ctrl+x tab`、クリック、`open({ focus })`)。`Client` にフォーカスがある間は、キーは `onKey` に行く | いまの `a`(Add to Claude)/ `p`(Paste)は、すでにキーで押せるが画面に出ていない。`Client` にフォーカスがある間の送信は、`onKey` 経由で作る |
| 5 | `Button` の `action` は、本体のキーバインドの action 名だけを受ける(未知の名前は拒否) | プロンプトにフォーカスがあるままのショートカットは、既存の action を借りる形しかない。上の表の「ペインを開くキー」と同じ調査になる |
| 6 | `$.ui.log` はトランスクリプトに dim の 1 行を足す(モデルには送られない)。`$.ui.copy` はクリップボードに書く | 送った内容の表示に `$.ui.log` が使える |
| 7 | `Text` に `inverse` / `backgroundColor` がある。カーソルは、すでに sidecar が反転ビットで画面に含めている | 選択のハイライトも同じ仕組みで、sidecar が画面に含められる |

方針:

- キーボードでの選択は「選択モード」(tmux の copy-mode に相当)として作る。キーは既存の `Client` の経路で受ける。
- 選択の状態(カーソル、始点、範囲)は sidecar が持つ。hooks モジュールは画面の状態を持たない、という決定に合わせる。ハイライトは sidecar がフレームの反転属性に含める。
- マウスでの選択(`$.ui.selection()`)と `/term-add` はそのまま残す。
- 技術的制約 3(`Client` が描いた領域は選択できない)には触れない。画面は hooks が `Text` 行で描いたまま。
- 自前の選択は `$.ui.selection()` を使わないので、tmux・非フルスクリーン(技術的制約 6)でも動く見込み。

進める順は Step A → B → C → D。A と B は小さく、互いに独立。D は C に依存する。

#### Step A — フォーカスの表示

対応する要望: 選択中のハイライト(Terminal にフォーカスが移ったことがわかるようにする)。

やること:

- 最初に確認する: `Client` がキーを持っている間、Escape で戻った後、トランスクリプトをクリックした後の、それぞれの `isFocused` の値
- `register.tsx`: `e.props.isFocused` を `Client` の props に渡す
- `keys.tsx`: 帯の表示を 2 状態にする。入力できる状態は目立つ色で `TERMINAL · typing here`、そうでない状態は今の `click here to type`。「入力できる」は、クリックかキーが来たら立て、`isFocused` が false になったら下ろす
- `/term` の出力行に、上端の帯をクリックしてから打つことを書く
- ペインのボタンに hotkey を出す(`a: Add to Claude`、`p: Paste prompt text`)

完了条件:

- 帯をクリックする前と後で、帯の見た目が変わる
- Escape でプロンプトへ戻ると、帯が元の表示に戻る
- 戻ったことを検知できない場合は、その事実を `docs/architecture.md` の技術的制約に記録し、分かる範囲(ペイン単位)の表示にとどめる

#### Step B — 送った Context の可視化

対応する要望: 送った Context の可視化。

やること:

- `shared/payload.ts`: 送った内容の要約を作る純関数(行数、文字数、cwd、先頭の数行。1 行は幅で切る)
- 追加に成功したら `$.ui.log` でトランスクリプトに出す。例:

  ```text
  Terminal → Claude: 3 lines, 142 chars (/home/user/project)
  │ Expected: 200
  │ Received: 500
  │ … +1 line
  ```

- `/term-add`、ボタン、Step D のキーのどれから追加しても、同じ表示にする
- ペインの状態の行に、直近の追加を短く出す(`added 3 lines`)

完了条件:

- 追加のたびに、何が渡ったかがトランスクリプトで読める
- 表示の行そのものは Claude に渡っていない(会話の記録 `.jsonl` で確かめる)
- 要約の単体テストが通る(複数行、全角、長い行、1 行だけ)
- `concept-mvp.md` §11 を、実際の表示に合わせて直す

#### Step C — キーボードでの選択(選択モード)

対応する要望: キーボードでの選択。選択範囲の反転表示は、要望の「選択中のハイライト」とは別で、選択モードに必要なものとして入れる。

やること:

- sidecar(`session.ts` / `server.ts`): 選択の状態を持つ。操作は `POST /select`(開始、移動、始点を置く、行単位の切り替え、取り消し)。範囲のテキストは `GET /selection` で返す
  - 位置は履歴も含めたバッファ上の行で持つ(スクロールしても、出力が増えても動かない)
  - テキストは、折り返された行をつなぎ、行末の空白を落とし、全角を 1 文字として扱う
  - カーソルが窓の外へ出たら、`back` を動かして追う
- `shared/protocol.ts`: `Frame` に選択モードの情報(有効か、行数、文字数)を足す。`PROTOCOL_VERSION` を上げる。選択範囲は反転、選択カーソルは下線つきの反転で `lines` に含める
- `shared/keys.ts`: 選択モード中のキーを操作に変える純関数
- `register.tsx`: 選択モードの間は、キーを PTY に送らず `/select` に送る。状態の行に `SELECT 3 lines, 142 chars · enter: add to Claude · q: cancel` を出す
- 入り方: `Client` にフォーカスがある状態でのキー(案は `alt+v`)と、ペインの `[ Select ]` ボタン

キーの割り当て(案):

| キー | 動作 |
| :- | :- |
| `alt+v` | 選択モードに入る。カーソルは Terminal のカーソル位置から |
| 矢印、`h` `j` `k` `l` | 1 文字・1 行の移動 |
| `0` / `$`、`home` / `end` | 行頭 / 行末 |
| `w` / `b` | 単語単位の移動 |
| `g` / `G`、`PageUp` / `PageDown` | 先頭 / 末尾、1 画面ぶん |
| `v`、`space` | 始点を置く(もう一度で外す) |
| `V` | 行単位の選択 |
| `enter` | 選択を Claude に渡して、モードを出る(Step D) |
| `q`、`ctrl+]` | 取り消してモードを出る |

完了条件:

- マウスを使わずに、`seq 1 1000` の後の履歴から 3 行を選択できる
- 選択範囲が反転表示され、キーを打っても消えない
- 全角を含む行、折り返された長い行で、取れるテキストが画面と一致する
- `vi` の画面(alternate screen)でも選択できる(Scenario 3)
- 選択モードの間に出力が増えても、選択した位置がずれない
- モジュールをリロードしても、選択モードが続く
- `bun test` が通る: 範囲のテキスト、移動、履歴が上限で削られたときの扱い

#### Step D — キーボードでの送信

対応する要望: キーボードでの送信。

やること:

- `addToClaude` を、テキストの出どころ(マウスの選択 / 選択モード)を引数で受ける形に分ける。ペイロードの生成と表示は共通
- 選択モードの `enter`: sidecar から範囲のテキストを取り、`$.session.append` で渡す
  - `ui.message` の dispatch の中で始めた呼び出しは中断されることがあるので、`Ops` に `append` / `toast` / `log` のクロージャを足して `$.clock.after(0, …)` から呼ぶ
  - 最初に確認する: `session.start` の `$` を閉じ込めた `append` が、後から呼べるか。呼べなければ、`ui.message` の hook の中で待つ形にする
- マウスで選択した後の送信キー: `Client` にフォーカスがある状態の `alt+a` で、`/term-add` と同じ処理を走らせる
- プロンプトにフォーカスがあるままのショートカット(`Button` の `action`)は、「ペインを開くキー」の調査と一緒に行う。借りられる action が無ければ、技術的制約に記録する

完了条件:

- 選択モードで選んで `enter` を押すと、Step B の表示が出て、次のプロンプトで Claude が内容を使う
- Claude の作業中でも同じ操作で渡せる
- 何も選んでいない `enter` は何も渡さず、そのことを伝える
- 選択モードに入っただけ、範囲を動かしただけでは、何も Claude に渡らない(会話の記録で確かめる)
- `claude plugin test` で、選択モードのキーが PTY に送られないことと、失敗時の表示を確認する

#### ユーザーが決めたこと(2026-10-05)

| # | 項目 | 決定 |
| :- | :- | :- |
| 1 | 「選択中のハイライト」の意味 | Terminal にフォーカスが移ったときに、それがわかるようにする(Step A) |
| 2 | 選択モードに入るキー | 当面 `alt+v`。使ってみて見直す |
| 3 | 選択モード中のキー | vi 風(上の表。矢印も使える) |
| 4 | 可視化の量 | 先頭 3 行 + 残りの行数 |
| 5 | クリップボードへのコピー(選択モードの `y` → `$.ui.copy`) | 今回は入れない。Phase 3 の「画面クリックで入力」で扱う |

#### 終わったら直す文書

- `docs/architecture.md`: Step A と Step D の「最初に確認する」の結果、通信プロトコルの表、分かった制約
- `CLAUDE.md`: 「決まっていること」のキーの割り当てと選択の持ち方、「現在の状態」
- `concept-mvp.md`: §10(選択後の操作)、§11(追加の表示)
- 本ファイルの「進み具合」

やらないと決めているもの(`concept-mvp.md` §2 の Non-goals): 複数 Terminal、タブ、履歴の永続化、Claude による Terminal の自動操作、出力の自動解析や要約。

---

## テストの分担

| 対象 | 手段 |
| :- | :- |
| `shared/` の純関数 | `bun test`(`*.spec.ts`) |
| sidecar(PTY、エミュレーション、HTTP) | `bun test`(`*.spec.ts`)。実際にシェルを起動する |
| hooks モジュールの振る舞い | `claude plugin test ./mod`。描画は検証しない |
| 実際の画面とキー、マウス | Phase 0 の検証ハーネス。入れ子の Claude Code を PTY で動かす |
| 見た目、操作感 | ユーザーが実機で確認する |

## リスク

| リスク | 影響 | 対応 |
| :- | :- | :- |
| ~~Bun の PTY が要件を満たさない~~ | 解消。Phase 1 Step 1 で成立を確認した | — |
| Mods API がリリースで変わる | 動かなくなる | 型定義を一次情報とし、更新のたびに validate とテストを回す |
| 実機(Ghostty)でキーの届き方が違う | 代替キーの見直し | Phase 1 Step 6 で確認する。届くキーが増える方向なら割り当てを減らせる |
| tmux や非フルスクリーンで選択が読めない | Phase 2 がその環境で使えない | 制約として記録し、その環境では原因を表示する |
| 打鍵の遅延が体感で大きい | Terminal として使いにくい | Phase 1 Step 6 で測る。long-poll の往復と描画のどちらが効いているかを切り分ける |
