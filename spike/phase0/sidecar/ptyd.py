#!/usr/bin/env python3
"""Phase 0 spike: PTY sidecar.

PTY を持ち、VT エミュレーション(pyte)した画面を Unix ソケット上の HTTP で返す。
hooks モジュールからは `$.http.fetch(url, { socketPath })` だけで操作する。

  POST /input   {"d": "<text>"}          PTY へ書く(Ctrl+C は "\\x03")
  POST /resize  {"cols": N, "rows": N}   TIOCSWINSZ + 画面リサイズ
  POST /kill                             シェルを終了して daemon も終わる
  GET  /frame?since=V&wait=MS&fmt=cells|runs|both   画面(long-poll)
  GET  /info

起動すると daemon 化し、ソケットが listen を始めてから親が 1 行の JSON を出して終了する。
"""
import argparse
import base64
import errno
import fcntl
import json
import os
import pty
import re
import signal
import socket
import socketserver
import struct
import sys
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import pyte  # noqa: E402
from wcwidth import wcwidth  # noqa: E402

DEFAULT = 0x01000000
ANSI = {
    "black": 0x000000, "red": 0xCD3131, "green": 0x0DBC79, "brown": 0xE5E510,
    "blue": 0x2472C8, "magenta": 0xBC3FBC, "cyan": 0x11A8CD, "white": 0xE5E5E5,
    "brightblack": 0x666666, "brightred": 0xF14C4C, "brightgreen": 0x23D18B,
    "brightbrown": 0xF5F543, "brightblue": 0x3B8EEA, "brightmagenta": 0xD670D6,
    "brightcyan": 0x29B8DB, "brightwhite": 0xFFFFFF,
}
REV_FG, REV_BG = 0x1E1E1E, 0xD4D4D4
WIDE_PLACEHOLDER = 0x25A1  # □: Raster は幅 1 の BMP 文字しか置けない
# pyte が誤解釈する private CSI (`CSI > ...` など。vim や kitty keyboard protocol が出す)
PRIVATE = re.compile(rb"\x1b\[[<>=][0-9;:]*[A-Za-z~]")


def rgb(name):
    if name == "default":
        return DEFAULT
    if name in ANSI:
        return ANSI[name]
    try:
        return int(name, 16) & 0xFFFFFF
    except ValueError:
        return DEFAULT


