#!/usr/bin/env bash
# 配布用の release ブランチを作って push する。
#
# release ブランチは「HEAD のツリー + コンパイル済みの sidecar バイナリ」の 1 コミットだけを持つ。
# 親の無いコミットで毎回上書きするので(force push)、古いバイナリは履歴に残らない。
# マーケットプレイス(.claude-plugin/marketplace.json)は、このブランチの mod/ を参照している。
#
# 使い方(ホストで実行する):
#   workshop run -- build && scripts/release.sh
# 同じ version のまま出し直すとき(利用者には届かない)は FORCE=1 を付ける。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

BIN=mod/bin/terminal-sidecar
MANIFEST=mod/.claude-plugin/plugin.json
BRANCH=release
REMOTE=${REMOTE:-origin}

die() {
  echo "release: $*" >&2
  exit 1
}
version_of() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p'; }

[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes. Commit them first."
[ -x "$BIN" ] || die "$BIN is missing. Run: workshop run -- build"

# 配るのは Linux x64 だけ。ELF の e_machine(18 バイト目)が 0x3e なら x86-64
[ "$(head -c 4 "$BIN" | od -An -tx1 | tr -d ' \n')" = 7f454c46 ] || die "$BIN is not an ELF binary"
[ "$(od -An -tx1 -j18 -N1 "$BIN" | tr -d ' \n')" = 3e ] || die "$BIN is not an x86-64 binary"

# ソースより古いバイナリを配らない
stale=$(find mod/sidecar mod/shared package.json bun.lock -type f -newer "$BIN" -print -quit)
[ -z "$stale" ] || die "$BIN is older than $stale. Run: workshop run -- build"

version=$(version_of <"$MANIFEST")
[ -n "$version" ] || die "no version in $MANIFEST"

# 利用者に更新が届くのは version が変わったときだけ
if git fetch -q "$REMOTE" "$BRANCH" 2>/dev/null; then
  released=$(git show "FETCH_HEAD:$MANIFEST" | version_of)
  if [ "$released" = "$version" ] && [ "${FORCE:-}" != 1 ]; then
    die "version $version is already released. Bump \"version\" in $MANIFEST, or set FORCE=1."
  fi
fi

# 作業ツリーにも index にも触れず、別の index でツリーを組む(mod/bin/ は .gitignore に入っている)
GIT_INDEX_FILE=$(mktemp -u "${TMPDIR:-/tmp}/cc-term-release.XXXXXX")
export GIT_INDEX_FILE
trap 'rm -f "$GIT_INDEX_FILE"' EXIT

git read-tree HEAD
git update-index --add --cacheinfo "100755,$(git hash-object -w "$BIN"),$BIN"
commit=$(git commit-tree "$(git write-tree)" -m "Release $version (built from $(git rev-parse --short HEAD))")

git push --force "$REMOTE" "$commit:refs/heads/$BRANCH"
echo "release: pushed $version to $REMOTE/$BRANCH ($(git rev-parse --short "$commit"))"
