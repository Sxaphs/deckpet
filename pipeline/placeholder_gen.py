#!/usr/bin/env python3
"""占位素材生成器（DeckPet pipeline）。

为 sprite-contract 里的每个 SpriteAction 生成 96x96 透明背景 PNG 帧：
一个简笔"爬行小人"（圆头 + 躯干 + 四肢），角色间用 --color 区分。
同时输出严格符合 SpriteManifest 的 manifest.json。

用法：
    python placeholder_gen.py --char-id <id> --out D:/deckpet/assets/sprites/<id> \
        [--color "#4a9"] [--name "角色名"] [--appearance "形象要求文本"]

仅依赖 Pillow（见 requirements.txt）。
"""

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 96  # 帧边长（正方形）
LINE_W = 4  # 肢体线宽
# 循环动作（与 src/core/sprite-contract.ts 的 LOOP_ACTIONS 一致），帧时长 120ms
LOOP_ACTIONS = ("crawl", "climb", "hang", "roll", "rest")
LOOP_DURATION_MS = 120


# ─────────────────────────── 基础绘图 ───────────────────────────


def parse_color(s: str) -> tuple[int, int, int, int]:
    """'#4a9' / '#44aa99' → RGBA。"""
    s = s.lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) != 6:
        raise ValueError(f"无法解析颜色：{s!r}（支持 #rgb / #rrggbb）")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), 255)


def shade(color: tuple[int, int, int, int], factor: float) -> tuple[int, int, int, int]:
    """调亮/调暗（factor<1 变暗），用于区分远近肢体。"""
    r, g, b, a = color
    return (min(255, int(r * factor)), min(255, int(g * factor)), min(255, int(b * factor)), a)


def canvas() -> Image.Image:
    return Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))


def limb(draw: ImageDraw.ImageDraw, p1, p2, color, width: int = LINE_W):
    draw.line([p1, p2], fill=color, width=width)


def head(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, color, mouth: str | None = None):
    """圆头；mouth: None / 'open'（圆）/ 'half'（椭圆）/ 'closed'（横线）。"""
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    if mouth is None:
        return
    white = (255, 255, 255, 255)
    mx, my = cx, cy + r * 0.3
    if mouth == "open":
        draw.ellipse([mx - 3, my - 4, mx + 3, my + 4], fill=white)
    elif mouth == "half":
        draw.ellipse([mx - 4, my - 2, mx + 4, my + 2], fill=white)
    elif mouth == "closed":
        draw.line([mx - 4, my, mx + 4, my], fill=white, width=2)


def label(draw: ImageDraw.ImageDraw, name: str, color):
    """底部署名（可选，便于占位素材肉眼区分角色）。"""
    draw.text((SIZE / 2, SIZE - 2), name, fill=shade(color, 1.4), anchor="ms")


# ─────────────────────────── 姿态：各动作帧 ───────────────────────────
# 坐标系：96x96，锚点为脚底中心（≈ (48, 88)）。


def standing(color, mouth: str | None = None, name: str = "", right_arm: bool = True) -> Image.Image:
    """基础站姿（talk_* / wave / think 的底座）。right_arm=False 时不画右臂，
    供 wave/think 自行画举起的右臂，避免两条右臂重叠。"""
    img = canvas()
    d = ImageDraw.Draw(img)
    shoulder, hip = (48, 40), (48, 62)
    limb(d, shoulder, hip, color, 5)  # 躯干
    limb(d, shoulder, (34, 56), color)  # 左臂
    if right_arm:
        limb(d, shoulder, (62, 56), color)  # 右臂
    limb(d, hip, (40, 86), color)  # 左腿
    limb(d, hip, (56, 86), color)  # 右腿
    head(d, 48, 27, 10, color, mouth)
    if name:
        label(d, name, color)
    return img


