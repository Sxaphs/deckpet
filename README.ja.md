# DeckPet — エージェントCLIのフロントエンドとしてのデスクトップペット

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語** | [한국어](README.ko.md) | [Español](README.es.md)

Windows 10/11 向けデスクトップペットアプリ。写真をアップロードすると、キャラクターが切り抜かれ、這い回るスプライトに描き直され、デスクトップ上に住み着きます——ウィンドウの縁を這い、ぶら下がり、吹き出しで会話します（音声なし・テキストのみ）。内部では実際のエージェントバックエンド（ACP 経由の Kimi Code CLI、DeepSeek Harness、OpenAI 互換 API）と連携し、ファイル書き込みやコマンド実行はすべて独立した権限レイヤーがゲートします。

## 特徴

- **写真→ペット**：rembg 切り抜き + AI ポーズ再描画（Volcengine Seedream i2i または OpenAI 互換画像 API）で、15 アクションのフルスプライトセット（這う・登る・ぶら下がる・転がる・休憩・口パク3種・手を振る・ジャンプ・落ち込む・考える・怖がる・転んで起きる）を生成。画像 API がなくても、手続き型プリセットスプライトですぐ動きます。
- **デスクトップランタイム**：全画面・透明・常に最前面。空白部分はクリックスルー、ペット本体はドラッグ可能（慣性で投げる・転んで起き上がる）。Win32 でリアルタイムにウィンドウを列挙し、上端を這い、側面を登り、画面上端で鉄棒のようにぶら下がります。
- **kimi web 風チャット**：クリック=決め台詞、ダブルクリック=チャット吹き出し。ストリーミング応答・口パク・長文は要約に折りたたみ「全部表示」リーダーパネル（Markdown+コードハイライト）。DEV トグルでツール呼び出し過程を表示、全過程はローカル Web ログページへ。
- **マルチエージェント4層構成**：表現層(renderer) → オーケストレータ（ルーティング、協業モード：分解→報告→集約）→ アダプタ（プラグイン登録 driver：ACP / dsh / openai-http）→ 権限レイヤー（fs書込/shell/通信の唯一のゲート）。
- **権限**：読取専用 / 毎回確認 / 自動実行 をキャラごとに。ディレクトリ白リスト、コマンド黒リスト、通信スイッチ、イントラ例外。秘密情報は Windows DPAPI で暗号化し、平文では保存しません。
- **Web コンソール**（`http://127.0.0.1:17890`）：写真アップロード、キー設定、外見プロンプト調整、スプライトのバージョン保存・切替・削除、リマインダー管理。

## クイックスタート（ポータブル exe）

1. Releases から `DeckPet-<version>-portable.exe` をダウンロードして実行。
2. 初回起動：内蔵の**ナイロン（奶龙）**ペットがすぐデスクトップに現れ（設定不要）、同時に**設定ページ**が自動で開きます：
   - バックエンド追加——Kimi Code CLI があるなら `kimi acp` が簡単（type: acp、command: kimi、args: acp）。または OpenAI 互換エンドポイントと API キー。
   - （任意）画像 API キーを入力すると AI ポーズスプライトが有効に。
   - 写真をアップロード → ナイロンを自分の写真のペットに差し替え。
3. 操作：**クリック**=台詞、**ダブルクリック**=チャット、**ドラッグ**=持ち上げ（怖がります）、画面上端で離す=鉄棒ぶら下がり、右クリック=メニュー。トレイアイコン：表示切替・設定・Web コンソール・終了。

要件：Windows 10/11 x64。ACP バックエンドには対応するエージェント CLI のインストールとサインインが必要です。AI スプライトには画像編集 API キー（Volcengine Ark 推奨・無料枠 約500 回）が必要です。

## 開発

Node.js ≥ 20 と Python ≥ 3.10（Python は任意：rembg 切り抜きと AI 素材後処理のみ）。

```bash
npm install
npm run build
npm start        # ペット起動
npm test         # vitest：権限/折りたたみ/感情/オーケストレータ
npm run pack     # electron-builder → release/ にポータブル exe
```

エージェントコアの CLI 検証（GUI なし）：

```bash
npm run build:core
node dist/core/cli/index.js backends add --type acp --name Kimi --command kimi --args "acp"
node dist/core/cli/index.js chars add --id char-1 --name 相棒 --line-a "やあ！"
node dist/core/cli/index.js chat --char char-1 "一言で自己紹介して"
node dist/core/cli/index.js collab --chars char-1,char-2 --task "スローガンを考えて"
```

## アーキテクチャ

```
src/renderer/   表現層（DOM/TS のみ、window.deckpet IPC 経由）
src/main/       Electron メイン：ウィンドウ/IPC/Win32/トレイ/Webコンソール
src/core/orchestrator/  ルーティング、セッション、マルチエージェント協業
src/core/adapters/      Driver プラグインレジストリ（acp / dsh / openai-http）
src/core/permission/    ポリシーエンジン——危険操作はすべて authorize() 経由
pipeline/               素材パイプライン（cutout.py / placeholder_gen.py /
                        frame_post.py / gen_frames.ts）
```

層間契約は `src/core/types.ts`、`src/core/ipc-contract.ts`、`src/core/sprite-contract.ts` に集約。新しいバックエンド追加は [docs/adapter-api.md](docs/adapter-api.md)、実行詳細は [docs/run.md](docs/run.md)、パッケージは [docs/packaging.md](docs/packaging.md) を参照。

## データの保存先

- 設定と履歴：`%USERPROFILE%/.deckpet/`（`DECKPET_HOME` で変更可）
- 秘密情報：`%USERPROFILE%/.deckpet/keys/`（DPAPI 暗号化）
- スプライト：パッケージ版は `%APPDATA%/deckpet/assets/sprites/`、開発時は `assets/sprites/`

## 注意事項

- DeepSeek Harness は developer preview で完全なセキュリティ監査を受けていません。その承認プラグインだけに依存せず、DeckPet の権限レイヤーが常に最終判断を行います。
- AI スプライト生成は API 呼び出しを消費します（1キャラ全套 15 回）。再生成前に自動アーカイブされ、Web コンソールからいつでも旧版に切り替えられます。

## ライセンス

MIT
