#!/usr/bin/python3
"""Pin an Authority child to an inherited directory descriptor before exec."""

import os
import stat
import sys


def main():
    try:
        if len(sys.argv) < 7:
            return 70
        directory_fd = int(sys.argv[1])
        expected_device = int(sys.argv[2])
        expected_inode = int(sys.argv[3])
        expected_real_path = sys.argv[4]
        node_executable = sys.argv[5]
        node_arguments = sys.argv[5:]
        metadata = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_dev != expected_device
            or metadata.st_ino != expected_inode
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            return 70
        os.fchdir(directory_fd)
        os.close(directory_fd)
        current = os.stat(".")
        if (
            current.st_dev != expected_device
            or current.st_ino != expected_inode
            or os.path.realpath(".") != expected_real_path
        ):
            return 70
        os.execve(node_executable, node_arguments, os.environ)
        return 70
    except Exception:
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
