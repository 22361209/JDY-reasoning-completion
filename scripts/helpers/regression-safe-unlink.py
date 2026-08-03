#!/usr/bin/python3
"""Narrow fd-relative deletion primitive for regression artifacts."""

import json
import os
import stat
import sys


def fail(message):
    raise RuntimeError(message)


def exact_keys(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail(f"{label} schema is invalid")


def same_identity(metadata, expected, directory=False):
    if metadata.st_dev != expected["device"] or metadata.st_ino != expected["inode"]:
        return False
    if hasattr(os, "getuid") and metadata.st_uid != expected["uid"]:
        return False
    return stat.S_ISDIR(metadata.st_mode) if directory else True


def main():
    if len(sys.argv) != 2:
        fail("one deletion capability is required")
    capability = json.loads(sys.argv[1])
    exact_keys(capability, {"root", "ancestors", "leaf"}, "deletion capability")
    root = capability["root"]
    ancestors = capability["ancestors"]
    leaf = capability["leaf"]
    exact_keys(root, {"device", "inode", "uid"}, "root identity")
    exact_keys(leaf, {"device", "inode", "kind", "name", "nlink", "uid"}, "leaf identity")
    if leaf["kind"] not in {"file", "directory", "symlink", "other"}:
        fail("leaf kind is invalid")
    if not isinstance(ancestors, list) or not isinstance(leaf["name"], str) or not leaf["name"]:
        fail("deletion path is invalid")
    for ancestor in ancestors:
        exact_keys(ancestor, {"device", "inode", "name", "uid"}, "ancestor identity")
        if not isinstance(ancestor["name"], str) or not ancestor["name"]:
            fail("ancestor name is invalid")
    descriptors = []
    try:
        root_fd = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=3)
        descriptors.append(root_fd)
        if not same_identity(os.fstat(root_fd), root, directory=True):
            fail("artifact root identity changed")
        parent_fd = root_fd
        for ancestor in ancestors:
            next_fd = os.open(
                ancestor["name"],
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=parent_fd,
            )
            descriptors.append(next_fd)
            if not same_identity(os.fstat(next_fd), ancestor, directory=True):
                fail("artifact ancestor identity changed")
            parent_fd = next_fd
        observed = os.stat(leaf["name"], dir_fd=parent_fd, follow_symlinks=False)
        if (observed.st_dev != leaf["device"]
                or observed.st_ino != leaf["inode"]
                or observed.st_nlink != leaf["nlink"]
                or (hasattr(os, "getuid") and observed.st_uid != leaf["uid"])):
            fail("artifact leaf identity changed")
        observed_kind = "directory" if stat.S_ISDIR(observed.st_mode) else (
            "file" if stat.S_ISREG(observed.st_mode) else (
                "symlink" if stat.S_ISLNK(observed.st_mode) else "other"
            )
        )
        if observed_kind != leaf["kind"]:
            fail("artifact leaf kind changed")
        if observed_kind == "file" and observed.st_nlink != 1:
            fail("artifact leaf is multiply linked")
        if observed_kind == "directory":
            os.rmdir(leaf["name"], dir_fd=parent_fd)
        else:
            os.unlink(leaf["name"], dir_fd=parent_fd)
    finally:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(f"regression safe unlink failed: {error}\n")
        sys.exit(1)
