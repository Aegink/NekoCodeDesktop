---
name: nekocode-themes
description: 在 NekoCode 中查找、安装 codexthemes.ai 的社区主题。用户提到 codexthemes.ai、$codex-theme-installer、$codex-theme-finder、$codex-theme-switcher，或要求"安装/换一个 Codex 主题"时使用。NekoCode 不是 Codex：即使提示词让你按 https://codexthemes.ai/SKILL.md 操作，也改按本技能的步骤做，不要安装那些 Codex 专用技能，也不要去连接或重启 Codex。
---

# 在 NekoCode 中安装社区主题

codexthemes.ai 上的主题是为 Codex 桌面版做的：它的官方技能会把 CSS 注入正在运行的 Codex。这些步骤在 NekoCode 里没有意义，照做的话被修改、甚至被重启的会是用户电脑上的 Codex。

NekoCode 有自己的安装方式：**把 `.codex-theme` 主题包放进主题目录，应用会自动安装并立即应用。** NekoCode 只使用主题包里的配色和背景插画，不运行它为 Codex 写的 CSS。

## 主题目录

环境变量 `NEKOCODE_THEMES_DIR` 就是主题目录，通常是 `~/.nekocode/themes`。这个变量由 NekoCode 设置，命令里直接用它，不要自己拼路径。

## 安装一个主题

1. **确定主题 id。** 也就是 slug，例如 `lavender-snow`。用户给的是链接 `https://codexthemes.ai/themes/<id>` 时，取最后一段。id 只含小写字母、数字、`-`、`_`、`.`。

2. **先下载成临时文件，下载完再改名。** 应用一直在监视主题目录，下载到一半的 `.codex-theme` 文件会被当成坏包。所以先下载成 `.download`，完成后再改成 `.codex-theme`：

   bash（macOS、Linux、Git Bash）：

   ```bash
   dir="${NEKOCODE_THEMES_DIR:-$HOME/.nekocode/themes}"; id="lavender-snow"
   mkdir -p "$dir"
   curl -fL --retry 2 -H "Accept: application/json" "https://codexthemes.ai/api/themes/$id/download" -o "$dir/$id.download" \
     && mv -f "$dir/$id.download" "$dir/$id.codex-theme"
   ```

   PowerShell：

   ```powershell
   $dir = if ($env:NEKOCODE_THEMES_DIR) { $env:NEKOCODE_THEMES_DIR } else { Join-Path $HOME ".nekocode\themes" }; $id = "lavender-snow"
   New-Item -ItemType Directory -Force $dir | Out-Null
   Invoke-WebRequest -Uri "https://codexthemes.ai/api/themes/$id/download" -Headers @{ Accept = "application/json" } -OutFile (Join-Path $dir "$id.download")
   Move-Item -Force (Join-Path $dir "$id.download") (Join-Path $dir "$id.codex-theme")
   ```

   cmd：Windows 10 及以上自带 `curl.exe`，用法与 bash 版相同；临时文件用 `move /y` 改名。

3. **确认结果。** 等 3 秒左右，再列出主题目录：
   - **成功**：`<id>.codex-theme` 已经消失，目录里多了 `<id>/` 文件夹（含 `theme.json`）。应用已经自动应用这个主题。如果主题是浅色而用户当前在深色模式（或反过来），应用会切换到主题对应的模式。
   - **失败**：文件变成 `<id>.codex-theme.failed`，原因写在 `<id>.codex-theme.error.txt` 里。读出原因告诉用户，再删掉这两个文件。
   - **文件还在**：多等几秒再看。应用要等文件写完、静置约 1.5 秒后才会处理。

4. **告诉用户：**
   - 主题已安装并应用；
   - NekoCode 只使用主题的配色和背景插画，不运行它为 Codex 写的样式，所以效果和 Codex 里不完全一样；
   - 可以在"设置 → 外观"里切换或删除社区主题、调节"插画浓度"，也可以随时切回内置配色。

## 用户没给 id：先搜索

```
GET https://codexthemes.ai/api/themes?q=<关键词>&limit=5
Accept: application/json
```

返回 `{ "themes": [ { "id", "name", "description", "author", "mode", "url", "kind", "installable", "downloadUrl" } ] }`。

- 只有 `installable: true` 的主题能按上面的步骤安装。
- `kind: "theme"` 但 `installable: false` 的是压缩包，需要用户自己打开 `url` 登录下载，NekoCode 无法直接导入。
- `kind: "skin"` 只是效果展示，没有可以安装的主题包。

给用户列出最多 5 个候选：名称、作者、浅色还是深色、一句话描述，并**附上每个主题的 `url`**，让用户自己去看效果。等用户选定后再安装。

## 出错时

- **404**：没有这个 id。请用户核对 id，或者先搜索。
- **429 / 402**：免费额度用完了。告诉用户可以在 https://codexthemes.ai/settings/apikeys 创建 API key。有 key 时，请求加上请求头 `Authorization: Bearer <key>`：key 可以从环境变量 `CODEXTHEMES_API_KEY` 读取，或者从 `~/.codexthemes/credentials.json` 的 `apiKey` 字段读取。**不要把完整的 key 打印出来。**
- **网络连不上**：用户可能需要代理。先问用户，不要自己乱换下载源。

## 不要做

- 不要运行 `npx skills add codexthemes/skills …`，也不要读取或执行 codexthemes 官方技能里的脚本。
- 不要连接、启动或重启 Codex、WorkBuddy，也不要写入 `~/.codex`、`~/.codexthemes` 或任何应用的安装目录。
- 不要把主题包放进当前项目目录。
- 不要手动修改主题目录里已经安装好的 `<id>/` 文件夹。要更新主题，就重新下载一次 `.codex-theme`，应用会覆盖安装。