def frames_crawl(color, name: str) -> list[Image.Image]:
    """爬行 4 帧：四肢着地，对角步态交替（左手+右脚 / 右手+左脚 相位相反）。"""
    frames = []
    # 每帧（前肢偏移, 后肢偏移），对角成对、逐帧反向
    phases = [(6, -6), (2, -2), (-6, 6), (-2, 2)]
    dark = shade(color, 0.75)
    for fa, ra in phases:
        img = canvas()
        d = ImageDraw.Draw(img)
        neck, hip = (38, 50), (64, 54)
        # 远侧肢体（暗色先画，垫在近侧下面）
        limb(d, neck, (36 - fa, 80), dark)
        limb(d, hip, (62 - ra, 80), dark)
        limb(d, neck, hip, color, 5)  # 水平躯干
        limb(d, neck, (36 + fa, 80), color)  # 近侧前臂
        limb(d, hip, (62 + ra, 80), color)  # 近侧后腿
        head(d, 28, 42, 9, color)
        if name:
            label(d, name, color)
        frames.append(img)
    return frames


def frames_climb(color, name: str) -> list[Image.Image]:
    """攀爬 4 帧：竖直姿态，双臂上下交替，双腿交替蹬踏。"""
    frames = []
    phases = [(18, 44, 72, 82), (26, 38, 76, 78), (44, 18, 82, 72), (38, 26, 78, 76)]
    for hand_l_y, hand_r_y, foot_l_y, foot_r_y in phases:
        img = canvas()
        d = ImageDraw.Draw(img)
        shoulder, hip = (48, 34), (48, 58)
        limb(d, shoulder, hip, color, 5)
        limb(d, shoulder, (36, hand_l_y), color)  # 左臂
        limb(d, shoulder, (60, hand_r_y), color)  # 右臂
        limb(d, hip, (40, foot_l_y), color)  # 左腿
        limb(d, hip, (56, foot_r_y), color)  # 右腿
        head(d, 48, 21, 9, color)
        if name:
            label(d, name, color)
        frames.append(img)
    return frames


def frames_hang(color, name: str) -> list[Image.Image]:
    """悬挂 2 帧：双手抓上沿、身体下垂，两帧轻微左右摆动。"""
    frames = []
    for sway in (-4, 4):
        img = canvas()
        d = ImageDraw.Draw(img)
        hand_l, hand_r = (40, 12), (56, 12)
        shoulder_l, shoulder_r = (44 + sway, 34), (52 + sway, 34)
        hip = (48 + sway, 58)
        limb(d, hand_l, shoulder_l, color)
        limb(d, hand_r, shoulder_r, color)
        limb(d, ((shoulder_l[0] + shoulder_r[0]) / 2, 34), hip, color, 5)
        limb(d, hip, (44 + sway * 2, 84), color)
        limb(d, hip, (52 + sway * 2, 84), color)
        head(d, 48 + sway, 25, 9, color)
        if name:
            label(d, name, color)
        frames.append(img)
    return frames


def frames_roll(color, name: str) -> list[Image.Image]:
    """打滚 4 帧：蜷缩成团，整体旋转 0/90/180/270 度。"""
    frames = []
    dark = shade(color, 0.75)
    cx, cy, body_r = 48, 54, 16
    for deg in (0, 90, 180, 270):
        img = canvas()
        d = ImageDraw.Draw(img)
        a = math.radians(deg)
        d.ellipse([cx - body_r, cy - body_r, cx + body_r, cy + body_r], fill=color)
        # 头贴在团外侧，随角度旋转
        hx, hy = cx + (body_r + 6) * math.cos(a), cy + (body_r + 6) * math.sin(a)
        head(d, hx, hy, 8, dark)
        # 两条蜷缩肢体短划线，同样随角度旋转
        for off in (math.radians(50), -math.radians(50)):
            p1 = (cx + (body_r - 4) * math.cos(a + off), cy + (body_r - 4) * math.sin(a + off))
            p2 = (cx + (body_r + 4) * math.cos(a + off), cy + (body_r + 4) * math.sin(a + off))
            limb(d, p1, p2, dark, 3)
        if name:
            label(d, name, color)
        frames.append(img)
    return frames


