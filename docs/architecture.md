# Architecture — Phase 0 Feasibility Spike の結果

- 実施日: 2026-10-05
- 環境: Claude Code v2.1.289 / Linux / bash / Python 3.14(Node.js は未導入)
- スパイクのコード: `spike/phase0/`(本実装ではない。sidecar は Python + pyte。Phase 1 で TypeScript + Bun に作り直す)

## 判定: Go

公式 Mods API だけで、対話型シェル・ペイン描画・選択・Claude への受け渡し・PTY の保持がすべて成立した。private implementation の patch も非公開 IPC も使っていない。

ただし **Escape / Ctrl+C / Ctrl+D / Ctrl+Z / Ctrl+X / ペースト は Mod に届かない**。代替キーを割り当てれば vi は操作できたが、`concept-mvp.md` §5 が Required とする「Ctrl+C / Ctrl+D / Ctrl+Z」を素のキーでは満たせない。ユーザーはこの制約を当面受け入れると決めた(2026-10-05)。

| # | 問い | 結果 |
| :- | :- | :- |
| 1 | sidecar + Unix ソケットで対話型シェルが動くか | 成立 |
| 2 | `Client` の `onKey` で vim が使えるか | 代替キーつきで成立 |
| 3 | 描画の速度と品質 | 成立。全角は `Raster` では不可、`Text` 行なら可 |
| 4 | `$.ui.selection()` でペイン内の選択が取れるか | 成立(`Client` が描いた領域は不可) |
| 5 | 受け渡し方式 | `$.session.append` が合う。`$.prompt.submit` は合わない |
| 6 | Hide とリロードをまたぐ PTY 保持 | 成立 |

## 検証方法と、その限界

入れ子の Claude Code(`claude --plugin-dir ./spike/phase0`)を PTY 上で起動し、キーとマウスのエスケープシーケンスを送り、画面を pyte で再現して読んだ(`spike/phase0/harness/drive.py`)。Mod 側は観測した事実を JSONL に記録した。

この方法で確認できていないこと:

- **人の目と手での確認をしていない。** 色の見え方、実際のマウス操作の感触、打鍵の体感遅延は未確認。
- **実際の端末(Ghostty)での挙動。** ハーネスは `TERM=xterm-256color` の素の PTY で、kitty keyboard protocol のネゴシエーションに応答していない。Ghostty では届くキーが変わる可能性がある。
- **tmux と非フルスクリーン表示。** Docs によれば `$.ui.selection()` は `undefined` になる。未検証。
- エディタは `vim.tiny`(`vi`)で確認した。フル機能の vim は未導入。
- 作業中(mid-turn)の `fill` / `submit` / `context` は未検証。作業中に確認したのは `append` だけ。
- `tsc` による型チェックは未実施(Node.js が無い)。`claude plugin validate` は通っている。

これらは Phase 1 の受け入れ確認(`docs/implementation-plan.md` の Phase 1 Step 6)で、ユーザーが実機で触って埋める。

## 構成

```text
Claude Code プロセス
└─ hooks モジュール (register.tsx)          DOM も Node も無い。外へは $ だけ
   ├─ $.process.run ──起動──▶ sidecar (daemon 化して子プロセスの寿命から離れる)
   ├─ $.http.fetch(socketPath) ◀─HTTP over Unix socket─▶ sidecar
   │     POST /input /resize /kill、GET /frame(long-poll)
   ├─ ui.render (Pane) ── 画面を Text 行 または Raster で描く
   ├─ $.ui.blit ───────── Raster を再レンダリングなしで書き換える
   └─ ui.message ◀─ surface.post ─ Client (keys.tsx): onKey でキーを受ける

sidecar: PTY + シェル + VT エミュレーション。画面の状態を持つのはここ
```

`concept-mvp.md` §15 は `$.process.spawn` でシェルを直接起動する図だったが、それでは成立しない(stdin が起動時の 1 回きりで、PTY も resize も無い)。PTY は sidecar が持つ。

## 1. プロセス: sidecar + Unix ソケット — 成立

`/term-selftest` を入れ子セッション内で実行した結果:

| 項目 | 結果 |
| :- | :- |
| 起動(`$.process.run` が返るまで) | 75〜118 ms |
| stdin(`echo MARK-$((6*7))` → `MARK-42`) | OK |
| resize(100×30 → `stty size` が `30 100`) | OK |
| Ctrl+C(`sleep 100` に `\x03` → `rc=130`) | OK |
| Ctrl+D(`cat` に `\x04` → 終了コード 0) | OK |
| Ctrl+Z(`\x1a` → `Stopped`) | OK |
| 大量出力(`seq 1 200000`、1.49 MB) | 2.0 秒で末尾まで到達 |
| `/kill` 後 | ソケットが消え、fetch は `ENOENT` |

