#!/usr/bin/env python3
"""照片抠图（DeckPet pipeline）。

用法：
    python cutout.py --input <photo> --out-dir <dir>

输出 cutout-1.png …（透明背景 PNG）。优先使用 u2net_human_seg 模型，
失败回退 u2net。

注意：rembg 是整图显著性分割，不支持实例分割——多人照片目前会把
所有人作为一个整体抠出（单个 cutout）。
TODO: 实例级分割待接 SAM（segment-anything），届时逐个实例输出
      cutout-1.png / cutout-2.png …。
"""

import argparse
import sys
from pathlib import Path

try:
    from rembg import new_session, remove
except ImportError:
    print(
        "错误：未安装 rembg。请先安装 pipeline 依赖：\n"
        "  python -m venv pipeline/.venv && pipeline/.venv/Scripts/pip install -r pipeline/requirements.txt",
        file=sys.stderr,
    )
    sys.exit(2)


def main() -> int:
    ap = argparse.ArgumentParser(description="DeckPet 照片抠图")
    ap.add_argument("--input", required=True, help="输入照片路径")
    ap.add_argument("--out-dir", required=True, help="输出目录")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.is_file():
        print(f"错误：找不到输入文件 {src}", file=sys.stderr)
        return 1
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    data = src.read_bytes()

    # 人体分割模型优先；下载失败或效果异常时回退通用模型
    for model in ("u2net_human_seg", "u2net"):
        try:
            print(f"使用模型 {model} 抠图…")
            session = new_session(model)
            result = remove(data, session=session)
            break
        except Exception as e:  # noqa: BLE001 —— 模型下载/推理失败都允许回退
            print(f"模型 {model} 失败：{e}", file=sys.stderr)
            if model == "u2net":
                print("错误：所有模型均失败。", file=sys.stderr)
                return 1
    else:
        return 1

    out = out_dir / "cutout-1.png"
    out.write_bytes(result)
    print(f"已输出 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
