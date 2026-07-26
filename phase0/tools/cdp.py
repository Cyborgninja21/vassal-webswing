#!/usr/bin/env python3
"""Minimal CDP driver for the Phase 0 VASSAL-under-Webswing checklist.

Tabs are named; each name maps to an isolated browser context (own cookies =
own Webswing login). State (targetId per name) is kept in cdp-state.json.
"""
import base64
import json
import sys
import time
import urllib.request

import websocket

CDP_HTTP = "http://127.0.0.1:9222"
STATE_FILE = __file__.rsplit("/", 1)[0] + "/cdp-state.json"


def http_json(path):
    with urllib.request.urlopen(CDP_HTTP + path) as r:
        return json.load(r)


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(s):
    with open(STATE_FILE, "w") as f:
        json.dump(s, f, indent=1)


class Browser:
    def __init__(self):
        from urllib.parse import urlparse
        path = urlparse(http_json("/json/version")["webSocketDebuggerUrl"]).path
        self.ws = websocket.create_connection(f"ws://127.0.0.1:9222{path}", timeout=30)
        self.mid = 0

    def call(self, method, **params):
        self.mid += 1
        self.ws.send(json.dumps({"id": self.mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg["result"]


class Page:
    def __init__(self, target_id):
        self.ws = websocket.create_connection(
            f"ws://127.0.0.1:9222/devtools/page/{target_id}", timeout=60
        )
        self.mid = 0

    def call(self, method, timeout=60, **params):
        self.mid += 1
        self.ws.settimeout(timeout)
        self.ws.send(json.dumps({"id": self.mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg["result"]

    def mouse(self, mtype, x, y, button="none", clicks=0, buttons=0):
        self.call(
            "Input.dispatchMouseEvent",
            type=mtype, x=x, y=y, button=button, clickCount=clicks, buttons=buttons,
        )


def get_page(name):
    st = load_state()
    if name not in st:
        sys.exit(f"no tab named {name!r}; run: cdp.py newtab {name} <url>")
    return Page(st[name]["targetId"])


def cmd_newtab(name, url):
    st = load_state()
    b = Browser()
    ctx = b.call("Target.createBrowserContext")["browserContextId"]
    tgt = b.call("Target.createTarget", url=url, browserContextId=ctx,
                 width=1600, height=1000)["targetId"]
    st[name] = {"targetId": tgt, "browserContextId": ctx}
    save_state(st)
    time.sleep(2)
    print(f"tab {name}: {tgt}")


def cmd_nav(name, url):
    p = get_page(name)
    p.call("Page.navigate", url=url)
    time.sleep(2)
    print("ok")


def cmd_shot(name, out):
    p = get_page(name)
    data = p.call("Page.captureScreenshot", format="png", timeout=90)["data"]
    with open(out, "wb") as f:
        f.write(base64.b64decode(data))
    print(out)


def cmd_click(name, x, y, button="left", double=False):
    p = get_page(name)
    x, y = float(x), float(y)
    clicks = 2 if double else 1
    bmask = {"left": 1, "right": 2, "middle": 4}[button]
    p.mouse("mouseMoved", x, y)
    for c in range(1, clicks + 1):
        p.mouse("mousePressed", x, y, button=button, clicks=c, buttons=bmask)
        p.mouse("mouseReleased", x, y, button=button, clicks=c)
    print("ok")


def cmd_move(name, x, y):
    p = get_page(name)
    p.mouse("mouseMoved", float(x), float(y))
    print("ok")


def cmd_drag(name, x1, y1, x2, y2, steps=12, pause=0.05):
    p = get_page(name)
    x1, y1, x2, y2 = map(float, (x1, y1, x2, y2))
    p.mouse("mouseMoved", x1, y1)
    p.mouse("mousePressed", x1, y1, button="left", clicks=1, buttons=1)
    time.sleep(0.15)
    for i in range(1, int(steps) + 1):
        nx = x1 + (x2 - x1) * i / int(steps)
        ny = y1 + (y2 - y1) * i / int(steps)
        p.mouse("mouseMoved", nx, ny, buttons=1)
        time.sleep(pause)
    time.sleep(0.15)
    p.mouse("mouseReleased", x2, y2, button="left", clicks=1)
    print("ok")


def cmd_wheel(name, x, y, dy):
    p = get_page(name)
    p.call("Input.dispatchMouseEvent", type="mouseWheel", x=float(x), y=float(y),
           deltaX=0, deltaY=float(dy))
    print("ok")


def cmd_type(name, text):
    p = get_page(name)
    p.call("Input.insertText", text=text)
    print("ok")


KEYS = {
    "Enter": (13, "Enter", "\r"), "Tab": (9, "Tab", None), "Escape": (27, "Escape", None),
    "Backspace": (8, "Backspace", None), "Delete": (46, "Delete", None),
    "ArrowLeft": (37, "ArrowLeft", None), "ArrowRight": (39, "ArrowRight", None),
    "ArrowUp": (38, "ArrowUp", None), "ArrowDown": (40, "ArrowDown", None),
    "PageUp": (33, "PageUp", None), "PageDown": (34, "PageDown", None),
    "F2": (113, "F2", None),
}


def cmd_key(name, key, modifiers=0):
    p = get_page(name)
    if len(key) == 1:
        vk, code, text = ord(key.upper()), f"Key{key.upper()}", key
    else:
        vk, code, text = KEYS[key]
    args = dict(windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk, key=key,
                code=code, modifiers=int(modifiers))
    p.call("Input.dispatchKeyEvent", type="rawKeyDown", **args)
    if text:
        p.call("Input.dispatchKeyEvent", type="char", text=text, **args)
    p.call("Input.dispatchKeyEvent", type="keyUp", **args)
    print("ok")


def cmd_js(name, expr):
    p = get_page(name)
    r = p.call("Runtime.evaluate", expression=expr, returnByValue=True,
               awaitPromise=True)
    print(json.dumps(r.get("result", {}).get("value")))


def cmd_close(name):
    st = load_state()
    if name in st:
        b = Browser()
        try:
            b.call("Target.closeTarget", targetId=st[name]["targetId"])
            b.call("Target.disposeBrowserContext",
                   browserContextId=st[name]["browserContextId"])
        except RuntimeError as e:
            print(f"warn: {e}")
        del st[name]
        save_state(st)
    print("ok")


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    kw = {}
    pos = []
    for a in args:
        if a.startswith("--"):
            k, _, v = a[2:].partition("=")
            kw[k.replace("-", "_")] = v if v else True
        else:
            pos.append(a)
    globals()[f"cmd_{cmd}"](*pos, **kw)