シグナルは PTY の line discipline に制御文字を書くだけで届く。専用のシグナル API は要らない。

設計上の事実:

- sidecar は double fork + `setsid` で daemon 化する。`$.process.run` は親がすぐ終了するので待たされない。`$.process.spawn` の子はモジュールのリロードで kill されるため、使わない。
- 出力は `GET /frame?since=<ver>&wait=<ms>` の long-poll で読む。`$.http.fetch` はボディを読み切ってから解決するので、ストリーミングはできない。
- `socketPath` は絶対パスで 100 バイト前後まで。`$XDG_RUNTIME_DIR/cc-term/<pid>.sock` を使った。
- **ソケット名に session id を使ってはいけない。** `/clear` で session id が変わり、その後 `session.start` も来ない。Claude Code 本体の PID(`$.process.run(['sh','-c','echo $PPID'])`)はプロセスの寿命のあいだ安定している。
- sidecar は起動時の親 PID(= Claude Code)を監視し、消えたらシェルごと終了する。`kill -9` で確認した。

## 2. キー入力 — 代替キーつきで成立

`Client` をクリックしてフォーカスを与えた状態で、1 キーずつ送って届くかを調べた。

**届く:** 文字、`space`、`return`、`tab`、`shift+tab`、`backspace`、`delete`、矢印、`home` / `end`、`pageup` / `pagedown`、修飾つき矢印(`ctrl+right`、`shift+up`)、`alt+<文字>`、
Ctrl+ A B E F G K L N O P Q R S T U V W Y、`ctrl+\`、`ctrl+]`、`ctrl+^`、`ctrl+_`

**届かない(Claude Code 本体が処理する):**

| キー | 起きること |
| :- | :- |
| Escape、`ctrl+[` | フォーカスがプロンプトへ戻る。kitty 形式(`CSI 27u`、`CSI 91;5u`)で送っても同じ |
| Ctrl+C | フォーカスを失う。kitty 形式でも同じ |
| Ctrl+D | フォーカスを失う |
| Ctrl+X | フォーカスを失う(コードの先頭キー) |
| Ctrl+Z | **Claude Code 自体がサスペンドする** |
| ブラケットペースト | フォーカスは保つが、テキストはプロンプト欄に入る |

**届き方に癖があるもの:**

- `alt+b` は `{ key: 'left', meta: true }` になる(本体が単語移動に正規化している)。
- `ctrl+space` はバッククォートの `ctrl` つき(``{ key: '`', ctrl: true }``)、`ctrl+j` は `{ key: '\n' }` になる。
- `insert` とファンクションキーは `key` に生のエスケープシーケンス(`\x1b[2~`、`\x1bOP`)が入る。
- 一度に書かれた複数文字は 1 つのキーイベントにまとまって届く。

スパイクでは `ctrl+]` → Escape、`alt+c` / `alt+d` / `alt+z` / `alt+x` → Ctrl+C / D / Z / X と割り当てた。これで `vi` の挿入、Escape、カーソル移動(`k` `0` `x` `A`)、`:wq` が動き、全角文字を含むファイルが保存できた。

注意点:

- **制御文字を含む文字列を `Text` に入れると tree が拒否され、`Client` は unmount される。** 生のエスケープシーケンスで届くキーをそのまま表示して踏んだ。表示前に必ずエスケープする。
- `surface.post` は 1 フレーム 1 件で後勝ち。キーに連番を振り、hooks 側の ack(`ui.message` の戻り値 `{ props }`)が来るまで未送達分をまとめて再送する。この方式で取りこぼしは観測していない。
- `Client` はクリックしないとキーを受けない。ペインを `focus: true` で開いてもペインの Button にフォーカスが行くだけ。`$.ui.focus({ requestId, key })` で `Client` へ移せるかは未検証。
- **プロンプトにフォーカスがある状態で Claude の作業中に Escape を押すと、ターンが中断される。** vim の癖で Escape を連打すると Claude を止めてしまう。`Client` にフォーカスがある間の 1 回目はフォーカスが戻るだけで、中断はされなかった。

## 3. 描画 — 成立

3 つの方式を試した。

| 方式 | 全角文字 | 選択 | 更新経路 |
| :- | :- | :- | :- |
| `Raster` + `$.ui.blit` | 置けない(`□` で代用) | 取れるが全角は `□` になる | blit。レンダリングなし |
| hooks が描く `Text` 行 | 正しく出る | 正しく取れる | `$.ui.invalidate` → `ui.render` |
| `Client` が描く `Text` 行 | 正しく出る | **取れない** | `ui.message` の `{ props }` |

大量出力(`seq 1 300000`、2.3 MB、80×41):

| 方式 | 完了まで | 更新回数 |
| :- | :- | :- |
| `Raster` | 3.3 秒 | blit 145 回。1 回平均 0.7 ms、最大 5 ms |
| `Text` 行 | 3.4 秒 | 172 フレーム → 再描画は約 114 回に畳まれた |

どちらも UI は固まらず、直後にコマンドを受け付けた。long-poll は「前のフレームを描き終えてから次を取りに行く」ので、そのまま backpressure になる。sidecar 側の画面エンコードは 1 フレーム 1.6〜2.3 ms。

設計上の事実:

- `Client` の要素表には `Raster` が無いので、キー入力の領域と `Raster` は別の要素になる。スパイクでは 1 行の `Client`(クリックして入力を始める帯)の下に画面を置いた。
- ペインの配置は幅で決まる。180 列ではトランスクリプトの右に dock(本体 80 列)、100 列ではプロンプトの上に inline。
- **inline のペインは中身の高さに合わせて伸びる。** `bodyRows` から端末の行数を決めると循環する。inline では行数を固定する。36 行の端末では見える高さが 10 行ほどで、それを超える分はペイン内スクロールになる。
- プロンプト欄が複数行になる、許可ダイアログが出る、といった本体側の変化でペインの高さが変わる。そのたびに resize が走るので、debounce が要る。
- **`ui.render` の dispatch 内から始めた `$` 呼び出しは、次の再描画で `ui.render: superseded` として中断される。** resize などの副作用は `$.clock.after(0, …)` で dispatch の外へ出す。

## 4. 選択 — 成立

ペイン内をマウスでドラッグし、`/term-add` で `$.ui.selection()` を読んだ。

- `Text` 行: `"Expected: 200\nReceived: 500"` が取れた。全角も `"日本語テスト abc"`、部分選択 `"本語テス"` まで正しい。
- `Raster`: 取れるが、全角文字は代用の `□` になる。
- `Client` が描いた領域: `undefined`。ドラッグは `Client` にフォーカスを与えるだけで、選択にならない。
- ペイン内から始めた選択はペイン内に収まる。トランスクリプト側から始めてペインにまたがると、境界線ごと矩形で取れてしまう。
- 選択後に Escape を押しても選択は残る。`immediate: true` のコマンドなら Claude の作業中でも読める。

選択機能の自作は不要。

## 5. Claude への受け渡し — `$.session.append` を使う

| 方式 | アイドル時 | 作業中 |
| :- | :- | :- |
| `$.session.append` | 行が追加される。ターンは始まらない。次のプロンプトで Claude が内容を答えた | ツール実行中に追加した行を、**同じターンの次のリクエストで** Claude が読んだ |
| `prompt.submit` hook の `context` | 次にユーザーが送ったプロンプトに添付された(6 件まとめて確認) | 未検証 |
| `$.prompt.fill` | プロンプト欄に下書きとして入った | 未検証 |
| `$.prompt.submit` | **即座に新しいターンが始まり**、Claude が応答した | 未検証(Docs ではアイドルまで待つ) |

「選択して Context に追加し、あとで自分の言葉で指示する」(§20 Scenario 2)に合うのは `append`。ユーザーには見えない行なので、`$.ui.toast` とコマンドの出力行で追加を知らせる。

`$.prompt.submit` は合わない。追加した瞬間にターンが始まる。加えて、`command.run` の hook から直接呼ぶと拒否される(`called from a command.run hook, it would wait on the turn this hook is holding`)。

ペイロードの `Working directory` は、スパイクでは Claude Code の cwd を入れた。シェルで `cd` した後は実際の cwd とずれる。sidecar が `/proc/<shell pid>/cwd` を返せば正確になる。

## 6. PTY の保持 — 成立

- **Hide:** `$.ui.close` → `/term` で開き直すと、同じシェル(環境変数、cwd、バックグラウンドジョブ)が続いていた。
- **モジュールのリロード:** ファイル保存でリロード → `session.start` が再度走り、同じソケットに再接続。sidecar の PID もシェルの状態も同じ。ペインは開いたまま。
- **`/clear`:** `session.end`(`reason: 'clear'`)が来る。ここで kill してはいけない。
- **終了:** `/exit` で `session.end`(`reason: 'prompt_input_exit'`)→ `/kill`。sidecar は残らなかった。
- **異常終了:** Claude Code を `kill -9` → 監視が検知して sidecar も終了。
- **sidecar の異常終了:** `kill -9` → ペインに「Terminal process disconnected」を表示。Claude Code のセッションは継続し、`/term` で新しいシェルに再接続できた(AC-10)。

リロード直後は `session.start` の完了より先に `ui.render` が走ることがある。初期化前の状態で描画しても壊れないようにする。

## 技術的制約(公式 API では回避できないもの)

1. Escape / Ctrl+C / Ctrl+D / Ctrl+Z / Ctrl+X は Mod に届かない。代替キーが必須。
2. ペーストは `Client` に届かない。代替は未検討(クリップボードを sidecar 側で読む、など)。
3. `Client` 内では `Raster` が使えず、`Client` が描いた領域はネイティブの選択対象にならない。「画面をクリックしてそのまま入力」と「ドラッグで選択」を同じ領域で両立できない。
4. `Raster` は幅 1 の BMP 文字だけ。全角・絵文字を出すなら `Text` 行で描く。
5. `$` は変数に保存も、関数に渡すこともできない(`claude plugin validate` が拒否する)。dispatch をまたぐ処理は、`session.start` の `$` を閉じ込めたクロージャの束を持って呼ぶ。
6. フルスクリーン表示でないと選択が読めない(Docs。未検証)。

## Phase 1 への決定事項

実装の手順は `docs/implementation-plan.md`。

Phase 0 の結果から決めたこと:

- Mod の配置は `mod/`、プラグイン名は `terminal`。`spike/phase0/` は参照用に残す。
- PTY と VT エミュレーションは sidecar が持つ。hooks モジュールは画面の状態を持たない(リロードで失われるため)。
- 通信は Unix ソケット上の HTTP。出力は long-poll。ソケット名は Claude Code の PID。
- 画面は hooks モジュールが `Text` 行で描く。キーは 1 行の `Client` で受ける。
- 受け渡しは `$.session.append`。コマンドは `immediate: true`。
- `session.end` は `reason` が `clear` 以外のときだけ sidecar を止める。

ユーザーが決めたこと(2026-10-05):

- **キー入力の制約は当面受け入れる。** 割り当てはスパイクのまま、`ctrl+]` = Escape、`alt+c` / `alt+d` / `alt+z` / `alt+x` = Ctrl+C / D / Z / X。使ってみて見直す。
- **sidecar は TypeScript + Bun で書く。**

### sidecar: TypeScript + Bun

| 役割 | 使うもの |
| :- | :- |
| PTY | Bun 組み込みの PTY 対応(`Bun.spawn` の `terminal` オプション) |
| VT エミュレーション | `@xterm/headless`(xterm.js の画面なし版) |
| HTTP サーバ | `Bun.serve({ unix: path })` |
| 配布 | `bun build --compile` の単一バイナリを Mod に同梱 |

選んだ理由:

- `@xterm/headless` は、スパイクで pyte に足りなかった alternate screen、全角文字、resize 時の内容保持、scrollback を持つ。
- PTY が組み込みなので、`node-pty` のようなネイティブアドオンのビルドが要らない。
- 単一バイナリにすれば、利用者に Bun も Node.js も要求しない。
- hooks モジュールと同じ言語なので、通信プロトコルの型を 1 か所(`mod/shared/protocol.ts`)に書ける。

**未確認:** Phase 0 の環境には Bun も Node.js も無く、Bun の PTY はまだ動かしていない。resize、制御文字によるシグナル、daemon 化(親プロセスから切り離して `$.process.run` をすぐ返す)が期待どおりかを Phase 1 の Step 1 で確かめる。満たさなければ Node.js + `node-pty` に切り替える。その場合も `@xterm/headless` と通信部分はそのまま使える。

Phase 1 で解くこと:

- Bun の PTY の確認(上記)。
- `$.ui.focus` で `Client` にフォーカスを移せるか(クリックなしで入力を始められるか)。
- ペーストの代替経路。
- scrollback の見せ方(`@xterm/headless` が保持する。ペインでどうスクロールさせるかは未定)。
- resize の debounce。
- Ghostty の実機、tmux、非フルスクリーンでの確認。

## スパイクの動かし方

```bash
claude --plugin-dir ./spike/phase0
```

| コマンド | 動作 |
| :- | :- |
| `/term [raster\|text\|client]` | ペインを開く。上端の帯をクリックしてから入力する |
| `/term-hide` | ペインを閉じる(PTY は残る) |
| `/term-add [append\|fill\|submit\|context]` | 選択テキストを Claude に渡す |
| `/term-selftest` | sidecar の自己診断 |
| `/term-stats` | 描画の統計をログに出す |

ログは `$XDG_RUNTIME_DIR/cc-term/spike-log.jsonl`(`CC_TERM_SPIKE_LOG` で変更可)。sidecar は `python3` が必要で、pyte と wcwidth を `sidecar/vendor/` に同梱している。
