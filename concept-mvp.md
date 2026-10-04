# Claude Code Terminal Mod — MVP Design

## 1. Overview

### Project name

仮称: **Claude Code Terminal Mod**

### Purpose

Claude CodeでAIが作業している最中に、人間が一時的にターミナルを操作・確認したくなった場合、Claude Codeを終了・中断して別のターミナルへ移動することなく、その場でターミナルを開いて操作できるようにする。

さらに、ターミナル上で確認した情報の一部を選択し、Claude CodeのContextへ渡せるようにする。

### Claude Code Mod を前提とした実装方針

本プロジェクトは、Claude Code の公式 Mods 機構を利用することを第一候補とする。Mods は Claude Code 内で JavaScript / TypeScript のイベントハンドラとして実行され、独自ペイン、ボタン、入力、コマンド、プロセス起動などを提供できる。したがって、本設計でいう Mod/Integration Layer は、原則として Claude Code の内部実装を patch するものではなく、公式 Mods API に実装する。

公式 Docs では、Mod は `$.ui.open` によりペインを開閉でき、`ui.render` で UI を描画できる。また `$.process` によりプロセスを起動でき、`spawn` は長時間実行コマンドの出力をストリームできる。さらに `$.prompt.submit` により Mod から Claude のターンを開始できる。

ただし、通常の対話型 Terminal に必要な PTY / raw input / ANSI cursor 制御 / interactive stdin が Mods API だけで完全に実現できるかは、実装前の Feasibility Spike で検証する。

**重要:** Claude Code の private implementation の patch は第一候補にしない。公式 Mods API で実現できない機能だけを明示的な技術的制約として切り分ける。

### Core problem

現在のClaude Code利用中に、

- `git diff` を確認したい
- `git status` を確認したい
- `rg` でコードを検索したい
- ログを確認したい
- `vim` でファイルを確認したい
- テストやビルドのエラーを直接確認したい
- その他、Claude Codeに任せるほどではない簡単な調査をしたい

といった場合、人間がClaude Codeのセッションから一度抜けて別ターミナルを開き、確認後にClaude Codeへ戻る必要がある。

この切り替えをなくすことがMVPの目的である。

---

# 2. MVP Goal

MVPでは以下だけを実現する。

1. Claude Code実行中にTerminal Paneを開ける
2. Terminal Paneで通常のシェルを操作できる
3. Claude Codeの作業を終了せずにTerminalとClaude Codeを切り替えられる
4. Terminalで文字列を選択できる
5. 選択した文字列をClaude CodeのContextへ渡せる
6. Terminalを閉じてもClaude Codeのセッションは維持される

## Non-goals

MVPでは以下を実装しない。

- Claude CodeのAgent/Tool実行との高度な連携
- Terminalコマンドの自動解析
- Claude CodeによるTerminalの自動操作
- AIによるTerminal出力の要約
- Terminal履歴の永続化
- 複数Terminalの管理
- タブ機能
- リモートSSH専用機能
- IDE機能
- ファイルツリー
- Terminal出力の構造化解析
- 自動的なContext追加
- Claude Code内部実装への過度な依存

MVPでは「人間が必要なときにTerminalを開く」ことを最優先する。

---

# 3. User Experience

## Primary workflow

通常はClaude Codeを利用する。

```text
Claude Code
    ↓
AIが作業
    ↓
人間が確認したいことが発生
    ↓
Terminal Paneを開く
    ↓
コマンド実行・ファイル確認・ログ確認
    ↓
Claude Codeへ戻る
    ↓
AIの作業を継続
```

重要なのは、Claude Codeを終了・再起動しないことである。

---

# 4. UI Concept

MVPではClaude Codeの画面にTerminal Paneを追加する。

```text
┌──────────────────────────────────────────────┐
│ Claude Code                                  │
├──────────────────────────────┬───────────────┤
│                              │ Terminal      │
│  Claude Code conversation    │               │
│                              │ $ git status  │
│  > Implement ...             │               │
│                              │ $ git diff    │
│  Claude:                     │               │
│  ...                         │               │
│                              │               │
│                              │               │
├──────────────────────────────┴───────────────┤
│ Claude Code input                            │
└──────────────────────────────────────────────┘
```

