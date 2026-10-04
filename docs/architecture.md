# Architecture

構成と、実機で確認した API の挙動。前半は Phase 0(Feasibility Spike)の結果、後半の「Phase 1・2 で確認したこと」は本実装(`mod/`)で分かったこと。食い違う場合は後半が新しい。

## Phase 0 Feasibility Spike の結果

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
2. ペーストは `Client` に届かない(プロンプト欄に入る)。下書きを Terminal へ送るボタンを Phase 1 Step 4 で作ったが、2026-10-05 に削除した。いまはペーストの手段が無い。
3. `Client` 内では `Raster` が使えず、`Client` が描いた領域はネイティブの選択対象にならない。「画面をクリックしてそのまま入力」と「ドラッグで選択」を同じ領域で両立できない。
4. `Raster` は幅 1 の BMP 文字だけ。全角・絵文字を出すなら `Text` 行で描く。
5. `$` は変数に保存も、関数に渡すこともできない(`claude plugin validate` が拒否する)。dispatch をまたぐ処理は、`session.start` の `$` を閉じ込めたクロージャの束を持って呼ぶ。
6. フルスクリーン表示でないと選択が読めない(Docs。未検証)。
7. `Client` へのフォーカスは、クリックでしか移せない。`$.ui.focus` が受け付けるのは `Button` / `Input` / `Select` だけ(Phase 1 Step 4)。`ctrl+x tab` の後の Tab / Enter でも移らない。キーボードだけで届くのは `Input`(1 行ずつ)まで。
8. `Text` の色は「テーマのキー、色の名前、hex」だけ。端末の ANSI 16 色をそのまま指定する手段が無く、`red` などの名前は Claude Code 側の RGB に置き換わる。Terminal の 16 色は、ユーザーの端末の配色どおりにはならない(Phase 1 Step 3)。
9. `Client` がキーボードのフォーカスを得た・失ったことを知る API が無い。`Pane` の `isFocused` は、`Client` がキーを受けている間も false のまま。Escape やペインの外のクリックでフォーカスを失っても、Mod には何も届かない(改善要望への対応 Step A)。

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

Phase 1 で解くこと(結果は「Phase 1・2 で確認したこと」):

- Bun の PTY の確認 → 成立。
- `$.ui.focus` で `Client` にフォーカスを移せるか → 移せない。クリックが要る。
- ペーストの代替経路 → プロンプト欄の下書きを送るボタン。
- scrollback の見せ方 → sidecar 側で窓を動かす。
- resize の debounce → 120 ms。
- Ghostty の実機、tmux、非フルスクリーンでの確認 → 未実施(ユーザーの確認待ち)。

## Phase 1・2 で確認したこと

- 実施日: 2026-10-05
- 環境: Claude Code v2.1.289 / Linux / bash / Bun 1.4.2(Workshop 内)/ `@xterm/headless` 6.0.0
- 検証方法は Phase 0 と同じ(入れ子の Claude Code を `spike/phase0/harness/drive.py` で操作)。したがって「検証方法と、その限界」に挙げた点(人の目と手、Ghostty の実機、tmux、非フルスクリーン)は、ここでも未確認のまま。

### sidecar: Bun で成立(Node.js への切り替えは不要)

`spike/phase1/pty-check.ts` を `bun build --compile` したバイナリを、ホストで実行した結果。Phase 0 の `/term-selftest` と同じ項目。

| 項目 | 結果 |
| :- | :- |
| 起動コマンドが返るまで | 36〜42 ms |
| stdin(`echo MARK-$((6*7))` → `MARK-42`) | OK |
| resize(100×30 → `stty size` が `30 100`) | OK |
| Ctrl+C / Ctrl+D / Ctrl+Z(制御文字を書くだけ) | OK(`rc=130` / `eof=0` / `Stopped`) |
| 大量出力(`seq 1 200000`、1.49 MB) | 0.13 秒で末尾まで到達 |
| `vi` を起動して終了 | alternate screen に入り、終了後に元の画面へ戻る |
| 全角 | 幅 2 のセル + 幅 0 のセルとして取れる |
| 色 | パレット番号と RGB を区別して取れる |
| resize 後の画面内容 | 残る |
| `/kill` 後 | ソケットもシェルも残らない |

設計上の事実:

