#!/usr/bin/env bash
# 把 promo/frames/<场景> 的帧序列拼成带字幕卡片的演示片（蒙太奇：每场景底色不同 + 淡入淡出）
set -eu
FF=/d/deckpet/.runtime/ffmpeg/bin-files/bin/ffmpeg.exe
OUT=/d/deckpet/promo
FONT="C\\:/Windows/Fonts/msyhbd.ttc"
mkdir -p "$OUT/seg"

seg() {
  local name="$1" title="$2" bg="$3" dur="$4"
  local fade_out
  fade_out=$(awk "BEGIN{print $dur - 0.4}")
  "$FF" -y -framerate 10 -i "$OUT/frames/$name/f%04d.png" -filter_complex "
    color=c=$bg:s=2560x1440:r=10:d=$dur[bg];
    [bg][0:v]overlay=0:0:shortest=1,
    drawtext=fontfile='$FONT':text='$title':x=90:y=80:fontsize=54:fontcolor=0x1a1a2e:box=1:boxcolor=white@0.85:boxborderw=26,
    scale=1280:720,
    fade=t=in:st=0:d=0.4,fade=t=out:st=$fade_out:d=0.4,
    format=yuv420p[v]" \
    -map "[v]" -t "$dur" -r 30 -c:v libx264 -preset fast -crf 20 "$OUT/seg/$name.mp4" 2>&1 | tail -1
  echo "seg $name ok"
}

seg crawl "DeckPet：你的照片，变成桌面上的小伙伴" 0xEAF2FF 6
seg lineA "单击：喊出它的台词" 0xFFF4E5 5
seg chat "双击：和 AI 聊一聊" 0xF0FFF4 5
seg drop "拎起来会害怕，摔下来自己爬起来" 0xF5EFFF 5
seg bar "拖到屏幕顶端：挂个单杠" 0xE8F8F5 6.5

printf "file '%s'\n" crawl.mp4 lineA.mp4 chat.mp4 drop.mp4 bar.mp4 > "$OUT/seg/list.txt"
(cd "$OUT/seg" && "$FF" -y -f concat -safe 0 -i list.txt -c copy all.mp4 2>&1 | tail -1)
"$FF" -y -i "$OUT/seg/all.mp4" -f lavfi -i anullsrc=r=44100:cl=stereo \
  -c:v copy -c:a aac -shortest "$OUT/deckpet-demo.mp4" 2>&1 | tail -1
echo "FINAL: $OUT/deckpet-demo.mp4"
"$FF" -i "$OUT/deckpet-demo.mp4" 2>&1 | grep -E "Duration|Stream"