Terminal Paneは常時表示ではなく、ショートカット等で開閉できる設計を推奨する。

### 推奨操作

```text
Toggle Terminal
    ↓
Terminal Paneを開く/閉じる
```

ショートカットは実装時にClaude Codeとの競合を確認して決定する。

---

# 5. Terminal Requirements

Terminal Paneは「見た目だけのTerminal」ではなく、PTYを利用した通常のTerminalとする。

## Required

- シェル起動
- stdin入力
- stdout/stderr表示
- ANSI escape sequence対応
- カラー表示
- cursor表示
- arrow keys
- Ctrl+C(代替キーで送る。下記)
- Ctrl+D(同上)
- Ctrl+Z(同上)
- command history
- terminal resize
- scrollback
- text selection
- paste
- copy

**Phase 0 で確認した制約:** Escape / Ctrl+C / Ctrl+D / Ctrl+Z / Ctrl+X とペーストは Claude Code 本体が処理し、Mod には届かない。Terminal へは代替キーで送る。当面の割り当ては `ctrl+]` = Escape、`alt+c` / `alt+d` / `alt+z` / `alt+x` = Ctrl+C / D / Z / X。詳細は `docs/architecture.md` §2。

**Phase 1 で確認した制約:** キー入力を始めるには、ペイン上端の帯をクリックする必要がある。ペーストは、プロンプト欄に入ったテキストをペインのボタンで Terminal へ送る。Terminal の 16 色は Claude Code 側の色に置き換わり、端末の配色どおりにはならない。

### Shell

MVPではユーザーのデフォルトシェルを使用する。

例:

```text
$SHELL
```

取得できない場合はプラットフォームの標準シェルへfallbackする。

---

# 6. Working Directory

Terminalを開いたときのWorking Directoryは、原則としてClaude Codeの現在の作業ディレクトリとする。

例:

```text
Claude Code
cwd:
/workspace/my-project

        ↓

Terminal
cwd:
/workspace/my-project
```

これにより、Claude Codeと人間が同じプロジェクトを確認できる。

## Important

Terminalで `cd` した場合、そのTerminal内のcwdだけが変更される。

Claude Code側のcwdを自動変更しない。

つまり、

```text
Claude Code cwd
        ≠
Terminal cwd
```

になり得る。

これは意図的な設計とする。

---

# 7. Context Integration

MVPのもう一つの重要機能。

Terminal上で文字列を選択すると、

```text
[ Add to Claude Context ]
```

という操作を提供する。

## Workflow

```text
Terminal

$ npm test

FAIL src/foo.test.ts

Expected: 200
Received: 500

        ↓ select

"Expected: 200
 Received: 500"

        ↓

Add to Claude Context

        ↓

Claude Code Context
```

---

# 8. Context Payload

単純な文字列だけではなく、可能な範囲でMetadataを付与する。

MVPでは以下を推奨する。

```text
Source: Terminal
Working directory: /workspace/project

Selected text:
----------------
Expected: 200
Received: 500
----------------
```

将来的には以下も検討可能。

```text
Shell
Command
Timestamp
Terminal pane ID
```

ただしMVPでは、確実に取得できる情報だけを使用する。

---

# 9. Claude Code Mod / Contextへの渡し方

本Modでは、Claude Codeの内部Contextデータ構造を直接書き換えることを前提にしない。

MVPの「Add to Claude Context」は `$.session.append` を使う。

```text
Terminal selection ($.ui.selection)
      ↓
Context Payload生成
      ↓
$.session.append(...)
      ↓
現在のClaude Code sessionへ渡す
```

Phase 0 の実機検証(`docs/architecture.md` §5)による。`$.session.append` はユーザーに見えない user 行を会話に追加するだけでターンを始めず、Claude が作業中なら同じターンの次のリクエストから読まれる。当初の第一候補だった `$.prompt.submit` は、追加した瞬間に新しいターンが始まるため、「選択して追加し、あとで自分の言葉で指示する」UX に合わない。

### Context Payload

MVPでは次の形式を推奨する。