- **Bun には `fork` が無い。** daemon 化は、起動コマンド(`terminal-sidecar start`)が自分自身を `Bun.spawn(..., { detached: true, stdio: ['ignore', log, log] })` で `daemon` モードとして起動し、ソケットが `/info` に応答するのを待って 1 行の JSON を出して終了する形にした。daemon は新しいセッションのリーダーになり、起動元の stdout の pipe を持たないので、`$.process.run` はすぐ返る。
- コンパイル済みバイナリの中では `Bun.main` が `/$bunfs/` で始まる。自分自身の再実行は、そのとき `process.execPath` だけ、`bun main.ts` のときは `process.execPath` + `Bun.main`。
- **`Bun.serve` の `idleTimeout` は既定で 10 秒。** long-poll(20 秒)が切られるので 60 にしている。Bun 1.4.2 の型は unix ソケットでこのオプションを受け付けないが、実行時には効く(`sidecar.spec.ts` で 12 秒の long-poll を確認)。
- シェルは PTY のセッションリーダーなので、`process.kill(-shellPid, 'SIGHUP')` でフォアグラウンドのジョブごと止まる。
- カーソルの表示・非表示は `@xterm/headless` の公開 API に無い。内部の `_core.coreService.isCursorHidden` を読んでいる(無ければ「表示」として扱う)。
- `@xterm/headless` の文字幅は Unicode 6 相当。絵文字など、それ以降に幅が変わった文字の位置は未確認。
- バイナリは約 81 MB(Bun のランタイムを含む)。`mod/bin/` は git に入れない。

### 通信プロトコル

型は `mod/shared/protocol.ts`。

| リクエスト | 内容 |
| :- | :- |
| `GET /frame?since=<ver>&wait=<ms>&back=<lines>` | 画面。`since` より新しくなるか `wait` が過ぎるまで待つ。変化が無ければ `lines` を省く。`back` は末尾からさかのぼる行数 |
| `GET /info` | PID、シェルの PID、生死、大きさ、シェルの現在の cwd(`/proc/<pid>/cwd`。取れなければ `null`) |
| `POST /input` `{ d }` | PTY へ書く |
| `POST /resize` `{ cols, rows }` | 大きさを変える |
| `POST /select` `{ op, back }` | 選択モードの操作(開始、移動、始点、取り消し)。選択カーソルが見える `back` を返す |
| `GET /selection` | 選択範囲のテキスト。選択モードでなければ `null`、始点を置いていなければ空文字列 |
| `POST /kill` | シェルを止めて終了する |

画面は、行ごとの `[テキスト, 前景色, 背景色, 属性ビット]` の並び。色は `null`(既定)、0〜15(ANSI パレットの番号)、`'#rrggbb'`。カーソル位置のセルは sidecar が反転ビットを立てて返すので、hooks モジュールはカーソルを意識しない。制御文字は sidecar が空白に置き換える。

- ソケットは `$XDG_RUNTIME_DIR/cc-term/<Claude Code の PID>.sock`(無ければ `/tmp/cc-term-<uid>/`)。ディレクトリは 0700、ソケットは 0600。他人が所有するディレクトリは使わない。
- 同じソケットで生きたシェルが動いていれば、起動せずに `already: true` を返す。シェルが終了した sidecar が残っていれば、止めて作り直す。
- sidecar のログは `<ソケット>.log`。正常終了時に消す。

### hooks モジュール

- **`Text` の `color` に `ansi:red` を渡すと tree が拒否された**(`Text prop "color" must be a color (a theme key, a name, or hex)`)。`red`、`blueBright` などの名前は通るが、出力されるのは `38;2;r;g;b` の RGB で、端末の ANSI 色ではない(技術的制約 8)。
- **inline のペインの `bodyRows` は「中身の高さ」と「レイアウトが許す高さ」の小さいほう。** 中身を `bodyRows` に合わせると、いったん低くなったあと戻らない(リロード直後の 1 行の表示をきっかけに 3 行まで縮んだ)。外側の `Box` に `minHeight`(頼んだ行数)を付けて中身の高さを保ち、Terminal の行数だけを `bodyRows` に合わせると安定した。40 行の端末では Terminal は 9 行になる。
- 窓からはみ出した下の余白が見えないのは、`ui.scroll` の hook が窓を動かさないため。
- **dispatch の中で始めた `$` 呼び出しを避けるため、入力の送信と画面の取り直しは `$.clock.after(0, …)` で外へ出している。** `ui.message` の hook は ack をすぐ返し、PTY への書き込みは 1 本の送信ループが順に行う(並行した POST の到着順は保証されないため)。
- キーの連番は `Client` のインスタンスごと。インスタンスが作り直されると 1 に戻るので、`Client` が自分の id を一緒に送り、hooks 側は id が変わったら連番を数え直す。
- sidecar のバイナリが無いときは `$.process.run` が `ENOENT` で失敗し、ペインに `Failed to start shell.` と理由、`[ Retry ]` が出る。Claude Code のセッションは続く。

