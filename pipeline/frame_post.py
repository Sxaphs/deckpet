#!/usr/bin/env python3
"""帧后处理（DeckPet pipeline）：AI 生成图 → 抠图 → 旋转变体 → 96x96 帧。

AI 图像编辑模型一次只出一张规范姿态图，本脚本负责：
  1. rembg 抠掉生成图的背景（输出透明 PNG）
  2. 按 --angles 生成旋转/平移变体（爬行左右倾、打滚 0/90/180/270 等）
  3. 统一放进 96x96 透明画布，锚点=脚底中心

用法：
    python frame_post.py --input gen.png --out-dir <dir> --action crawl --angles "-14,-6,14,6"

输出：<out-dir>/<action>-<i>.png
"""

import argparse
import sys
from pathlib import Path

from PIL import Image

SIZE = 96
TARGET_H = 72  # 人物在帧内的目标高度


def cutout(img_path: str) -> Image.Image:
    """rembg 抠图（固定 u2net_human_seg，与 cutout.py 共用已下载模型）；
    rembg 缺失时退化：直接用原图（假设已是透明底）。"""
    try:
        from rembg import new_session, remove

        with open(img_path, "rb") as f:
            result = remove(f.read(), session=new_session("u2net_human_seg"))
        from io import BytesIO

        img = Image.open(BytesIO(result)).convert("RGBA")
    except ImportError:
        print("警告：rembg 未安装，跳过抠图（生成图若不是透明底会带背景）", file=sys.stderr)
        img = Image.open(img_path).convert("RGBA")
    # 裁剪到内容边界
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    return img


def make_frame(base: Image.Image, angle: float) -> Image.Image:
    """缩放 base 到目标高度，旋转 angle 度，贴进 96x96 画布（脚底锚定底部）。"""
    scale = min(TARGET_H / base.height, TARGET_H / base.width)
    w = max(1, int(base.width * scale))
    h = max(1, int(base.height * scale))
    scaled = base.resize((w, h), Image.LANCZOS)
    rotated = scaled.rotate(-angle, resample=Image.BICUBIC, expand=True)
    frame = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    px = (SIZE - rotated.width) // 2
    py = SIZE - 8 - rotated.height
    frame.paste(rotated, (px, py), rotated)
    return frame


def main() -> int:
    ap = argparse.ArgumentParser(description="DeckPet AI 帧后处理")
    ap.add_argument("--input", required=True, help="AI 生成的原始图")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--action", required=True, help="动作名（输出文件名前缀）")
    ap.add_argument("--angles", default="0", help="逗号分隔的旋转角度列表，每个角度一帧")
    args = ap.parse_args()

    angles = [float(a) for a in args.angles.split(",") if a.strip()]
    if not angles:
        angles = [0.0]

    base = cutout(args.input)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, angle in enumerate(angles):
        make_frame(base, angle).save(out_dir / f"{args.action}-{i}.png")
    print(f"{args.action}: {len(angles)} 帧（抠图+变体）→ {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