class Term:
    def __init__(self, shell, cwd, cols, rows):
        self.cols, self.rows = cols, rows
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.lock = threading.Condition()
        self.ver = 1
        self.alive = True
        self.exit_status = None
        self.bytes_out = 0
        self.started = time.time()
        env = dict(os.environ, TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows))
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.chdir(cwd)
                os.execvpe(shell, [shell], env)
            finally:
                os._exit(127)
        self._winsz(cols, rows)
        self.screen.write_process_input = lambda data: os.write(self.fd, data.encode())
        self.feed_errors = 0
        threading.Thread(target=self._pump, daemon=True).start()

    def _winsz(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def _pump(self):
        while True:
            try:
                data = os.read(self.fd, 65536)
            except OSError as e:
                if e.errno == errno.EINTR:
                    continue
                data = b""
            if not data:
                break
            with self.lock:
                try:
                    self.stream.feed(PRIVATE.sub(b"", data))
                except Exception:  # 未対応シーケンスで daemon を落とさない
                    self.feed_errors += 1
                self.bytes_out += len(data)
                self.ver += 1
                self.lock.notify_all()
        try:
            _, status = os.waitpid(self.pid, 0)
            self.exit_status = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            pass
        with self.lock:
            self.alive = False
            self.ver += 1
            self.lock.notify_all()

    def write(self, text):
        os.write(self.fd, text.encode("utf-8"))

    def resize(self, cols, rows):
        with self.lock:
            self.cols, self.rows = cols, rows
            self.screen.resize(rows, cols)
            self._winsz(cols, rows)
            self.ver += 1
            self.lock.notify_all()

    def kill(self):
        try:
            os.killpg(os.getpgid(self.pid), signal.SIGHUP)
        except OSError:
            pass

    def frame(self, since, wait_ms, fmt):
        deadline = time.time() + wait_ms / 1000.0
        with self.lock:
            while self.ver <= since and self.alive:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.lock.wait(left)
            out = {
                "ver": self.ver, "cols": self.cols, "rows": self.rows,
                "cx": self.screen.cursor.x, "cy": self.screen.cursor.y,
                "alive": self.alive, "exit": self.exit_status, "bytes": self.bytes_out,
            }
            if self.ver <= since:
                return out
            t0 = time.time()
            if fmt in ("cells", "both"):
                out["cells"], out["wide"] = self._cells()
            if fmt in ("runs", "both"):
                out["runs"] = self._runs()
            out["encodeMs"] = round((time.time() - t0) * 1000, 2)
            return out

    def _colors(self, ch, is_cursor):
        fg, bg = rgb(ch.fg), rgb(ch.bg)
        if ch.reverse != is_cursor:
            fg, bg = (REV_FG if bg == DEFAULT else bg), (REV_BG if fg == DEFAULT else fg)
        return fg, bg

    def _cells(self):
        s = self.screen
        words = []
        wide = 0
        cur = None if s.cursor.hidden else (s.cursor.x, s.cursor.y)
        for y in range(self.rows):
            line = s.buffer[y]
            for x in range(self.cols):
                ch = line[x]
                d = ch.data
                if d == "":
                    cp = 0x20  # 全角文字の 2 セル目
                else:
                    cp = ord(d[0])
                    w = wcwidth(d[0])
                    if w == 2:
                        cp = WIDE_PLACEHOLDER
                        wide += 1
                    elif w != 1 or cp > 0xFFFF:
                        cp = 0x20 if w <= 0 else 0x3F
                fg, bg = self._colors(ch, cur == (x, y))
                words += (cp, fg, bg)
        raw = struct.pack("<%dI" % len(words), *words)
        return base64.b64encode(raw).decode("ascii"), wide

    def _runs(self):
        s = self.screen
        cur = None if s.cursor.hidden else (s.cursor.x, s.cursor.y)
        rows = []
        for y in range(self.rows):
            line = s.buffer[y]
            runs = []
            for x in range(self.cols):
                ch = line[x]
                if ch.data == "":
                    continue
                fg, bg = self._colors(ch, cur == (x, y))
                key = [None if fg == DEFAULT else "#%06x" % fg,
                       None if bg == DEFAULT else "#%06x" % bg, bool(ch.bold)]
                if runs and runs[-1][1:] == key:
                    runs[-1][0] += ch.data
                else:
                    runs.append([ch.data] + key)
            rows.append(runs)
        return rows


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    term = None
    server_ref = None

    def log_message(self, *a):
        pass

    def address_string(self):
        return "unix"

    def _send(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/frame":
            since = int(q.get("since", ["0"])[0])
            wait = min(int(q.get("wait", ["0"])[0]), 25000)
            self._send(self.term.frame(since, wait, q.get("fmt", ["cells"])[0]))
        elif u.path == "/info":
            t = self.term
            self._send({"pid": os.getpid(), "shellPid": t.pid, "alive": t.alive,
                        "cols": t.cols, "rows": t.rows, "ver": t.ver,
                        "uptime": round(time.time() - t.started, 1),
                        "feedErrors": t.feed_errors, "bytes": t.bytes_out})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = self._body()
            if u.path == "/input":
                self.term.write(body["d"])
                self._send({"ok": True})
            elif u.path == "/resize":
                self.term.resize(int(body["cols"]), int(body["rows"]))
                self._send({"ok": True})
            elif u.path == "/kill":
                self._send({"ok": True})
                self.term.kill()
                threading.Thread(target=shutdown, daemon=True).start()
            else:
                self._send({"error": "not found"}, 404)
        except Exception as e:  # daemon を落とさない
            self._send({"error": repr(e)}, 500)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


SOCK = None


def shutdown():
    time.sleep(0.2)
    try:
        os.unlink(SOCK)
    except OSError:
        pass
    os._exit(0)


def watchdog(term, watch_pid):
    dead_since = None
    while True:
        time.sleep(1)
        if watch_pid:
            try:
                os.kill(watch_pid, 0)
            except ProcessLookupError:
                term.kill()
                shutdown()
            except PermissionError:
                pass
        if not term.alive:
            dead_since = dead_since or time.time()
            if time.time() - dead_since > 60:
                shutdown()


def responds(path):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(1)
    try:
        s.connect(path)
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    global SOCK
    ap = argparse.ArgumentParser()
    ap.add_argument("--sock", required=True)
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--cols", type=int, default=80)
    ap.add_argument("--rows", type=int, default=24)
    ap.add_argument("--shell", default=os.environ.get("SHELL") or "/bin/sh")
    ap.add_argument("--watch-pid", type=int, default=os.getppid())
    ap.add_argument("--foreground", action="store_true")
    a = ap.parse_args()
    SOCK = a.sock

    if os.path.exists(a.sock):
        if responds(a.sock):
            print(json.dumps({"ok": True, "already": True}))
            return
        os.unlink(a.sock)
    os.makedirs(os.path.dirname(a.sock), mode=0o700, exist_ok=True)

    r, w = os.pipe()
    if not a.foreground:
        if os.fork() > 0:
            os.close(w)
            msg = os.read(r, 4096).decode() or json.dumps({"ok": False, "error": "daemon died"})
            print(msg)
            return
        os.setsid()
        if os.fork() > 0:
            os._exit(0)
        os.close(r)
        log = os.open(a.sock + ".log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.dup2(log, 1)
        os.dup2(log, 2)
    try:
        old = os.umask(0o177)
        server = Server(a.sock, Handler)
        os.umask(old)
        term = Term(a.shell, a.cwd, a.cols, a.rows)
        Handler.term = term
        threading.Thread(target=watchdog, args=(term, a.watch_pid), daemon=True).start()
        os.write(w, json.dumps({"ok": True, "pid": os.getpid(), "shellPid": term.pid,
                                "watchPid": a.watch_pid}).encode())
    except Exception as e:
        os.write(w, json.dumps({"ok": False, "error": repr(e)}).encode())
        raise
    finally:
        os.close(w)
    server.serve_forever()


if __name__ == "__main__":
    main()