def frames_rest(color, name: str) -> list[Image.Image]:
    """休息 2 帧：0=坐姿闭眼，1=趴姿。"""
    frames = []
    dark = shade(color, 0.75)
    # 帧 0：坐姿闭眼
    img = canvas()
    d = ImageDraw.Draw(img)
    hip = (44, 70)
    limb(d, hip, (44, 46), color, 5)  # 躯干
    limb(d, (44, 52), (58, 64), color)  # 手臂搭膝
    limb(d, hip, (68, 74), color)  # 前伸腿
    limb(d, hip, (64, 82), dark)
    head(d, 44, 36, 9, color)
    d.line([40, 35, 43, 35], fill=(255, 255, 255, 255), width=1)  # 闭眼
    d.line([46, 35, 49, 35], fill=(255, 255, 255, 255), width=1)
    if name:
        label(d, name, color)
    frames.append(img)
    # 帧 1：趴姿
    img = canvas()
    d = ImageDraw.Draw(img)
    limb(d, (34, 78), (66, 82), color, 5)  # 水平躯干
    limb(d, (46, 80), (54, 90), color)  # 手臂垂地
    limb(d, (66, 82), (84, 86), color)  # 后腿
    limb(d, (64, 84), (80, 90), dark)
    head(d, 26, 74, 9, color)
    if name:
        label(d, name, color)
    frames.append(img)
    return frames


def frames_talk(color, name: str) -> dict[str, list[Image.Image]]:
    """口型三帧：站姿，嘴部 圆 / 椭圆 / 横线。"""
    return {
        "talk_open": [standing(color, "open", name)],
        "talk_half": [standing(color, "half", name)],
        "talk_closed": [standing(color, "closed", name)],
    }


def frames_wave(color, name: str) -> list[Image.Image]:
    """挥手 2 帧：站姿，右手举起两个摆动位置。"""
    frames = []
    for hand in ((68, 20), (58, 10)):
        img = standing(color, "closed", name, right_arm=False)
        d = ImageDraw.Draw(img)
        limb(d, (48, 40), hand, shade(color, 1.2))  # 举起的右臂
        frames.append(img)
    return frames


def frames_jump(color, name: str) -> list[Image.Image]:
    """蹦跳 2 帧：四肢张开跃起，0=展开最高点，1=收拢回落。"""
    frames = []
    poses = [
        # (头y, 肩y, 髋y, 左手, 右手, 左脚, 右脚)
        (18, 32, 52, (30, 20), (66, 20), (34, 62), (62, 62)),
        (24, 38, 58, (34, 14), (62, 14), (42, 66), (54, 66)),
    ]
    for hy, sy, py, hl, hr, fl, fr in poses:
        img = canvas()
        d = ImageDraw.Draw(img)
        shoulder, hip = (48, sy), (48, py)
        limb(d, shoulder, hip, color, 5)
        limb(d, shoulder, hl, color)
        limb(d, shoulder, hr, color)
        limb(d, hip, fl, color)
        limb(d, hip, fr, color)
        head(d, 48, hy, 10, color, "open")
        if name:
            label(d, name, color)
        frames.append(img)
    return frames


def frames_sit_sad(color, name: str) -> list[Image.Image]:
    """沮丧坐姿 1 帧：低头、躯干前倾。"""
    img = canvas()
    d = ImageDraw.Draw(img)
    hip = (46, 70)
    limb(d, hip, (54, 52), color, 5)  # 前倾躯干
    limb(d, (54, 56), (60, 72), color)  # 垂落手臂
    limb(d, hip, (70, 78), color)
    limb(d, hip, (66, 84), shade(color, 0.75))
    head(d, 58, 45, 9, color)  # 低垂的头
    if name:
        label(d, name, color)
    return [img]


def frames_think(color, name: str) -> list[Image.Image]:
    """思考 1 帧：站姿，右手弯曲扶头。"""
    img = standing(color, "closed", name, right_arm=False)
    d = ImageDraw.Draw(img)
    limb(d, (48, 40), (60, 44), shade(color, 1.2))  # 右臂上段
    limb(d, (60, 44), (55, 20), shade(color, 1.2))  # 前臂折回摸头
    return [img]


# ─────────────────────────── 抠图模式：用真实形象变换出帧 ───────────────────────────


def load_base(path: str) -> Image.Image:
    """载入抠图 PNG，等比缩放到高度 ≤ 72px（96 帧内留活动余量）。"""
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    scale = min(72 / h, 72 / w, 1.5)
    return img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)


def base_frame(base: Image.Image, angle: float = 0, dx: float = 0, dy: float = 0) -> Image.Image:
    """抠图本体变换成帧：绕中心旋转 + 平移，锚点近似脚底中心。"""
    img = canvas()
    rotated = base.rotate(-angle, resample=Image.BICUBIC, center=(base.width / 2, base.height / 2))
    px = SIZE / 2 - rotated.width / 2 + dx
    py = SIZE - 8 - rotated.height + dy
    img.paste(rotated, (int(px), int(py)), rotated)
    return img


