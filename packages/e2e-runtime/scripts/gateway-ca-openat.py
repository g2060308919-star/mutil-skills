#!/usr/bin/python3
"""Descriptor-relative, atomic Gateway CA generation storage."""

import base64
import errno
import json
import os
import secrets
import stat
import sys

ERROR = "E2E_GATEWAY_CA_STATE_INVALID"
GENERATION = "gateway-ca"


class SafeFailure(Exception):
    pass


class GenerationNotFound(Exception):
    pass


def fail():
    raise SafeFailure()


def same(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def open_directory(parent_fd, name, private=False):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        before = os.fstat(fd)
        path = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(before.st_mode) or not same(before, path):
            fail()
        if private and (before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) != 0o700):
            fail()
        return fd
    except Exception:
        os.close(fd)
        raise


def open_absolute_directory(path):
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        fail()
    fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        components = [part for part in path.split(os.sep) if part]
        if not components:
            fail()
        for index, part in enumerate(components):
            child = open_directory(fd, part, private=index == len(components) - 1)
            os.close(fd)
            fd = child
        return fd
    except Exception:
        os.close(fd)
        raise


def validate_file(directory_fd, name, maximum, read_contents=True):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    try:
        metadata = os.fstat(fd)
        path = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_size < 1 or metadata.st_size > maximum or not same(metadata, path)):
            fail()
        data = os.pread(fd, metadata.st_size, 0) if read_contents else None
        if ((read_contents and len(data) != metadata.st_size)
                or not same(metadata, os.fstat(fd))):
            fail()
        return data
    finally:
        os.close(fd)


def inspect_generation(authority_fd, authority_path):
    try:
        directory_fd = open_directory(authority_fd, GENERATION, private=True)
    except FileNotFoundError as error:
        raise GenerationNotFound() from error
    try:
        before = os.fstat(directory_fd)
        # 私钥只验证 inode/owner/mode/size，不把内容读入辅助进程内存。
        validate_file(directory_fd, "key.pem", 64 * 1024, read_contents=False)
        cert = validate_file(directory_fd, "cert.pem", 64 * 1024)
        after = os.fstat(directory_fd)
        if not same(before, after):
            fail()
        real_path = os.path.join(authority_path, GENERATION)
        path = os.stat(real_path, follow_symlinks=False)
        if not same(after, path) or os.path.realpath(real_path) != real_path:
            fail()
        return {
            "realPath": real_path,
            "device": str(after.st_dev),
            "inode": str(after.st_ino),
            "cert": cert,
        }
    finally:
        os.close(directory_fd)


def decode_input():
    raw = sys.stdin.buffer.read(256 * 1024)
    try:
        value = json.loads(raw.decode("utf-8"))
        if set(value.keys()) != {"certBase64Url", "keyBase64Url"}:
            fail()
        key = bytearray(base64.urlsafe_b64decode(value["keyBase64Url"] + "==="))
        cert = bytearray(base64.urlsafe_b64decode(value["certBase64Url"] + "==="))
        if not key or len(key) > 64 * 1024 or not cert or len(cert) > 64 * 1024:
            fail()
        return key, cert
    except Exception as error:
        raise SafeFailure() from error


def write_file(directory_fd, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    try:
        written = 0
        while written < len(data):
            count = os.pwrite(fd, data[written:], written)
            if count <= 0:
                fail()
            written += count
        os.fsync(fd)
        metadata = os.fstat(fd)
        path = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_size != len(data) or not same(metadata, path)):
            fail()
    finally:
        os.close(fd)


def remove_staging(authority_fd, name):
    try:
        directory_fd = open_directory(authority_fd, name, private=True)
        try:
            for child in ("key.pem", "cert.pem"):
                try:
                    os.unlink(child, dir_fd=directory_fd)
                except FileNotFoundError:
                    pass
        finally:
            os.close(directory_fd)
        os.rmdir(name, dir_fd=authority_fd)
        os.fsync(authority_fd)
    except OSError:
        pass


def create_generation(authority_fd, authority_path, key, cert):
    staging = ".gateway-ca-staging-" + secrets.token_hex(16)
    os.mkdir(staging, 0o700, dir_fd=authority_fd)
    os.fsync(authority_fd)
    try:
        directory_fd = open_directory(authority_fd, staging, private=True)
        try:
            write_file(directory_fd, "key.pem", key)
            write_file(directory_fd, "cert.pem", cert)
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        try:
            os.rename(staging, GENERATION, src_dir_fd=authority_fd, dst_dir_fd=authority_fd)
        except OSError as error:
            if error.errno not in (errno.EEXIST, errno.ENOTEMPTY):
                raise
            remove_staging(authority_fd, staging)
        os.fsync(authority_fd)
        return inspect_generation(authority_fd, authority_path)
    except Exception:
        remove_staging(authority_fd, staging)
        raise


def emit_generation(generation):
    emit({
        "ok": True,
        "schemaVersion": "1.0.0",
        "directory": {
            "realPath": generation["realPath"],
            "device": generation["device"],
            "inode": generation["inode"],
        },
        "certBase64Url": base64.urlsafe_b64encode(generation["cert"]).decode("ascii").rstrip("="),
    })


def emit(value):
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    try:
        if len(sys.argv) != 3 or sys.argv[2] not in ("read", "create"):
            fail()
        authority_path = sys.argv[1]
        authority_fd = open_absolute_directory(authority_path)
        try:
            if sys.argv[2] == "read":
                emit_generation(inspect_generation(authority_fd, authority_path))
            else:
                key, cert = decode_input()
                try:
                    emit_generation(create_generation(authority_fd, authority_path, key, cert))
                finally:
                    key[:] = b"\x00" * len(key)
                    cert[:] = b"\x00" * len(cert)
        finally:
            os.close(authority_fd)
        return 0
    except GenerationNotFound:
        emit({"ok": False, "code": "E2E_GATEWAY_CA_NOT_FOUND"})
        return 3
    except Exception:
        emit({"ok": False, "code": ERROR})
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
