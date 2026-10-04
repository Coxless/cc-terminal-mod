#!/usr/bin/env python3
"""Phase 0 spike: 入れ子の Claude Code を PTY 越しに操作する検証ハーネス。

  drive.py serve <ctl-dir> <cols> <rows> -- <command...>   子を PTY で起動して常駐
  drive.py send <ctl-dir> '<json>'                         常駐プロセスへ 1 操作を送る

操作: {"op":"keys","d":"..."} / {"op":"screen"} / {"op":"wait","re":"...","ms":N}
      {"op":"click","x":X,"y":Y} / {"op":"drag","x":X,"y":Y,"x2":X2,"y2":Y2} / {"op":"quit"}
座標は 0 始まりのセル。画面は pyte で再現する。
"""
import fcntl
import json
import os
import pty
import re
import socket
import struct
import sys
import termios
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "sidecar", "vendor"))
import pyte  # noqa: E402

# pyte が誤解釈する private CSI (`CSI > ...`, `CSI < ...`, `CSI = ...`) を落とす
PRIVATE = re.compile(rb"\x1b\[[<>=][0-9;:]*[A-Za-z~]")


def serve(ctl, cols, rows, argv):
    os.makedirs(ctl, exist_ok=True)
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    lock = threading.Lock()
    env = {k: v for k, v in os.environ.items()
           if not (k.startswith("CLAUDE") or k in ("TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERMINFO"))}
    for k, v in os.environ.items():
        if k.startswith("CC_TERM_"):
            env[k] = v
    env.update(TERM="xterm-256color", COLORTERM="truecolor", COLUMNS=str(cols), LINES=str(rows))
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(argv[0], argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    screen.write_process_input = lambda data: os.write(fd, data.encode())
    raw = open(os.path.join(ctl, "raw.log"), "ab")
    state = {"alive": True}

    def pump():
        pending = b""
        while True:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                state["alive"] = False
                return
            raw.write(data)
            raw.flush()
            data = pending + data
            cut = data.rfind(b"\x1b")
            if cut != -1 and len(data) - cut < 32 and not re.match(rb"\x1b(\[[0-9;:?<>=]*[@-~]|[^\[\]])", data[cut:]):
                pending, data = data[cut:], data[:cut]
            else:
                pending = b""
            data = PRIVATE.sub(b"", data)
            with lock:
                try:
                    stream.feed(data)
                except Exception as e:  # pyte が知らないシーケンスで落ちても続ける
                    raw.write(b"\n[pyte error %r]\n" % repr(e).encode())

    threading.Thread(target=pump, daemon=True).start()

    def display():
        with lock:
            return [line.rstrip() for line in screen.display]

    def mouse(code, x, y, release=False):
        os.write(fd, b"\x1b[<%d;%d;%d%s" % (code, x + 1, y + 1, b"m" if release else b"M"))

    def handle(req):
        op = req["op"]
        if op == "keys":
            for chunk in req.get("seq", [req.get("d", "")]):
                os.write(fd, chunk.encode())
                time.sleep(req.get("gap", 0.05))
            return {"ok": True}
        if op == "screen":
            return {"alive": state["alive"], "lines": display()}
        if op == "wait":
            deadline = time.time() + req.get("ms", 10000) / 1000
            pat = re.compile(req["re"])
            while time.time() < deadline:
                if pat.search("\n".join(display())):
                    return {"ok": True}
                time.sleep(0.1)
            return {"ok": False}
        if op == "click":
            mouse(0, req["x"], req["y"])
            time.sleep(0.05)
            mouse(0, req["x"], req["y"], release=True)
            return {"ok": True}
        if op == "drag":
            x, y, x2, y2 = req["x"], req["y"], req["x2"], req["y2"]
            mouse(0, x, y)
            steps = 6
            for i in range(1, steps + 1):
                time.sleep(0.04)
                mouse(32, round(x + (x2 - x) * i / steps), round(y + (y2 - y) * i / steps))
            time.sleep(0.04)
            mouse(0, x2, y2, release=True)
            return {"ok": True}
        if op == "quit":
            try:
                os.kill(pid, 15)
            except OSError:
                pass
            threading.Timer(0.3, lambda: os._exit(0)).start()
            return {"ok": True}
        return {"error": "unknown op"}

    path = os.path.join(ctl, "ctl.sock")
    if os.path.exists(path):
        os.unlink(path)
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(path)
    srv.listen(4)
    with open(os.path.join(ctl, "child.pid"), "w") as f:
        f.write(str(pid))
    while True:
        conn, _ = srv.accept()
        try:
            req = json.loads(conn.makefile().readline())
            conn.sendall((json.dumps(handle(req), ensure_ascii=False) + "\n").encode())
        except Exception as e:
            conn.sendall((json.dumps({"error": repr(e)}) + "\n").encode())
        finally:
            conn.close()


def send(ctl, payload):
    s = socket.socket(socket.AF_UNIX)
    s.connect(os.path.join(ctl, "ctl.sock"))
    s.sendall((payload + "\n").encode())
    out = json.loads(s.makefile().readline())
    if "lines" in out:
        for i, line in enumerate(out["lines"]):
            print("%2d|%s" % (i, line))
        print("alive:", out["alive"])
    else:
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    if sys.argv[1] == "serve":
        sep = sys.argv.index("--")
        serve(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[sep + 1:])
    else:
        send(sys.argv[2], sys.argv[3])
