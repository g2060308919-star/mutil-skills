#!/usr/bin/env python3
import base64
import errno
import fcntl
import json
import os
import stat
import subprocess
import sys
import uuid


def fail(code, message):
    print(json.dumps({"ready": False, "code": code, "message": message}), flush=True)
    sys.exit(73)


def filesystem_type(path):
    if sys.platform == "darwin":
        result = subprocess.run(["/sbin/mount"], check=True, capture_output=True, text=True, timeout=5)
        target = os.path.realpath(path)
        matches = []
        for line in result.stdout.splitlines():
            if " on " not in line or " (" not in line:
                continue
            mountpoint = line.split(" on ", 1)[1].split(" (", 1)[0].replace("\\040", " ")
            if target == mountpoint or target.startswith(mountpoint.rstrip("/") + "/"):
                kind = line.split(" (", 1)[1].split(",", 1)[0].rstrip(")")
                matches.append((len(mountpoint), kind))
        if not matches:
            fail("E2E_ARTIFACT_FILESYSTEM_UNSUPPORTED", "mount point not found")
        return max(matches)[1].lower()
    elif sys.platform.startswith("linux"):
        command = ["/usr/bin/stat", "-f", "-c", "%T", path]
    else:
        fail("E2E_ARTIFACT_FILESYSTEM_UNSUPPORTED", "unsupported platform")
    result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=5)
    return result.stdout.strip().lower()


def assert_local_filesystem(path):
    kind = filesystem_type(path)
    forbidden = ("nfs", "smb", "cifs", "afp", "webdav", "fuse", "sshfs")
    allowed = ("apfs", "hfs", "ext2/ext3", "ext4", "xfs", "btrfs", "zfs", "overlayfs", "tmpfs")
    if any(name in kind for name in forbidden) or not any(name in kind for name in allowed):
        fail("E2E_ARTIFACT_FILESYSTEM_UNSUPPORTED", "filesystem is not approved: " + kind)
    return kind


def validate_part(part):
    if not part or part in (".", "..") or "\\" in part or ":" in part or "\x00" in part:
        raise ValueError("unsafe path segment")


def split_path(path):
    if not isinstance(path, str) or path.startswith("/"):
        raise ValueError("path must be relative")
    parts = path.split("/")
    for part in parts:
        validate_part(part)
    return parts


def open_absolute_directory(path, create):
    absolute = os.path.abspath(path)
    parts = [part for part in absolute.split(os.sep) if part]
    fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts:
            validate_part(part)
            created = False
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                    created = True
                except FileExistsError:
                    pass
            if created:
                os.fsync(fd)
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except Exception:
        os.close(fd)
        raise


def open_directory(root_fd, parts, create=False):
    fd = os.dup(root_fd)
    try:
        for part in parts:
            created = False
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                    created = True
                except FileExistsError:
                    pass
            if created:
                os.fsync(fd)
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except Exception:
        os.close(fd)
        raise


def parent_and_name(root_fd, path, create_parent=False):
    parts = split_path(path)
    return open_directory(root_fd, parts[:-1], create_parent), parts[-1]


def assert_regular(handle):
    info = os.fstat(handle)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise OSError(errno.EPERM, "file must be regular with one link")
    return info


def crash_at(request, point):
    if request.get("crashAt") == point:
        os._exit(91)


def io_fault_at(request):
    if request.get("crashAt") == "raise-enospc":
        raise OSError(errno.ENOSPC, "simulated disk full")
    if request.get("crashAt") == "raise-eacces":
        raise OSError(errno.EACCES, "simulated permission denied")


def write_all(handle, data):
    view = memoryview(data)
    written = 0
    while written < len(view):
        count = os.write(handle, view[written:])
        if count == 0:
            raise OSError(errno.EIO, "short write")
        written += count


def write_new(root_fd, path, data, request):
    parent, name = parent_and_name(root_fd, path, True)
    try:
        io_fault_at(request)
        handle = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            assert_regular(handle)
            write_all(handle, data)
            os.fsync(handle)
            crash_at(request, "after-file-fsync")
        finally:
            os.close(handle)
        os.fsync(parent)
        crash_at(request, "after-parent-fsync")
    finally:
        os.close(parent)


def write_atomic(root_fd, path, data, request):
    parent, name = parent_and_name(root_fd, path, True)
    temporary = ".next-" + uuid.uuid4().hex
    try:
        handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            assert_regular(handle)
            write_all(handle, data)
            os.fsync(handle)
            crash_at(request, "after-temp-fsync")
        finally:
            os.close(handle)
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        crash_at(request, "after-rename")
        os.fsync(parent)
        crash_at(request, "after-parent-fsync")
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)


def read_file(root_fd, path):
    parent, name = parent_and_name(root_fd, path)
    try:
        handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            before = assert_regular(handle)
            chunks = []
            while True:
                chunk = os.read(handle, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            after = assert_regular(handle)
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
            ):
                raise OSError(errno.EBUSY, "file changed while reading")
            return b"".join(chunks)
        finally:
            os.close(handle)
    finally:
        os.close(parent)