```text
[Terminal Context]
Working directory: /workspace/project

Selected output:
----------------
Expected: 200
Received: 500
----------------
```

選択テキストはTerminal由来の外部情報として扱い、Mod自身が内容を解釈・要約・自動実行しない。

### Important

Claude Codeのprivate implementation、内部Contextデータ構造、非公開IPCを直接利用することはMVPでは禁止する。

`$.session.append` が使えない場合の代替は、`prompt.submit` hook の `context`(次にユーザーが送るプロンプトに添付)と `$.prompt.fill`(プロンプト欄に下書きとして入れる)。

# 10. Terminal Selection UX

選択後の操作はMVPでは以下のいずれかを採用する。

### Option A — Context Menu

```text
右クリック
    ↓
Add to Claude Context
```

### Option B — Shortcut

```text
文字列を選択
    ↓
Ctrl+Shift+C
    ↓
Claude Contextへ追加
```

### Option C — Floating Action

```text
選択
 ↓
[Add to Claude]
```

MVPでは実装コストとTerminal UIとの相性を考慮して決定する。

**決定(Phase 0):** MVP は次の 2 つにする。どちらも Claude の作業中に使える。

- `/term-add` コマンド(Option B に相当。選択は `$.ui.selection()` で読む)
- ペイン内の `[ Add to Claude ]` ボタン(Option C に相当)

Option A の右クリックメニューは、Mods API に手段が見つかっていないので採らない。`Ctrl+Shift+C` のような任意のキーも Mod には割り当てられないため、キーでの起動は Phase 3 で検討する。

---

# 11. Context Added Indicator

Contextへ追加されたことが分かるUIを用意する。

例:

```text
✓ Added to Claude Context
```

または短いToast:

```text
Added 142 characters to Claude Context
```

ユーザーが「本当にClaudeへ渡ったのか」を確認できることが重要。

---

# 12. Terminal Lifecycle

Terminalは以下のライフサイクルを持つ。

```text
Closed
  ↓
Open
  ↓
Running
  ↓
Hidden
  ↓
Open
  ↓
Closed
```

## Hidden

Terminal Paneを閉じても、MVPではTerminal processを終了させず、PTYを保持することを推奨する。

これにより、

```text
Terminalで作業
    ↓
一旦Claude Codeへ戻る
    ↓
再度Terminalを開く
```

としても状態を維持できる。

例:

```text
Terminal

$ tail -f app.log
...
```

Terminal Paneを一時的に隠しても、PTY processは生存する。

---

# 13. Terminal Close

「Hide」と「Kill」を分ける。

### Hide

Terminal UIだけ閉じる。

PTYは生存。

### Kill

Terminal processを終了。

MVPでは明示的なKill操作を必須にはしなくてもよいが、アプリ終了時にはPTYを適切に終了する。

---

# 14. Error Handling

最低限以下を扱う。

## Shell起動失敗

```text
Failed to start shell.

[Retry]
```

## PTYエラー

```text
Terminal process disconnected.

[Reconnect]
```

## Context追加失敗

```text
Failed to add selection to Claude Context.

[Retry]
```

エラーによってClaude Code本体のセッションを終了させない。

---

# 15. Architecture

MVPではClaude Codeの公式 Mods APIを統合境界とする。

```text
┌─────────────────────────────────────┐
│ Claude Code Mod                     │
│                                     │
│  Official Mods API                  │
│       │                             │
│       ├── UI / Pane                 │
│       │      │                      │
│       │      ▼                      │
│       │  Terminal UI                │
│       │      │                      │
│       │      ├── Selection          │
│       │      │      │               │
│       │      │      ▼               │
│       │      │ Context Bridge       │
│       │      │      │               │
│       │      │      ▼               │
│       │      │ $.prompt.submit     │
│       │                             │
│       └── $.process / spawn         │
│                    │                │
└────────────────────┼────────────────┘
                     ▼
                   Shell
```

Terminal renderer、PTY/session管理、Context Bridge、Claude Code固有APIをそれぞれ分離する。

