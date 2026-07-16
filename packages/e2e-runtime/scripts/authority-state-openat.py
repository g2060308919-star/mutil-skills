#!/usr/bin/python3
"""Prepare the Runtime Authority state with descriptor-relative POSIX operations."""

import base64
import errno
import json
import os
import secrets
import stat
import sys


DIRECTORY_ERROR = "E2E_APPROVAL_STATE_DIRECTORY_INVALID"
KEY_ERROR = "E2E_APPROVAL_STATE_KEY_INVALID"


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def exact_identity(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def inspect_directory(parent_fd, name, require_owner, require_private):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(name, flags, dir_fd=parent_fd)
    try:
        metadata = os.fstat(descriptor)
        path_metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(metadata.st_mode) or not exact_identity(metadata, path_metadata):
            raise SafeFailure(DIRECTORY_ERROR)
        if require_owner and metadata.st_uid != os.getuid():
            raise SafeFailure(DIRECTORY_ERROR)
        if require_private and stat.S_IMODE(metadata.st_mode) != 0o700:
            raise SafeFailure(DIRECTORY_ERROR)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def create_or_open_private_directory(parent_fd, name):
    created = False
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        created = True
    except FileExistsError:
        pass
    except OSError as error:
        raise SafeFailure(DIRECTORY_ERROR) from error
    if created:
        try:
            os.fsync(parent_fd)
        except OSError as error:
            raise SafeFailure(DIRECTORY_ERROR) from error
    return inspect_directory(parent_fd, name, True, True)


def securely_open_home(home_path):
    if not os.path.isabs(home_path) or os.path.normpath(home_path) != home_path:
        raise SafeFailure(DIRECTORY_ERROR)
    components = [component for component in home_path.split(os.sep) if component]
    if not components:
        raise SafeFailure(DIRECTORY_ERROR)
    descriptor = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, component in enumerate(components):
            child = inspect_directory(
                descriptor,
                component,
                require_owner=index == len(components) - 1,
                require_private=False,
            )
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def validate_key(metadata, expected_size):
    return (
        stat.S_ISREG(metadata.st_mode)
        and metadata.st_nlink == 1
        and metadata.st_uid == os.getuid()
        and stat.S_IMODE(metadata.st_mode) == 0o600
        and metadata.st_size == expected_size
    )


def load_or_create_key(directory_fd):
    created = False
    flags = os.O_RDWR | os.O_NOFOLLOW
    try:
        descriptor = os.open("state.key", flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory_fd)
        created = True
    except OSError as error:
        if error.errno != errno.EEXIST:
            raise SafeFailure(KEY_ERROR) from error
        try:
            descriptor = os.open("state.key", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        except OSError as open_error:
            raise SafeFailure(KEY_ERROR) from open_error

    try:
        before = os.fstat(descriptor)
        path_before = os.stat("state.key", dir_fd=directory_fd, follow_symlinks=False)
        if not validate_key(before, 0 if created else 32) or not exact_identity(before, path_before):
            raise SafeFailure(KEY_ERROR)
        if created:
            generated = secrets.token_bytes(32)
            written = 0
            while written < len(generated):
                count = os.pwrite(descriptor, generated[written:], written)
                if count <= 0:
                    raise SafeFailure(KEY_ERROR)
                written += count
            os.fsync(descriptor)
            os.fsync(directory_fd)
        after = os.fstat(descriptor)
        path_after = os.stat("state.key", dir_fd=directory_fd, follow_symlinks=False)
        if not validate_key(after, 32) or not exact_identity(before, after) or not exact_identity(after, path_after):
            raise SafeFailure(KEY_ERROR)
        key = os.pread(descriptor, 32, 0)
        if len(key) != 32 or not exact_identity(after, os.fstat(descriptor)):
            raise SafeFailure(KEY_ERROR)
        return key
    except Exception:
        if created:
            try:
                os.unlink("state.key", dir_fd=directory_fd)
                os.fsync(directory_fd)
            except OSError:
                pass
        raise
    finally:
        os.close(descriptor)


def prepare(home_path):
    home_fd = securely_open_home(home_path)
    descriptor = home_fd
    try:
        for component in (".mutil-skills", "e2e", "authority"):
            child = create_or_open_private_directory(descriptor, component)
            os.close(descriptor)
            descriptor = child
        directory_before = os.fstat(descriptor)
        key = load_or_create_key(descriptor)
        directory_after = os.fstat(descriptor)
        if not exact_identity(directory_before, directory_after):
            raise SafeFailure(DIRECTORY_ERROR)
        real_path = os.path.join(home_path, ".mutil-skills", "e2e", "authority")
        path_metadata = os.stat(real_path, follow_symlinks=False)
        if not exact_identity(directory_after, path_metadata) or os.path.realpath(real_path) != real_path:
            raise SafeFailure(DIRECTORY_ERROR)
        return {
            "ok": True,
            "schemaVersion": "1.0.0",
            "directory": {
                "realPath": real_path,
                "device": str(directory_after.st_dev),
                "inode": str(directory_after.st_ino),
                "uid": directory_after.st_uid,
                "mode": stat.S_IMODE(directory_after.st_mode),
            },
            "keyBase64Url": base64.urlsafe_b64encode(key).decode("ascii").rstrip("="),
        }
    finally:
        os.close(descriptor)


def emit(value):
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    try:
        if len(sys.argv) != 2:
            raise SafeFailure(DIRECTORY_ERROR)
        emit(prepare(sys.argv[1]))
        return 0
    except SafeFailure as error:
        emit({"ok": False, "code": error.code})
        return 70
    except Exception:
        emit({"ok": False, "code": DIRECTORY_ERROR})
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