### キー入力(Step 4)

- `vi` でファイルを編集して保存できた(挿入、`ctrl+]` で Escape、`:wq`。全角を含む)。`less`、`top` を操作して終了できた。
- `sleep 100` を `alt+c` で止められた(`rc=130`)。
- 4 ms 間隔で 42 文字を打って、抜けも順序の入れ替わりも無かった。
- **`$.ui.focus({ requestId, key })` では `Client` にフォーカスを移せない。** 数秒待ったあと `{ deny: 'no element of its own is drawn under that key' }` が返る。型定義も、対象を `Button` / `Input` / `Select` としている。`/term` の直後はプロンプトにフォーカスが残るので、帯をクリックしてから打つ(技術的制約 7)。待ちのあいだ `/term` が返らなくなるので、呼ばない。
- **ペーストの代替:** ペインの `[ Paste prompt text ]` ボタン。端末でペーストするとテキストはプロンプト欄に入る。ボタンを押すと `$.prompt.read()` で下書きを読み、PTY へ書き、`$.prompt.fill({ text: '' })` で欄を空にする。アプリが bracketed paste を有効にしていれば `ESC [200~` 〜 `ESC [201~` で括る。クリップボードを直接読む方式(`wl-paste` など外部コマンドが要る)は採らなかった。
- DECCKM(`vi` などが有効にする)のあいだ、矢印キーは `ESC O A` 形式で送る。フレームに `appCursor` を含めている。
- `alt+b` / `alt+f` は `left` / `right` + `meta` として届くので、`ESC b` / `ESC f` に戻して送る(本物の alt+矢印と区別できない)。

### scrollback(Step 5)

- 履歴は sidecar(`@xterm/headless`)が持つ。上限は 5000 行。
- 見せ方は「sidecar 側で窓を動かす」方式。`/frame` の `back` に、末尾からさかのぼる行数を渡す。ペインに描くのは常に 1 画面ぶんなので、履歴が長くても描画量は変わらない。
- 操作: ペインの上でホイール(`ui.scroll` の hook が `by` を受け取る)、または `shift+PageUp` / `shift+PageDown`(`Client` にフォーカスがあるとき)。
- さかのぼっている間に出力が増えても、見ている位置を保つ(履歴が増えたぶん `back` を足す)。キーを打つと末尾へ戻る。
- alternate screen のあいだは履歴が無い(`back` は 0 になる)。
- `seq 1 1000` の後、先頭の `1` までさかのぼれ、その位置でドラッグした選択を `$.ui.selection()` で読めた。

### Context Bridge(Phase 2)

- `/term-add` と、ペインの `[ Add to Claude ]` ボタン。どちらも同じ処理。
- ペイロードの `Working directory` は、追加の時点で sidecar に問い合わせたシェルの cwd。`cd /tmp` の後の追加が `/tmp` になった。取れなければ行ごと出さない。
- **アイドル時:** 追加してもターンは始まらず、次のプロンプトで Claude が中身(「空行、3、4」)を答えた。
- **作業中:** `sleep 20` のツール実行中に追加した `MIDTURN-MARK-7781` を、同じターンの応答で Claude が報告した。
- 記録(`~/.claude/projects/.../<session>.jsonl`)には、`origin: { kind: 'plugin', name: 'terminal' }`、`isMeta: true` の user 行として残る。Terminal で実行しただけで選択していない出力(`SECRET-NOT-4242-SHARED`)は、記録に現れなかった。
- 選択が会話側(`selected.requestId` がある)なら、Terminal の内容ではないので追加しない。
- **選択は、追加した後も残る。** 続けて `/term-add` すると同じ内容がもう一度追加される。
- 表示の 4 通り: 成功は toast とコマンドの出力行、選択なし・追加の失敗・選択が読めない環境はそれぞれ理由の 1 行(ボタンからは toast)。「選択が読めない環境」の文言は Docs に基づくもので、実機では出していない。
- `/clear` の後は、追加した行も会話ごと無くなる(シェルは残る)。compaction の後の扱いは未確認。

### 改善要望への対応(2026-10-05)