def remove_entry(parent_fd, name):
    info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode):
        raise OSError(errno.ELOOP, "symlink forbidden")
    if stat.S_ISDIR(info.st_mode):
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            for nested in os.listdir(child):
                remove_entry(child, nested)
            os.fsync(child)
        finally:
            os.close(child)
        os.rmdir(name, dir_fd=parent_fd)
    elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
        os.unlink(name, dir_fd=parent_fd)
    else:
        raise OSError(errno.EPERM, "special or hard-linked file forbidden")


def remove_tree(root_fd, path, request):
    parent, name = parent_and_name(root_fd, path)
    try:
        try:
            remove_entry(parent, name)
            os.fsync(parent)
            crash_at(request, "after-remove-fsync")
        except FileNotFoundError:
            pass
    finally:
        os.close(parent)


def rename_entry(root_fd, source, target, request):
    source_parent, source_name = parent_and_name(root_fd, source)
    target_parent, target_name = parent_and_name(root_fd, target, True)
    try:
        source_info = os.stat(source_name, dir_fd=source_parent, follow_symlinks=False)
        if not stat.S_ISDIR(source_info.st_mode):
            raise OSError(errno.EPERM, "rename source must be a directory")
        source_handle = os.open(
            source_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source_parent
        )
        os.close(source_handle)
        try:
            os.stat(target_name, dir_fd=target_parent, follow_symlinks=False)
            raise OSError(errno.EEXIST, "rename target already exists")
        except FileNotFoundError:
            pass
        os.rename(source_name, target_name, src_dir_fd=source_parent, dst_dir_fd=target_parent)
        crash_at(request, "after-rename")
        os.fsync(source_parent)
        if source_parent != target_parent:
            os.fsync(target_parent)
        crash_at(request, "after-parent-fsync")
    finally:
        os.close(source_parent)
        os.close(target_parent)


def list_entries(root_fd, path):
    directory = open_directory(root_fd, split_path(path)) if path else os.dup(root_fd)
    try:
        return sorted(os.listdir(directory))
    finally:
        os.close(directory)


def list_files(root_fd, path):
    directory = open_directory(root_fd, split_path(path))
    files = []
    try:
        walk_files(directory, "", files)
        return sorted(files, key=lambda item: item["path"])
    finally:
        os.close(directory)


def walk_files(directory_fd, prefix, files):
    for name in sorted(os.listdir(directory_fd)):
        validate_part(name)
        relative = prefix + name
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                walk_files(child, relative + "/", files)
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            files.append({"path": relative, "byteLength": info.st_size})
        else:
            raise OSError(errno.EPERM, "symlink, hard link, or special file forbidden")


def process(root_fd, request):
    operation = request.get("operation")
    if operation == "mkdir":
        directory = open_directory(root_fd, split_path(request["path"]), True)
        os.fsync(directory)
        os.close(directory)
        return None
    if operation == "writeNew":
        write_new(root_fd, request["path"], base64.b64decode(request["data"], validate=True), request)
        return None
    if operation == "writeAtomic":
        write_atomic(root_fd, request["path"], base64.b64decode(request["data"], validate=True), request)
        return None
    if operation == "read":
        return base64.b64encode(read_file(root_fd, request["path"])).decode("ascii")
    if operation == "removeTree":
        remove_tree(root_fd, request["path"], request)
        return None
    if operation == "rename":
        rename_entry(root_fd, request["source"], request["target"], request)
        return None
    if operation == "list":
        return list_entries(root_fd, request.get("path", ""))
    if operation == "listFiles":
        return list_files(root_fd, request["path"])
    if operation == "syncDirectory":
        directory = open_directory(root_fd, split_path(request["path"])) if request.get("path") else os.dup(root_fd)
        os.fsync(directory)
        crash_at(request, "after-directory-fsync")
        os.close(directory)
        return None
    raise ValueError("unknown operation")


try:
    root_fd = open_absolute_directory(sys.argv[1], True)
    fs_type = assert_local_filesystem(sys.argv[1])
    try:
        lock_fd = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
    except FileNotFoundError:
        fail("E2E_ARTIFACT_ROOT_RACE", "asset root changed during first concurrent creation")
    assert_regular(lock_fd)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fail("E2E_ARTIFACT_LOCKED", "asset is locked")
    print(json.dumps({"ready": True, "filesystemType": fs_type}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = process(root_fd, request)
            print(json.dumps({"id": request.get("id"), "ok": True, "result": result}), flush=True)
        except Exception as error:
            if isinstance(error, FileNotFoundError):
                code = "E2E_ARTIFACT_NOT_FOUND"
            elif isinstance(error, OSError) and error.errno == errno.ENOSPC:
                code = "E2E_ARTIFACT_DISK_FULL"
            elif isinstance(error, OSError) and error.errno in (errno.EACCES, errno.EPERM):
                code = "E2E_ARTIFACT_PERMISSION_DENIED"
            else:
                code = "E2E_ARTIFACT_PATH_UNSAFE" if isinstance(error, (OSError, ValueError)) else "E2E_ARTIFACT_HELPER_ERROR"
            print(json.dumps({"id": request.get("id"), "ok": False, "code": code, "message": str(error)}), flush=True)
finally:
    try:
        os.close(lock_fd)
        os.close(root_fd)
    except Exception:
        pass
