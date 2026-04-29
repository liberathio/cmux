#!/usr/bin/env python3
"""Regression tests: CLI socket failures should surface actionable messages."""

from __future__ import annotations

import glob
import os
import shutil
import socket
import subprocess
import tempfile
import threading


def resolve_cmux_cli() -> str:
    explicit = os.environ.get("CMUX_CLI_BIN") or os.environ.get("CMUX_CLI")
    if explicit and os.path.exists(explicit) and os.access(explicit, os.X_OK):
        return explicit

    candidates: list[str] = []
    candidates.extend(glob.glob(os.path.expanduser("~/Library/Developer/Xcode/DerivedData/*/Build/Products/Debug/cmux")))
    candidates.extend(glob.glob("/tmp/cmux-*/Build/Products/Debug/cmux"))
    candidates = [p for p in candidates if os.path.exists(p) and os.access(p, os.X_OK)]
    if candidates:
        candidates.sort(key=os.path.getmtime, reverse=True)
        return candidates[0]

    in_path = shutil.which("cmux")
    if in_path:
        return in_path

    raise RuntimeError("Unable to find cmux CLI binary. Set CMUX_CLI_BIN.")


class EarlyCloseErrorServer:
    def __init__(self, socket_path: str, response: str):
        self.socket_path = socket_path
        self.response = response
        self.ready = threading.Event()
        self.error: Exception | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def wait_ready(self, timeout: float) -> bool:
        return self.ready.wait(timeout)

    def join(self, timeout: float) -> None:
        self._thread.join(timeout=timeout)

    def _run(self) -> None:
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            if os.path.exists(self.socket_path):
                os.remove(self.socket_path)
            server.bind(self.socket_path)
            server.listen(1)
            server.settimeout(6.0)
            self.ready.set()

            conn, _ = server.accept()
            with conn:
                conn.sendall((self.response + "\n").encode("utf-8"))
        except Exception as exc:  # pragma: no cover - explicit failure surfacing
            self.error = exc
            self.ready.set()
        finally:
            server.close()


def make_stale_socket(path: str) -> None:
    if os.path.exists(path):
        os.remove(path)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.bind(path)
    finally:
        sock.close()


def run_cli(cli_path: str, socket_path: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["CMUX_CLI_SENTRY_DISABLED"] = "1"
    env["CMUX_CLAUDE_HOOK_SENTRY_DISABLED"] = "1"
    return subprocess.run(
        [cli_path, "--socket", socket_path, "ping"],
        text=True,
        capture_output=True,
        env=env,
        timeout=8,
        check=False,
    )


def main() -> int:
    try:
        cli_path = resolve_cmux_cli()
    except Exception as exc:
        print(f"FAIL: {exc}")
        return 1

    with tempfile.TemporaryDirectory(prefix="cmux-cli-socket-errors-") as root:
        stale_socket_path = os.path.join(root, "stale.sock")
        make_stale_socket(stale_socket_path)

        stale_proc = run_cli(cli_path, stale_socket_path)
        if stale_proc.returncode == 0:
            print("FAIL: expected stale socket ping to fail")
            print(f"stdout={stale_proc.stdout!r}")
            print(f"stderr={stale_proc.stderr!r}")
            return 1

        expected_stale_message = f"cmux app is not listening on socket at {stale_socket_path}"
        if expected_stale_message not in stale_proc.stderr:
            print("FAIL: stale socket error was not actionable")
            print(f"expected substring: {expected_stale_message!r}")
            print(f"stderr={stale_proc.stderr!r}")
            return 1
        if "Connection refused" in stale_proc.stderr:
            print("FAIL: stale socket error still exposes bare errno text")
            print(f"stderr={stale_proc.stderr!r}")
            return 1

        early_socket_path = os.path.join(root, "early-close.sock")
        server = EarlyCloseErrorServer(
            early_socket_path,
            "ERROR: Access denied -- early-close regression",
        )
        server.start()

        if not server.wait_ready(2.0):
            print("FAIL: early-close server did not become ready")
            return 1
        if server.error is not None:
            print(f"FAIL: early-close server failed to start: {server.error}")
            return 1

        early_proc = run_cli(cli_path, early_socket_path)
        server.join(timeout=2.0)
        if server.error is not None:
            print(f"FAIL: early-close server error: {server.error}")
            return 1

        if early_proc.returncode == 0:
            print("FAIL: expected early-close ping to fail")
            print(f"stdout={early_proc.stdout!r}")
            print(f"stderr={early_proc.stderr!r}")
            return 1

        if "Access denied -- early-close regression" not in early_proc.stderr:
            print("FAIL: early-close socket error did not preserve server message")
            print(f"stderr={early_proc.stderr!r}")
            return 1
        if "Broken pipe" in early_proc.stderr:
            print("FAIL: early-close socket error still reports Broken pipe")
            print(f"stderr={early_proc.stderr!r}")
            return 1

    print("PASS: CLI socket failures surface actionable stale-listener and early-close errors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