**Phase 0 での訂正:** 上の図の `$.process / spawn → Shell` と `$.prompt.submit` は成立しない。`$.process.spawn` は stdin を起動時に一度書くだけで、PTY も resize も無い。PTY と VT エミュレーションは、daemon 化した sidecar プロセスが持ち、Mod は Unix ソケット上の HTTP(`$.http.fetch` の `socketPath`)で操作する。構成図は `docs/architecture.md` を正とする。

# 16. Components

## 16.1 Terminal Manager

責務:

- PTY lifecycle
- shell起動
- stdin/stdout
- resize
- process終了

Interface例:

```ts
interface TerminalManager {
  create(): TerminalSession
  write(input: string): void
  resize(cols: number, rows: number): void
  hide(): void
  show(): void
  dispose(): void
}
```

実際の言語/APIは既存Claude Code Modの技術基盤に合わせて決定する。

---

## 16.2 Terminal UI

責務:

- terminal rendering
- keyboard input
- mouse input
- selection
- copy/paste
- resize

---

## 16.3 Context Bridge

責務:

```text
Terminal Selection
       ↓
Context Payload
       ↓
Claude Code
```

Claude Codeとの境界をTerminal実装から分離する。

---

## 16.4 Mod/Integration Layer

Claude Codeへの統合を担当。

ここにClaude Code固有の処理を集約する。

目的:

Claude Codeの仕様変更による影響範囲を最小化する。

---

# 17. Key Design Principle

## TerminalはClaude Codeとは独立させる

Terminalで実行したコマンドをClaude Codeへ自動通知しない。

例えば、

```text
$ git status
```

しただけではContextへ追加しない。

人間が、

```text
選択
 ↓
Add to Claude Context
```

したときだけ渡す。

これにより、Claude CodeのContextが不要な情報で汚染されることを防ぐ。

---

# 18. Security / Safety

Terminalは通常のユーザー権限で実行する。

MVPではClaude Codeの権限を昇格させたり、Terminal専用の特権を付与したりしない。

また、Terminalで実行されたコマンドをClaude Codeが自動実行する仕組みは作らない。

重要なのは、

```text
Human
  ↓
Terminal
  ↓
選択
  ↓
Claude Context
```

という一方向の情報共有である。

---

# 19. MVP Acceptance Criteria

以下をすべて満たしたらMVP完成とする。

### AC-1 Terminal起動

Claude Code実行中にTerminal Paneを開ける。

### AC-2 Shell

Terminalで通常のshell commandを実行できる。

例:

```bash
pwd
ls
git status
git diff
rg foo
npm test
```

### AC-3 Interactive command

Interactive commandが最低限動作する。

例:

```bash
vim
```

少なくとも入力、カーソル、Ctrlキー、画面描画が正常に動作する。

### AC-4 Claude Code継続

Terminalを開閉してもClaude Codeのセッションが失われない。

### AC-5 Working Directory

Terminal起動時にClaude Codeの作業ディレクトリから開始する。

### AC-6 Selection

Terminal上の文字列を選択できる。

### AC-7 Context追加

選択文字列をClaude Code Contextへ追加できる。

### AC-8 Feedback

Context追加成功/失敗をUI上で確認できる。

### AC-9 Terminal persistence

TerminalをHideして再表示しても、可能な限り同じshell sessionが維持される。

### AC-10 Isolation

Terminalの失敗がClaude Code本体のセッションをクラッシュさせない。

---

# 20. Example Scenarios

## Scenario 1: git diffを確認

Claude Codeが実装中。

人間:

```text
ちょっとdiffを確認したい
```

Terminalを開く。

```bash
git diff
```

確認。

Claude Codeへ戻る。

Claude Codeの作業はそのまま継続。

---

## Scenario 2: エラーログをClaudeへ渡す

Terminal:

```bash
npm test
```

出力:

```text
FAIL src/foo.test.ts

Expected: 200
Received: 500
```

該当部分を選択。

```text
Add to Claude Context
```

Claude Codeへ戻る。

入力:

```text
このエラーを調査して
```

ClaudeがContextとして選択ログを利用する。

---

## Scenario 3: Vimで確認

Terminal:

```bash
vim src/foo.ts
```

人間がコードを確認。

必要な部分をTerminal上で選択。

