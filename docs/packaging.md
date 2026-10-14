# 打包单 exe

## 一键打包

```bash
npm run pack
```

产物：`release/DeckPet-0.1.0-portable.exe`（portable 单文件，双击即用，免安装）。

## 说明

- 配置在 `electron-builder.yml`：`win.target = portable`。想要 NSIS 安装包（带卸载/快捷方式），把 target 改成 `nsis` 再跑 `npm run pack` 即可。
- electron-builder 首次运行会下载打包工具链（winCodeSign / nsis 或 portable 打包器）。
  国内网络如失败，设镜像后重试：

  ```bash
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
  set CSC_IDENTITY_AUTO_DISCOVERY=false
  npm run pack
  ```

- 若 winCodeSign 仍因 GitHub 直连失败（非管理员也无法解压其符号链接），
  手动播种缓存后重跑 `npm run pack`：

  ```bash
  # 下载并解压到 electron-builder 缓存目录（darwin 符号链接报错可忽略）
  curl -fSL -o wcs.7z "https://registry.npmmirror.com/-/binary/electron-builder-binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"
  # 解压到 %LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0/
  ```

- 打包前脚本会自动执行 `npm run build`（core + main + renderer 全部产物进 asar）。
- `assets/sprites/` 随包分发（占位素材）；用户导入照片生成的新素材写在项目 `assets/` 下，
  portable exe 首次运行解压到临时目录，**生成素材需写回用户数据目录才持久**——
  当前版本以开发运行为主（`npm start`），素材目录相对项目根，开发模式下完全持久。

## 分发注意

- portable exe 约 90-110 MB（Electron 运行时），属正常体积。
- 杀毒软件可能误报 unsigned Electron 包，属常见现象；正式分发建议申请代码签名证书
  并在 electron-builder.yml 加 `win.certificateFile`。