`docs/implementation-plan.md` の「改善要望への対応計画」Step A〜D。検証方法はこれまでと同じ(入れ子の Claude Code を検証ハーネスで操作)。ハーネスは文字の属性を見ないので、反転や色の見え方は未確認。

フォーカスの表示(Step A):

- **`Pane` の `isFocused` は、`Client` がキーを受けている間も false。** true になるのは、`ctrl+x tab` か、ペインの中身(Terminal の行やボタン)のクリックで、ペインの枠がキーボードを持ったとき。そのとき打った文字はプロンプト欄に入る。
- 帯のクリック、`Client` へのキー、Escape のどれでも `ui.focus` は来ない。
- そこで、hooks モジュールが「帯がキーを受けている」を推定して、帯の表示を変える。立てる: 帯のクリック(`onPointer` の `down` を `post` する)と、キーの到着。下ろす: `prompt.edit`(プロンプト欄にキーが入った)、`isFocused` が true、ペインを閉じた。
- **Escape やトランスクリプトのクリックでフォーカスを失った直後は、検知できない。** 次にプロンプト欄へ 1 文字入った時点で、帯が元の表示に戻る(技術的制約 9)。
- モジュールのリロードで `Client` は作り直され、フォーカスを失う(キーはプロンプト欄へ行く)。開発中だけ起きる。

選択モード(Step C):

- 状態(選択カーソル、始点、行単位かどうか)は sidecar が持つ。位置はバッファ上の行で、通常の画面では `registerMarker` で追うので、出力が増えても、履歴が上限で削られてもずれない。alternate screen には履歴が無いので、行番号のまま持つ。画面が切り替わると(vi の起動・終了)選択モードは終わる。
- ハイライトは sidecar がフレームに含める。選択範囲は反転ビット、選択カーソルは前景 0・背景 3(ANSI の番号)。選択モードの間、Terminal のカーソルは出さない。hooks モジュールは選択範囲を知らない。
- hooks モジュールが覚えるのは「キーをどちらへ送るか」の 1 ビットだけ。フレームの `select` の有無で合わせ直すので、リロードの後も選択モードが続く。
- テキストは、折り返された行をつなぎ、行末の空白を落とす。**`translateToString(true)` が落とすのは、書かれていないセルだけ。** vim は行末まで空白を書くので、行ごとに `trimEnd` している。
- 選択カーソルが窓の外へ出たら、`/select` の応答の `back` に合わせて窓を動かす。
- `[ Select ]` ボタンは作らなかった。ボタンを押すとペインの枠がフォーカスを持ち、キーが `Client` に届かないため。入り口は `alt+v` だけ。
- `$.ui.selection()` を使わないので、非フルスクリーンでも動く見込み(未確認)。

キーボードでの送信(Step D):

- **`session.start` の `$` を閉じ込めた `$.session.append` / `$.ui.toast` / `$.ui.log` / `$.ui.selection` は、後から(`$.clock.after` のコールバックから)呼べる。** `$.http.fetch` と同じ。選択モードの `enter` と `alt+a` は、この経路で渡している。
- PTY への書き込み、選択の操作、送信は、同じ 1 本のループで順に処理する(打った順を保つため)。
- 追加に失敗したら、選択を残す(やり直せるように)。
- 入れ子のセッションで 5 回渡し、次のプロンプトで Claude が 4 件の中身を正しく挙げた(全角を含む)。

送った Context の可視化(Step B):

- **`$.ui.log` は改行を出せない。** 改行を含む文字列は 1 行にまとめられ、改行の位置に `�` が出た。行ごとに呼ぶと、行のあいだに空行が入って場所を取る。見出しと先頭の 3 行を ` │ ` でつないだ 1 行にした。
- 記録(`.jsonl`)では、`$.ui.log` の行は `type: 'system'`、`subtype: 'informational'`。ペイロードの行(`type: 'user'`、`isMeta: true`、`origin.kind: 'plugin'`)とは別で、モデルには送られない。

### キーボードでの切り替えとコマンド行(2026-10-05)

要望は「Claude Code と Terminal の切り替えをショートカットで行う」と「`a: Add to Claude` / `p: Paste prompt text` の使い方がわからない(`p` を押すと Terminal に入力された)」。プローブ用の Mod と検証ハーネスで確認した。

