# Claude Code Terminal Mod

Claude Code を終了せずに、その場で Terminal のペインを開いて操作し、選択したテキストだけを Claude に渡せるようにする Mod。

- ペインの中で普通のシェルが動く(`vim`、`less`、`top` も使える)。
- ペインを閉じても、シェルは残る。
- Terminal の内容は、自動では Claude に渡らない。人が選択して、明示的に渡したものだけが渡る。

## 動作環境

- **Linux x64 のみ。** macOS、Windows、Linux arm64 では動かない(同梱のバイナリが Linux x64 用)。
- Claude Code v2.1.287 以降(Mods が必要)。動作を確認したのは v2.1.289。Mods API は early access で、リリースごとに変わる。
- フルスクリーン表示。マウスで選択したテキストを渡すのに必要(選択モードは、フルスクリーンでなくても動く見込み)。

## インストール

Claude Code のセッションで:

```text
/plugin marketplace add Coxless/cc-terminal-mod
/plugin install terminal@coxless
```

更新するとき:

```text
/plugin marketplace update coxless
```

## 使い方

| コマンド | 動作 |
| :- | :- |
| `/term` | ペインを開く。シェルが無ければ起動する |
| `/term-hide` | ペインを閉じる。シェルは残る |
| `/term-add` | マウスで選択したテキストを Claude に渡す |

Terminal に入力するには、ペインの下の行の `[ Terminal input ]` をクリックする。Claude のプロンプトへ戻るのは Escape。

`[ Terminal input ]` がキーを受けている間に使えるキー:

| キー | 動作 |
| :- | :- |
| `ctrl+]` | Escape を送る |
| `alt+c` / `alt+d` / `alt+z` / `alt+x` | Ctrl+C / Ctrl+D / Ctrl+Z / Ctrl+X を送る |
| `shift+PageUp` / `shift+PageDown` | 履歴をさかのぼる(ホイールでも可) |
| `alt+v` | 選択モード。`h` `j` `k` `l` か矢印で動き、`v` / `V` で始点、`enter` で Claude に渡す、`q` で取り消す |
| `alt+a` | マウスで選択したテキストを Claude に渡す |
| `alt+h` | ヘルプ |

## 制約

Claude Code の公式 Mods API だけで作っているため、次のことができない。理由は `docs/architecture.md` の「技術的制約」。

- Escape、Ctrl+C、Ctrl+D、Ctrl+Z、Ctrl+X は、そのままでは Terminal に届かない。上の代替キーを使う。
- ペーストは Terminal に届かない(Claude のプロンプト欄に入る)。
- キーボードだけでは Terminal に切り替えられない。`[ Terminal input ]` のクリックが要る。
- Terminal の 16 色は、端末の配色どおりにはならない。

## 開発

開発環境、コマンド、設計上の決定は `CLAUDE.md`。要件は `concept-mvp.md`、構成と API の挙動は `docs/architecture.md`、計画は `docs/implementation-plan.md`。