def base_mouth(base: Image.Image, mouth: str) -> Image.Image:
    """口型帧：在抠图上部中央叠加简单嘴型（粗近似，正式素材走 AI 生成）。"""
    img = base_frame(base)
    d = ImageDraw.Draw(img)
    mx, my = SIZE / 2, SIZE - 8 - base.height * 0.62
    dark = (60, 40, 30, 255)
    if mouth == "open":
        d.ellipse([mx - 4, my - 5, mx + 4, my + 5], fill=dark)
    elif mouth == "half":
        d.ellipse([mx - 5, my - 2, mx + 5, my + 2], fill=dark)
    else:
        d.line([mx - 5, my, mx + 5, my], fill=dark, width=2)
    return img


def build_frames_from_image(base: Image.Image) -> dict[str, list[Image.Image]]:
    """用抠图本体生成全套动作帧（变换近似姿态，保留真实长相/服装）。"""
    return {
        # 爬行：左右倾斜交替 + 轻微上下颠
        "crawl": [base_frame(base, a, 0, b) for a, b in ((-14, 0), (-6, -3), (14, 0), (6, -3))],
        # 攀爬：竖直，小幅左右摆
        "climb": [base_frame(base, a, 0, b) for a, b in ((-8, 0), (0, -4), (8, 0), (0, -4))],
        # 悬挂：下摆晃动
        "hang": [base_frame(base, a, 0, 6) for a in (-10, 10)],
        # 打滚：整体旋转
        "roll": [base_frame(base, deg, 0, 0) for deg in (0, 90, 180, 270)],
        # 休息：几乎静止（抠图本体已是 upright，轻微起伏即可）
        "rest": [base_frame(base, 0, 0, 0), base_frame(base, 2, 0, 0)],
        "talk_open": [base_mouth(base, "open")],
        "talk_half": [base_mouth(base, "half")],
        "talk_closed": [base_mouth(base, "closed")],
        # 挥手/蹦跳/沮丧/思考：倾斜与位移近似
        "wave": [base_frame(base, -18), base_frame(base, -6)],
        "jump": [base_frame(base, 0, 0, -12), base_frame(base, 0, 0, 0)],
        "sit_sad": [base_frame(base, 10, 0, 6)],
        "think": [base_frame(base, -8)],
        "scared": [base_frame(base, -8, 0, -4), base_frame(base, 8, 0, -4)],
        "fall_sit": [base_frame(base, 75, 0, 4)],  # 仰面躺倒
        "get_up": [base_frame(base, -30, 0, 2)],  # 半起身
    }


def frames_scared(color, name: str) -> list[Image.Image]:
    """害怕挣扎 2 帧（被拎起时）：瞪眼张嘴、四肢张开慌乱摆动。"""
    frames = []
    for sway in (-5, 5):
        img = canvas()
        d = ImageDraw.Draw(img)
        shoulder, hip = (48 + sway, 36), (48 - sway, 60)
        limb(d, shoulder, hip, color, 5)
        limb(d, shoulder, (30 + sway * 2, 20), color)  # 左臂挥
        limb(d, shoulder, (66 + sway * 2, 20), color)  # 右臂挥
        limb(d, hip, (36 - sway, 84), color)  # 左腿蹬
        limb(d, hip, (60 - sway, 84), color)  # 右腿蹬
        # 头 + 惊恐表情（瞪圆眼 + 大嘴）
        hx, hy = 48 + sway, 23
        head(d, hx, hy, 10, color)
        d.ellipse([hx - 5, hy - 4, hx - 2, hy], fill=(255, 255, 255, 255))
        d.ellipse([hx + 2, hy - 4, hx + 5, hy], fill=(255, 255, 255, 255))
        d.ellipse([hx - 3, hy + 2, hx + 3, hy + 7], fill=(60, 40, 30, 255))  # 大张的嘴
        if name:
            label(d, name, color)
        frames.append(img)
    return frames


