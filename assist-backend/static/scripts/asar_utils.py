#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asar_utils.py - 纯 Python3 实现的 Electron ASAR 解包/打包工具
无需 Node.js 或 npm，仅依赖 Python3 标准库。

ASAR 二进制格式 (基于 Chromium Pickle 序列化):
  ┌──────────────────────────────────────────────────────────┐
  │ Size Pickle (8 bytes):                                   │
  │   [4 bytes] payloadSize = 4 (UInt32 LE, 固定值)          │
  │   [4 bytes] headerBuf.length (UInt32 LE)                 │
  ├──────────────────────────────────────────────────────────┤
  │ Header Pickle (headerBuf.length bytes):                  │
  │   [4 bytes] payloadSize (UInt32 LE, 对齐后的载荷大小)     │
  │   [4 bytes] JSON string length (UInt32 LE)               │
  │   [N bytes] JSON header string (UTF-8)                   │
  │   [P bytes] Padding (null bytes, 4字节对齐)               │
  ├──────────────────────────────────────────────────────────┤
  │ File Contents (所有文件内容依次拼接)                       │
  └──────────────────────────────────────────────────────────┘

  data_offset = 8 + headerBuf.length
  文件实际位置 = data_offset + file.offset

用法:
  python3 asar_utils.py extract <asar_file> <output_dir>
  python3 asar_utils.py pack <input_dir> <output_asar>