```text
Add to Claude Context
```

Claude Codeへ戻る。

---

# 21. Technical Investigation Before Implementation

## 21.0 Official Mods API を最優先で検証する

現在のClaude Code Mods仕様では、ModはClaude Codeプロセス内で実行され、ペイン・ボタン・入力などのUIを描画できる。ペインは `$.ui.open` で開閉でき、`ui.render` で描画する。Modは `$.process.run` / `$.process.spawn` でプロセスを起動できる。

また、Modから `$.prompt.submit` によってClaudeへの新しいターンを開始できる。

したがって、旧設計にあった「Claude Code UIへhookできるか」「plugin/mod APIが存在するか」という問いは、現在の公式Docsを前提にすると解決済みとする。実装前に確認すべきなのは、**このAPIだけで要求するinteractive PTY Terminalを成立させられるか**、および **Claudeが作業中の状態から選択テキストを適切に次のターンへ渡せるか**である。

Modは現在 Claude Code v2.1.287 以降が必要と公式Docsに記載されている。実装環境では `claude --version` を確認し、対象バージョンを明示する。

## 21.1 Claude Code UI integration

- Claude CodeのUI実装方式
- TUI framework
- 拡張ポイントの有無
- UIをhookできるか
- plugin/mod APIの有無
- wrapperとして実装可能か

## 21.2 Terminal implementation

決定(2026-10-05):

- sidecar プロセスを TypeScript + Bun で書く
- PTY: Bun 組み込みの PTY 対応
- VT エミュレーション: `@xterm/headless`
- 配布: `bun build --compile` の単一バイナリを Mod に同梱

hooks モジュールには DOM も Node.js API も無いので、xterm.js や node-pty を Mod の中で直接使うことはできない。Bun の PTY が要件を満たさない場合は Node.js + node-pty に切り替える。理由は `docs/architecture.md`。

## 21.3 Context integration

最重要調査項目。

以下を確認する。

- Claude Codeへ外部からContextを注入できるか
- slash command等を利用できるか
- stdinを利用できるか
- IPCが存在するか
- plugin APIが存在するか
- 内部イベント/APIが利用できるか
- wrapper方式が可能か

## 21.4 Interactive terminal compatibility

最低限:

- bash
- zsh
- fish
- vim
- less
- top
- git
- npm/pnpm
- cargo

を想定する。

---

# 22. Implementation Strategy

実装では、最初からすべてを作らない。

## Phase 0 — Feasibility Spike

公式 Mods API を使った最小PoCを先に作る。wrapperやprivate implementationへの移行は、このPoCで公式APIだけでは要求を満たせないことが確認された場合にのみ検討する。

成果物:

```text
docs/architecture.md
```

最低限、以下の4項目を実機で確認する。

1. `$.ui.open` + `ui.render` でTerminal Paneを開閉できる
2. `$.process.spawn` 等で長時間実行プロセスを扱える
3. interactive shellに必要なstdin / resize / ANSI / raw inputを実現できる
4. Terminal selection → `$.prompt.submit` がClaude Codeの現在セッションに期待通り渡る

特に4は、Claudeが作業中の場合とidleの場合の両方を検証する。

**Go / No-Go:**

- Go: 公式 Mods APIのみでTerminal UXとContext Bridgeの主要要件を満たせる
- Conditional Go: Terminalは成立するがContext Bridgeに制約がある。Terminal MVPを先行する
- No-Go: interactive PTYまたは必要なUI操作が公式APIでは成立しない。制約を明記して設計を再検討する

**Phase 0 の結果(2026-10-05):** Go。キー入力の制約(§5)は当面受け入れる。根拠と決定事項は `docs/architecture.md`。

## Phase 1 以降

ステップ、完了条件、リスクは `docs/implementation-plan.md` を正とする。ここには概要だけを置く。

| Phase | 目的 |
| :- | :- |
| 1. Terminal Only | ペインの中で普通のシェルが使える。Context 連携なし。sidecar は TypeScript + Bun |
| 2. Context Bridge | 選択したテキストを `$.session.append` で Claude に渡す |
| 3. Polish | ペインを開くキー、代替キーの見直し、エラー処理、性能、マウス、macOS、配布 |