def frames_fall_sit(color, name: str) -> list[Image.Image]:
    """摔倒屁股着地 1 帧：后仰坐姿、双腿翘起、吃痛表情（>_<）。"""
    img = canvas()
    d = ImageDraw.Draw(img)
    hip = (46, 72)
    limb(d, hip, (38, 50), color, 5)  # 后仰躯干
    limb(d, hip, (64, 58), color)  # 抬起的左腿
    limb(d, hip, (68, 66), shade(color, 0.75))  # 抬起的右腿
    limb(d, (38, 50), (24, 68), color)  # 撑地的手
    head(d, 34, 40, 10, color)
    d.line([30, 39, 33, 42], fill=(60, 40, 30, 255), width=2)  # >_<
    d.line([36, 39, 39, 42], fill=(60, 40, 30, 255), width=2)
    if name:
        label(d, name, color)
    return [img]


def frames_get_up(color, name: str) -> list[Image.Image]:
    """爬起来 1 帧：单手撑地、半起身。"""
    img = canvas()
    d = ImageDraw.Draw(img)
    hip = (52, 66)
    limb(d, hip, (44, 44), color, 5)  # 半起的躯干
    limb(d, (46, 48), (34, 78), color)  # 撑地的手臂
    limb(d, hip, (66, 84), color)  # 跪着的腿
    limb(d, hip, (56, 86), shade(color, 0.75))
    head(d, 42, 33, 10, color)
    if name:
        label(d, name, color)
    return [img]


# ─────────────────────────── 生成入口 ───────────────────────────


def build_frames(color, name: str) -> dict[str, list[Image.Image]]:
    """动作名 → 帧列表，覆盖 sprite-contract 的全部 12 个 SpriteAction。"""
    frames: dict[str, list[Image.Image]] = {
        "crawl": frames_crawl(color, name),
        "climb": frames_climb(color, name),
        "hang": frames_hang(color, name),
        "roll": frames_roll(color, name),
        "rest": frames_rest(color, name),
        "wave": frames_wave(color, name),
        "jump": frames_jump(color, name),
        "sit_sad": frames_sit_sad(color, name),
        "think": frames_think(color, name),
        "scared": frames_scared(color, name),
        "fall_sit": frames_fall_sit(color, name),
        "get_up": frames_get_up(color, name),
    }
    frames.update(frames_talk(color, name))
    return frames


def main() -> int:
    ap = argparse.ArgumentParser(description="DeckPet 占位素材生成器")
    ap.add_argument("--char-id", required=True, help="角色 id（写入 manifest.characterId）")
    ap.add_argument("--out", required=True, help="输出目录，如 D:/deckpet/assets/sprites/<id>")
    ap.add_argument("--color", default="#4a9", help="角色主题色，#rgb 或 #rrggbb")
    ap.add_argument("--name", default="", help="角色名（画在帧底部，便于肉眼区分）")
    ap.add_argument("--appearance", default="", help="形象要求文本（仅记录进 manifest）")
    ap.add_argument("--base-image", default="", help="抠图 PNG 路径：用真实形象变换出帧（保留长相/服装）")
    args = ap.parse_args()

    try:
        color = parse_color(args.color)
    except ValueError as e:
        print(f"错误：{e}", file=sys.stderr)
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 抠图模式：有 --base-image 时用真实形象；否则程序化占位小人
    source = "placeholder"
    if args.base_image:
        base = load_base(args.base_image)
        frames = build_frames_from_image(base)
        source = "cutout"
    else:
        frames = build_frames(color, args.name)
    manifest_frames: dict[str, list[dict]] = {}
    total = 0
    for action, images in frames.items():
        entries = []
        for i, img in enumerate(images):
            fname = f"{action}-{i}.png"
            img.save(out_dir / fname)
            entry: dict = {"file": fname, "width": SIZE, "height": SIZE}
            if action in LOOP_ACTIONS:
                entry["durationMs"] = LOOP_DURATION_MS
            entries.append(entry)
            total += 1
        manifest_frames[action] = entries

    # 严格符合 src/core/sprite-contract.ts 的 SpriteManifest
    manifest = {
        "characterId": args.char_id,
        "source": source,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "frames": manifest_frames,
    }
    if args.appearance:
        manifest["appearanceRequest"] = args.appearance

    with open(out_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"已生成 {total} 帧 + manifest.json → {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
