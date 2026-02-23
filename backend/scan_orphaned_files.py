#!/usr/bin/env python3
"""扫描并清理遗留的临时文件和 upload_store 条目。

用法:
    python scan_orphaned_files.py                    # 仅扫描，不删除
    python scan_orphaned_files.py --clean            # 扫描并清理（需要确认）
    python scan_orphaned_files.py --clean --force     # 扫描并直接清理（无需确认）
"""
import logging
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# 导入 upload_store 公开 API（需要从 backend 目录运行）
try:
    from app.api.upload_store import list_upload_entries, remove_upload_entry
except ImportError:
    print("错误: 请从 backend 目录运行此脚本")
    print("   cd backend && python scan_orphaned_files.py")
    sys.exit(1)


def format_size(size: int) -> str:
    """格式化文件大小。"""
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024.0:
            return f"{size:.2f} {unit}"
        size /= 1024.0
    return f"{size:.2f} TB"


def scan_upload_store() -> dict:
    """扫描 upload_store 中的条目，检查文件是否存在。"""
    entries = list_upload_entries()
    results = {
        "total_entries": len(entries),
        "existing_files": [],
        "orphaned_entries": [],  # 条目存在但文件不存在
    }

    if not entries:
        return results

    print(f"\n📦 检查 upload_store 中的 {len(entries)} 个条目...")

    for upload_id, temp_path, filename in entries:
        if os.path.exists(temp_path):
            size = os.path.getsize(temp_path) if os.path.isfile(temp_path) else 0
            results["existing_files"].append({
                "upload_id": upload_id,
                "path": temp_path,
                "filename": filename,
                "size": size,
            })
        else:
            results["orphaned_entries"].append({
                "upload_id": upload_id,
                "path": temp_path,
                "filename": filename,
            })
    
    return results


def scan_temp_directory() -> dict:
    """扫描临时目录中的遗留文件。"""
    temp_dir = Path(tempfile.gettempdir())
    results = {
        "upload_files": [],  # upload_* 文件
        "audio_split_dirs": [],  # audio_split_* 目录
    }
    
    print(f"\n📁 扫描临时目录: {temp_dir}")
    
    try:
        # 扫描 upload_* 文件
        for item in temp_dir.iterdir():
            if item.is_file() and item.name.startswith("upload_"):
                size = item.stat().st_size
                results["upload_files"].append({
                    "path": str(item),
                    "size": size,
                })
            elif item.is_dir() and item.name.startswith("audio_split_"):
                # 计算目录总大小
                total_size = 0
                file_count = 0
                try:
                    for f in item.rglob("*"):
                        if f.is_file():
                            total_size += f.stat().st_size
                            file_count += 1
                except OSError:
                    pass
                
                results["audio_split_dirs"].append({
                    "path": str(item),
                    "size": total_size,
                    "file_count": file_count,
                })
    except PermissionError:
        print(f"⚠️  无法访问临时目录: {temp_dir}")
    
    return results


def print_scan_results(upload_store_results: dict, temp_dir_results: dict):
    """打印扫描结果。"""
    print("\n" + "=" * 70)
    print("扫描结果")
    print("=" * 70)
    
    # upload_store 结果
    print(f"\n📦 upload_store:")
    print(f"  总条目数: {upload_store_results['total_entries']}")
    
    if upload_store_results["existing_files"]:
        print(f"  ✅ 文件仍存在: {len(upload_store_results['existing_files'])} 个")
        total_size = 0
        for item in upload_store_results["existing_files"]:
            print(f"    - {item['upload_id'][:8]}... | {item['filename']} | {format_size(item['size'])}")
            total_size += item["size"]
        print(f"    总大小: {format_size(total_size)}")
    
    if upload_store_results["orphaned_entries"]:
        print(f"  ⚠️  孤立条目（文件已删除）: {len(upload_store_results['orphaned_entries'])} 个")
        for item in upload_store_results["orphaned_entries"]:
            print(f"    - {item['upload_id'][:8]}... | {item['filename']} | 文件不存在")
    
    # 临时目录结果
    print(f"\n📁 临时目录中的遗留文件:")
    
    if temp_dir_results["upload_files"]:
        print(f"  📄 upload_* 文件: {len(temp_dir_results['upload_files'])} 个")
        total_size = 0
        for item in temp_dir_results["upload_files"]:
            print(f"    - {item['path']} | {format_size(item['size'])}")
            total_size += item["size"]
        print(f"    总大小: {format_size(total_size)}")
    else:
        print(f"  📄 upload_* 文件: 0 个")
    
    if temp_dir_results["audio_split_dirs"]:
        print(f"  📂 audio_split_* 目录: {len(temp_dir_results['audio_split_dirs'])} 个")
        total_size = 0
        for item in temp_dir_results["audio_split_dirs"]:
            print(f"    - {item['path']} | {format_size(item['size'])} ({item['file_count']} 个文件)")
            total_size += item["size"]
        print(f"    总大小: {format_size(total_size)}")
    else:
        print(f"  📂 audio_split_* 目录: 0 个")
    
    # 总结
    total_orphaned = (
        len(upload_store_results["existing_files"]) +
        len(upload_store_results["orphaned_entries"]) +
        len(temp_dir_results["upload_files"]) +
        len(temp_dir_results["audio_split_dirs"])
    )
    
    print(f"\n📊 总结:")
    print(f"  发现遗留资源: {total_orphaned} 个")
    
    if total_orphaned == 0:
        print("  ✅ 没有遗留文件！")
    else:
        print("  ⚠️  发现遗留文件，可以使用 --clean 选项清理")