- **`Client` にキーボードだけでフォーカスを移す手段は無い。** `ctrl+x tab` でペインの枠にフォーカスを移した後、Tab と Enter を押しても `Client` には届かない(リングは `Button` と本体の閉じるマークを巡る)。技術的制約 7 のとおり。
- **ペインの枠がフォーカスを持っている間に打った文字は、プロンプト欄に入り、その時点でペインはフォーカスを失う。** `prompt.edit` の hook でキーを消費(`{ text: e.text, cursor: e.cursor }` を返す)できるが、1 文字目で `isFocused` が false に戻る。プロンプト欄のキーを Terminal へ転送する方式は成立しない。
- **`Input` は `autoFocus` でキーを受ける。** `$.ui.open({ focus: true })` と `ctrl+x tab` のどちらでも、リングが `Input` に乗り、文字・空白・Backspace が `onInput`、Enter が `onSubmit` に届く。Escape でプロンプトへ戻り、`ctrl+x tab` で戻ると、打ちかけのテキストは残っている。submit の後、欄は空になる。
- `Input` に届かないキー: Tab と上下の矢印(リングが動く)、Ctrl / Alt つきのキー。左右の矢印は欄の中のカーソル移動。
- `Button` の `action="app:toggleTerminal"`(既定は `meta+j`)は validate を通るが、プロンプトから `alt+j` を押してもボタンは押されなかった。使っていない。
- そこで、ペインにコマンド行(`Input`、key は `line`)を置いた。Enter で「その行 + `\r`」を PTY へ送る。空の Enter は `\r` だけを送る。切り替えは本体のキーで行う: `/term` か `ctrl+x tab` で Terminal(コマンド行)、Escape で Claude。`ctrl+x tab` は本体の `abovePrompt:focus` で、`~/.claude/keybindings.json` で変えられる。
- コマンド行は 1 行ずつ送るだけ。`vi`、Ctrl+C、Tab 補完、履歴(上矢印)は、これまでどおり帯をクリックして使う。
- **`hotkey` は外した。** `hotkey` が効くのは「ペインの枠がフォーカスを持ち、リングが `Input` に無い」間だけ。帯(`Client`)がキーを受けている間は PTY に行き、コマンド行がキーを受けている間は欄に入る。`a:` / `p:` の表示は、押せない場面のほうが多かった。ボタンは `[ Add to Claude ]` / `[ Paste prompt text ]` として残す(クリック、または Tab で選んで Enter)。キーボードで渡すのは `alt+a` と選択モード。
- **上端の帯は無くした(見栄えのため)。** `Client` は下の行の左端に移し、`[ All keys ]` と出す(クリックでキーを受ける。受けている間は `TERMINAL · alt+h: help`、選択モードでは `SELECT`)。`Client` を `Button` と同じ `Box` の行に並べても、クリックでキーを受けた。画面の上下の行数は 2(コマンド行と、ボタンの行)。
- **ヘルプ:** 帯に出していたキーの説明は、ペインのヘルプに移した。Terminal の行の代わりに `HELP_LINES`(`mod/shared/keys.ts`)を描く。開くのは `alt+h`(`Client` がキーを受けている間。`{ key: 'h', meta: true }` で届いた)、コマンド行の `?` + Enter、`[ Help ]` ボタン。どのキーでも閉じ、そのキーは PTY に送らない。
- 検証ハーネスで確認: `/term` の直後にクリックなしで `echo KBD-$((40+2))` を打って `KBD-42` が出た。Escape → `ctrl+x tab` → `pwd`、Escape → `/term` → `echo AGAIN`、`[ All keys ]` をクリックして `echo RAW`、のどれも Terminal に届いた。`alt+h` と `?` でヘルプが出て、次のキー(`x`)で閉じ、`x` はシェルに入らなかった。

### 下の行の整理(2026-10-05)

上の「キーボードでの切り替えとコマンド行」を使ってみた後の、ユーザーの判断。

