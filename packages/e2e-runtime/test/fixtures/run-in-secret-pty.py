#!/usr/bin/python3
"""为 secret CLI 测试创建真实 PTY；不使用 shell，也不通过 argv/env 传递秘密。"""

import errno
import os
import pty
import select
import subprocess
import sys
import time


def main() -> int:
    try:
        master, slave = pty.openpty()
    except OSError as error:
        if error.errno in (errno.EPERM, errno.EACCES):
            print(f"SANDBOX_PTY_DENIED:{error.errno}", file=sys.stderr)
            return 77
        raise

    child = None
    typed = bytearray(b"pty-ab\x08c\x04")
    output = bytearray()
    sent = False
    deadline = time.monotonic() + 5
    try:
        try:
            child = subprocess.Popen(
                sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
                close_fds=True, shell=False,
            )
        except OSError as error:
            if error.errno in (errno.EPERM, errno.EACCES):
                print(f"SANDBOX_PTY_DENIED:{error.errno}", file=sys.stderr)
                return 77
            raise
        os.close(slave)
        slave = -1
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    data = os.read(master, 4096)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                output.extend(data)
                os.write(sys.stdout.fileno(), data)
                if not sent and b"PTY_RAW_READY" in output:
                    os.write(master, typed)
                    sent = True
            if child.poll() is not None and not ready:
                break
        # PTY master 可在 waitpid 状态传播前先返回 EIO；给真实 child 一个有界收敛窗口。
        try:
            return child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
            return 92
    finally:
        for index in range(len(typed)):
            typed[index] = 0
        for index in range(len(output)):
            output[index] = 0
        if child is not None and child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        if slave >= 0:
            os.close(slave)


if __name__ == "__main__":
    raise SystemExit(main())