def clean_orphaned_files(
    upload_store_results: dict,
    temp_dir_results: dict,
    force: bool = False
) -> dict:
    """清理遗留文件。"""
    cleaned = {
        "upload_store_entries": 0,
        "upload_files": 0,
        "audio_split_dirs": 0,
        "errors": [],
    }
    
    if not force:
        print("\n⚠️  确认清理？这将删除所有遗留文件。")
        response = input("输入 'yes' 继续，其他任意键取消: ")
        if response.lower() != "yes":
            print("❌ 已取消清理")
            return cleaned
    
    print("\n🧹 开始清理...")
    
    # 清理 upload_store 中的条目
    if upload_store_results["existing_files"] or upload_store_results["orphaned_entries"]:
        print(f"\n  清理 upload_store 条目...")
        for item in upload_store_results["existing_files"]:
            try:
                if remove_upload_entry(item["upload_id"]):
                    cleaned["upload_store_entries"] += 1
            except Exception as e:
                logger.debug("Remove upload_store entry failed", exc_info=True)
                cleaned["errors"].append(f"删除 {item['path']}: {e}")

        for item in upload_store_results["orphaned_entries"]:
            if remove_upload_entry(item["upload_id"]):
                cleaned["upload_store_entries"] += 1
    
    # 清理临时目录中的 upload_* 文件
    if temp_dir_results["upload_files"]:
        print(f"\n  清理 upload_* 文件...")
        for item in temp_dir_results["upload_files"]:
            try:
                os.unlink(item["path"])
                cleaned["upload_files"] += 1
            except Exception as e:
                logger.debug("Unlink upload file failed", exc_info=True)
                cleaned["errors"].append(f"删除 {item['path']}: {e}")
    
    # 清理临时目录中的 audio_split_* 目录
    if temp_dir_results["audio_split_dirs"]:
        print(f"\n  清理 audio_split_* 目录...")
        for item in temp_dir_results["audio_split_dirs"]:
            try:
                shutil.rmtree(item["path"], ignore_errors=True)
                cleaned["audio_split_dirs"] += 1
            except Exception as e:
                logger.debug("Rmtree audio_split dir failed", exc_info=True)
                cleaned["errors"].append(f"删除 {item['path']}: {e}")
    
    print("\n✅ 清理完成！")
    print(f"  清理的 upload_store 条目: {cleaned['upload_store_entries']}")
    print(f"  清理的 upload_* 文件: {cleaned['upload_files']}")
    print(f"  清理的 audio_split_* 目录: {cleaned['audio_split_dirs']}")
    
    if cleaned["errors"]:
        print(f"\n⚠️  清理过程中的错误 ({len(cleaned['errors'])} 个):")
        for error in cleaned["errors"]:
            print(f"    - {error}")
    
    return cleaned


def main():
    clean_mode = "--clean" in sys.argv
    force_mode = "--force" in sys.argv
    
    print("🔍 扫描遗留的临时文件和 upload_store 条目...")
    
    # 扫描
    upload_store_results = scan_upload_store()
    temp_dir_results = scan_temp_directory()
    
    # 打印结果
    print_scan_results(upload_store_results, temp_dir_results)
    
    # 如果需要清理
    if clean_mode:
        clean_orphaned_files(upload_store_results, temp_dir_results, force=force_mode)
    else:
        print("\n💡 提示: 使用 --clean 选项可以清理这些遗留文件")
        print("   使用 --clean --force 可以跳过确认直接清理")


if __name__ == "__main__":
    main()