---

# 23. Performance Requirements

Terminalは高速である必要がある。

特に大量ログ:

```bash
docker logs ...
cat large.log
npm test
```

などでUIが固まらないこと。

MVPでは、

- 非同期PTY I/O
- UI renderingの最適化
- scrollback上限
- 大量出力時のbackpressure

を考慮する。

ただし過剰な最適化は避ける。

---

# 24. Testing

## Unit

- Terminal session lifecycle
- Context payload生成
- selection conversion
- resize
- error handling

## Integration

- shell起動
- command execution
- stdin/stdout
- hide/show
- Context bridge

## Manual

最低限:

```text
bash
zsh
vim
git
npm test
cargo test
```

を確認する。

---

# 25. Open Questions

Phase 0 で答えが出たもの。根拠は `docs/architecture.md`。

| 問い | 答え |
| :- | :- |
| Claude Code を直接 patch するか、wrapper にするか | どちらもしない。公式 Mods API の Mod として実装する |
| `$.process.spawn` だけで対話型シェルが成立するか | しない。PTY は sidecar プロセスが持つ |
| raw input、resize、SIGINT をどう扱うか | sidecar へ Unix ソケット上の HTTP で送る。シグナルは PTY に制御文字を書く |
| PTY library | Bun 組み込みの PTY + `@xterm/headless`(Phase 1 の Step 1 で確認) |
| 文字選択をどう実現するか | 自作しない。`Text` 行で描けば `$.ui.selection()` で取れる |
| Context injection | `$.session.append`。`$.prompt.submit` は追加した瞬間にターンが始まるので使わない |
| Claude が作業中に Context 追加したときの UX | 追加した行は同じターンの次のリクエストから読まれる |
| Hide で PTY を保持するか | 保持する。sidecar は Hide、Mod のリロード、`/clear` をまたいで生きる |
| Terminal を右に置くか下に置くか | Claude Code が決める。110 列以上は右に dock、それ未満はプロンプトの上に inline |
| Terminal Pane を開く操作 | `/term` コマンド |

Phase 1 で答えが出たもの。根拠は `docs/architecture.md` の「Phase 1・2 で確認したこと」。

| 問い | 答え |
| :- | :- |
| クリックなしで Terminal にフォーカスを移せるか | 移せない。`$.ui.focus` は `Client` を対象にできない。ペイン上端の帯をクリックしてから打つ |
| ペーストをどう Terminal に届けるか | ペーストはプロンプト欄に入るので、ペインの `[ Paste prompt text ]` ボタンでその下書きを Terminal へ送る |
| scrollback をペインでどうスクロールさせるか | ホイール、または `shift+PageUp` / `shift+PageDown`。履歴は 5000 行まで |

残っているもの:

- 代替キーの割り当てを見直すか、設定可能にするか
- tmux、非フルスクリーン表示での選択
- Claude Code アップデート時の互換性。Mods API は early access でリリースごとに変わる。対象バージョンを明示し、更新のたびに `claude plugin validate` とテストを回す

---

# 26. Product Definition

このModの価値を一文で表現すると、

> **Claude Codeを終了せずに、人間がいつでもターミナルへ降りて確認・操作でき、必要な情報だけClaudeへ戻せるようにする。**

MVPの中心UXは、

```text
Claude Code
    ↓
「あ、ちょっと確認したい」
    ↓
Terminalを開く
    ↓
確認・操作
    ↓
必要なら選択
    ↓
Add to Claude Context
    ↓
Claude Codeへ戻る
```

である。

これは「Claude CodeにTerminalを追加する」機能ではなく、

**Claude Codeセッションを中断せず、人間の探索作業を可能にするためのTerminal統合**

として設計する。


# 27. Reference

実装仕様の基準として、Claude Code公式 Mods ドキュメントを参照する。

- https://code.claude.com/docs/ja/plugins/mods/overview
- https://code.claude.com/docs/ja/plugins/mods/interface
- https://code.claude.com/docs/ja/plugins/mods/api

この設計書では、Claude Codeのprivate implementationではなく、公開されているMods APIを第一優先の実装境界とする。