- **コマンド行(`Input`)は外した。** ショートカットでの切り替えは、いったん見送る。入力の入り口が 2 つあるのが分かりにくく、コマンド行でできることは少なかった(補完、履歴、中断ができない)。上に書いた `Input` の挙動は、再開するときの材料として残す。
- **`[ All keys ]` は `[ Terminal input ]` に改名した。** 入力は、これをクリックして始める。Terminal の画面のクリックで入力にする方式(画面全体を `Client` に描かせる)は、標準のマウス選択が使えなくなるので採らなかった(技術的制約 3)。選択を自作する案は、Phase 3 の「画面クリックで入力」に残っている。
- **`[ Paste prompt text ]` は削除した**(用途が無いとの判断)。`pasteBytes` も消した。ペーストを Terminal に届ける手段は、いまは無い(技術的制約 2)。フレームの `bracketedPaste` は sidecar に残っているが、使っていない。
- ヘルプを開くのは `alt+h` と `[ Help ]`。コマンド行の `?` は無くなった。
- 下の行は `[ Terminal input ] [ Add to Claude ] [ Help ]` と状態。画面の下に置く行数は 1。
- **クリックしやすくした。** `Client` に `flexGrow={1}` を付け、下の行のうちボタン以外をすべて `Client` の領域にした。状態の表示(画面の大きさ、履歴、選択の範囲)は `Client` が props で受けて描き、右端まで空白で埋める。見出しの外の空いた場所をクリックしても、キーを受けた。ボタンは右端に寄せ、あいだを 2 桁あけた。`Box` はクリックを受けられない(`onPress` が無い)ので、`Button` の当たり判定は 1 行のまま。
- **縦の当たり判定を 2 行にした。** `Client` に `height={2}` を付け、1 行目に見出し、2 行目に空白を描く。画面の下に置く行数は 2。ボタンは 1 行目に並ぶ(`Box` の `alignItems="flex-end"` では下の行に寄らなかった)。2 行目の空白をクリックしても、キーを受けた。
- **ポインタが乗ると反転する。** 本体は、ポインタが乗った `Button` を反転(`ESC [7m`)で描く。`Client` は `onPointer` の `enter` / `move` / `leave` を受けられるので、領域にポインタがある間、見出しを反転させる(`surface.setState`)。検証ハーネスの生の出力で、`Button` と同じ `ESC [1m ESC [7m` になることを確認した。
- **状態の表示を減らした。** 画面の大きさ(`80x38`)、`added N lines`、履歴の操作の説明は出さない。残したのは `connecting…`、シェルの終了、さかのぼっている位置(`history -36/65`)、選択の範囲。状態が長くてもボタンが押しつぶされないよう、ボタンの `Box` に `flexShrink={0}` を付けた。
- **使ってみた結果、当たり判定は見出しだけ(1 行)に戻し、左詰めにした。** `flexGrow` と `height={2}` を外した。下の行は `[ Terminal input ] [ Add to Claude ] [ Help ]` と状態で、画面の下に置く行数は 1。状態は hooks モジュールが `Text` で描く形に戻した。ポインタが乗ったときの反転と、状態の表示を減らしたことは残した。上の 2 項目(`flexGrow`、2 行)は、試した記録。
- 検証ハーネスで確認: `[ Terminal input ]` をクリックして `echo RAW` が届いた。`alt+h` でヘルプが出て、`x` で閉じ、`x` はシェルに入らなかった。

### テストキット(`claude plugin test`)で分かったこと

- 対象は `*.test.ts`。`bun test` 用のテストは `*.spec.ts` にして、互いに拾わないようにしている。
- `$` の呼び出し(`process.run`、`http.fetch`、`env.get`、`ui.open` など)に答えるテスト側の hook は `{ value }` を返す。`session.start` や `session.end` のようなイベントは、テストが `on(...)` で底を用意しないと `no implementation` になる。
- `$.clock.after` は `mock.clock(on)` を入れないと拒否される。進めるのは `clock.advance(ms)`。
- **プラグインが呼ぶ `$.session.append` は、テスト側の `on('session.append')` に届かなかった**(`no implementation for session.append`)。追加の成功は実機で確認し、テストでは失敗時の表示を確認している。

### まだ確認できていないこと

- 実際の端末(Ghostty)での色、全角の位置ずれ、打鍵の遅延、マウス操作の感触、大量ログでの体感。
- tmux の中と、非フルスクリーン表示。
- 絵文字など、`@xterm/headless` の幅の表と端末の幅が食い違う文字。
- フル機能の vim(確認したのは `vim.tiny`)。zsh、fish。
- compaction の後に、追加した行がどう扱われるか。
- 選択モードの見た目(反転と、選択カーソルの色)。フォーカスの表示の色。
- 選択モードを、非フルスクリーン表示と tmux で使えるか。
- macOS(cwd の取得は `/proc` に依存している)。

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

Phase 1 Step 1 の確認スクリプトは `spike/phase1/pty-check.ts`(`workshop exec -- bun spike/phase1/pty-check.ts`)。

検証ハーネス(`spike/phase0/harness/drive.py`)の制御用ディレクトリは、Unix ソケットのパス長の制限があるので短い場所(`$XDG_RUNTIME_DIR` の下など)に置く。