"""

import json
import os
import struct
import sys


def align4(n):
    """将数字向上对齐到 4 的倍数"""
    return n + (4 - n % 4) % 4


# ============================================================
# ASAR 读取 (Extract)
# ============================================================

def read_asar_header(f):
    """
    从打开的 asar 文件中读取并解析 JSON header。
    返回 (header_dict, data_offset)
    """
    # Size Pickle: 8 bytes
    size_pickle = f.read(8)
    if len(size_pickle) < 8:
        raise ValueError("文件太小，不是有效的 ASAR 文件")

    pickle_payload_size, header_buf_length = struct.unpack('<II', size_pickle)
    # pickle_payload_size 应该固定为 4

    # Header Pickle: headerBuf.length bytes
    header_buf = f.read(header_buf_length)
    if len(header_buf) < header_buf_length:
        raise ValueError("ASAR 头部数据不完整")

    # 解析 Header Pickle 内部结构
    header_payload_size = struct.unpack('<I', header_buf[0:4])[0]
    json_string_size = struct.unpack('<I', header_buf[4:8])[0]
    json_bytes = header_buf[8:8 + json_string_size]

    header = json.loads(json_bytes.decode('utf-8'))

    # 数据区起始偏移 = Size Pickle (8 bytes) + Header Pickle (headerBuf.length bytes)
    data_offset = 8 + header_buf_length

    return header, data_offset


def extract_files(f, node, current_path, data_offset):
    """递归提取文件"""
    if 'files' in node:
        # 目录节点
        os.makedirs(current_path, exist_ok=True)
        for name, child in node['files'].items():
            child_path = os.path.join(current_path, name)
            extract_files(f, child, child_path, data_offset)
    elif 'offset' in node and not node.get('unpacked', False):
        # 已打包的文件节点
        parent_dir = os.path.dirname(current_path)
        if parent_dir:
            os.makedirs(parent_dir, exist_ok=True)

        offset = int(node['offset'])
        size = int(node['size'])

        f.seek(data_offset + offset)
        content = f.read(size)

        with open(current_path, 'wb') as out:
            out.write(content)

        # 保留可执行标记
        if node.get('executable', False):
            os.chmod(current_path, 0o755)
    elif node.get('unpacked', False):
        # unpacked 文件跳过（这些文件在 .asar.unpacked 目录中）
        pass
    elif 'link' in node:
        # 符号链接节点
        pass


def do_extract(asar_path, output_dir):
    """执行解包"""
    with open(asar_path, 'rb') as f:
        header, data_offset = read_asar_header(f)
        extract_files(f, header, output_dir, data_offset)
    print(f"[asar_utils] 解包完成: {output_dir}")


# ============================================================
# ASAR 写入 (Pack)
# ============================================================

def build_header_and_files(input_dir, original_header=None):
    """
    遍历目录，构建 ASAR header JSON 和文件内容列表。
    如果提供了 original_header，会保留 unpacked 文件的元信息。
    返回 (header_dict, file_list)
    file_list 中每个元素为 (absolute_path, offset, size)
    """
    file_list = []
    current_offset = 0

    def get_original_node(orig, path_parts):
        """从原始 header 中查找节点"""
        if orig is None:
            return None
        node = orig
        for part in path_parts:
            if 'files' in node and part in node['files']:
                node = node['files'][part]
            else:
                return None
        return node

    def walk_dir(dir_path, path_parts=None):
        nonlocal current_offset
        if path_parts is None:
            path_parts = []

        node = {"files": {}}
        try:
            entries = sorted(os.listdir(dir_path))
        except PermissionError:
            return node

        for entry in entries:
            # 跳过 macOS 系统文件
            if entry in ('.DS_Store', '__MACOSX', '.git'):
                continue

            full_path = os.path.join(dir_path, entry)
            child_parts = path_parts + [entry]

            if os.path.isdir(full_path):
                node["files"][entry] = walk_dir(full_path, child_parts)
            elif os.path.isfile(full_path):
                file_size = os.path.getsize(full_path)
                file_node = {
                    "offset": str(current_offset),
                    "size": file_size
                }
                # 保留可执行标记
                if os.access(full_path, os.X_OK):
                    file_node["executable"] = True

                node["files"][entry] = file_node
                file_list.append((full_path, current_offset, file_size))
                current_offset += file_size

        # 将原始 header 中的 unpacked 文件合并回来
        orig_node = get_original_node(original_header, path_parts)
        if orig_node and 'files' in orig_node:
            for name, child in orig_node['files'].items():
                if name not in node['files']:
                    if is_unpacked_node(child):
                        node['files'][name] = strip_integrity(child)

        return node

    header = walk_dir(input_dir)
    return header, file_list


def is_unpacked_node(node):
    """判断节点是否为 unpacked 类型（递归检查）"""
    if node.get('unpacked', False):
        return True
    if 'files' in node:
        # 目录节点，检查是否所有子节点都是 unpacked
        for child in node['files'].values():
            if not is_unpacked_node(child):
                return False
        return True
    return False


def strip_integrity(node):
    """递归移除节点中的 integrity 字段"""
    if isinstance(node, dict):
        result = {}
        for k, v in node.items():
            if k == 'integrity':
                continue
            result[k] = strip_integrity(v)
        return result
    return node


def do_pack(input_dir, output_path, original_asar_path=None):
    """执行打包"""
    # 如果提供了原始 ASAR，读取其 header 以保留 unpacked 信息
    original_header = None
    if original_asar_path and os.path.isfile(original_asar_path):
        with open(original_asar_path, 'rb') as f:
            original_header, _ = read_asar_header(f)

    header, file_list = build_header_and_files(input_dir, original_header)

    # 移除顶层的 integrity 字段（内容已修改，hash 失效）
    header = strip_integrity(header)

    # 序列化 JSON header
    header_json = json.dumps(header, ensure_ascii=False, separators=(',', ':'))
    header_bytes = header_json.encode('utf-8')
    json_string_size = len(header_bytes)

    # Chromium Pickle 对齐: payload 需要 4 字节对齐
    aligned_payload_size = align4(4 + json_string_size)  # 4 = json_string_size 字段
    padding_size = aligned_payload_size - 4 - json_string_size

    # headerBuf.length = 4 (payloadSize 字段) + aligned_payload_size
    header_buf_length = 4 + aligned_payload_size

    with open(output_path, 'wb') as f:
        # ---- Size Pickle (8 bytes) ----
        f.write(struct.pack('<I', 4))                  # payloadSize = 4 (固定)
        f.write(struct.pack('<I', header_buf_length))  # headerBuf.length

        # ---- Header Pickle (header_buf_length bytes) ----
        f.write(struct.pack('<I', aligned_payload_size))  # payloadSize
        f.write(struct.pack('<I', json_string_size))      # JSON 字符串长度
        f.write(header_bytes)                              # JSON 字符串
        f.write(b'\x00' * padding_size)                    # 对齐填充

        # ---- File Data ----
        for file_path, offset, size in file_list:
            with open(file_path, 'rb') as src:
                remaining = size
                while remaining > 0:
                    chunk_size = min(remaining, 1024 * 1024)  # 1MB chunks
                    chunk = src.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)

    print(f"[asar_utils] 打包完成: {output_path}")


# ============================================================
# 主入口
# ============================================================

def main():
    if len(sys.argv) < 2:
        print_usage()
        sys.exit(1)

    command = sys.argv[1].lower()

    if command == 'extract':
        if len(sys.argv) < 4:
            print("用法: python3 asar_utils.py extract <asar_file> <output_dir>")
            sys.exit(1)
        asar_file = sys.argv[2]
        output_dir = sys.argv[3]
        if not os.path.isfile(asar_file):
            print(f"[错误] 文件不存在: {asar_file}")
            sys.exit(1)
        do_extract(asar_file, output_dir)

    elif command == 'pack':
        if len(sys.argv) < 4:
            print("用法: python3 asar_utils.py pack <input_dir> <output_asar> [original_asar]")
            sys.exit(1)
        input_dir = sys.argv[2]
        output_asar = sys.argv[3]
        original_asar = sys.argv[4] if len(sys.argv) > 4 else None
        if not os.path.isdir(input_dir):
            print(f"[错误] 目录不存在: {input_dir}")
            sys.exit(1)
        do_pack(input_dir, output_asar, original_asar)

    else:
        print(f"[错误] 未知命令: {command}")
        print_usage()
        sys.exit(1)


def print_usage():
    print("用法:")
    print("  python3 asar_utils.py extract <asar_file> <output_dir>          - 解包 ASAR")
    print("  python3 asar_utils.py pack <input_dir> <output_asar> [orig]     - 打包 ASAR")
    print("     [orig] 可选, 原始 ASAR 路径, 用于保留 unpacked 文件元信息")


if __name__ == '__main__':
    main()
