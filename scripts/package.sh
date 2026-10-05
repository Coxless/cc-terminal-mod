#!/usr/bin/env bash
# 配布用の zip を作る: git が追跡している mod/ のファイル + コンパイル済みの sidecar バイナリ。
# zip の直下がプラグインのルートになる(.claude-plugin/plugin.json が直下に来る)。
#
# 使い方: scripts/package.sh <出力先.zip>   (先に sidecar をビルドしておく)
set -euo pipefail

out=$(realpath -m "${1:?usage: scripts/package.sh <out.zip>}")
cd "$(git rev-parse --show-toplevel)/mod"

[ -x bin/terminal-sidecar ] || { echo "package: mod/bin/terminal-sidecar is missing. Build it first." >&2; exit 1; }
# 配るのは Linux x64 だけ。ELF の e_machine(18 バイト目)が 0x3e なら x86-64
[ "$(od -An -tx1 -N4 bin/terminal-sidecar | tr -d ' \n')" = 7f454c46 ] &&
  [ "$(od -An -tx1 -j18 -N1 bin/terminal-sidecar | tr -d ' \n')" = 3e ] ||
  { echo "package: mod/bin/terminal-sidecar is not a Linux x86-64 binary" >&2; exit 1; }

rm -f "$out"
{ git ls-files; echo bin/terminal-sidecar; } | zip -q -X "$out" -@
echo "package: wrote $out ($(du -h "$out" | cut -f1))"
