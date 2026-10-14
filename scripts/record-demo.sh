#!/usr/bin/env bash
# 录制 DeckPet 演示片各场景帧（每场景一次独立 app 启动）
set -u
export PATH="/d/deckpet/.runtime/node:$PATH"
cd /d/deckpet
E=./node_modules/electron/dist/electron.exe
OUT=D:/deckpet/promo/frames

run_scene() {
  local name="$1" js="$2" dur="$3"
  rm -rf "$OUT/$name"
  echo "=== scene $name ==="
  DECKPET_SMOKE_VIDEO="$OUT/$name" DECKPET_SMOKE_JS="$js" \
    DECKPET_SMOKE_DELAY=600 DECKPET_SMOKE_DURATION="$dur" DECKPET_SMOKE_FPS=10 \
    "$E" . 2>&1 | grep -E "smoke|error" | tail -2
}

run_scene crawl "" 6000
run_scene lineA "__petDebug.lineA('char-3')" 5000
run_scene drop "__petDebug.drop('char-6')" 5000
run_scene bar "__petDebug.bar('char-6')" 6500
run_scene chat "__petDebug.openChat('char-6'); setTimeout(()=>{const i=document.querySelector('.dp-bubble-input'); if(i){i.value='帮我把这个文件整理一下'; i.dispatchEvent(new Event('input',{bubbles:true}));}},1000);" 5000
echo "ALL-SCENES-DONE"
ls "$OUT"
