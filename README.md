# 医考刷题 · 外科学与儿科学随机组卷

一个纯静态的随机组卷刷题站点：按章节抽题组卷，答完自动判分，逐题回顾答案与解析。
不需要登录、不需要后端、不需要安装，打开网页就能用。

- 在线地址：`https://serene-sigh.github.io/medreview-bank/`（启用 GitHub Pages 后生效）
- 技术形态：无构建步骤的原生 HTML / CSS / JS，题库以数据文件形式随站点发布

## 功能

- **组卷**：学科 → 模块 → 章节三级勾选，题量 25 / 50 / 100，可按章节比例或每章平均抽题
- **两种模式**：考试模式（交卷后统一看答案）、练习模式（选完即判并展开解析）
- **判分**：得分、正确率、用时、章节表现
- **回顾**：正确项绿标、错选红标，显示你的答案与正确答案，完整解析（含表格、加粗、列表）
- **错题本**：答错的题自动收录，可一键重练
- **历史记录**：最近 30 次试卷，可回看当次每道题
- 键盘 `A`–`E` / `1`–`5` 作答，`←` `→` 翻题；支持手机浏览器

## 题库

| 学科 | 结构 | 题量 | 可抽 |
|---|---|---|---|
| 外科学 | 8 模块 / 71 章节 | 8,000（单选 7,366） | 7,201 |
| 儿科学 | 1 模块 / 17 章节 | 3,427（单选 3,027） | 2,987 |
| 合计 | | **11,427** | 10,188 |

> 简答题已入库但不参与抽题；缺图题（147 道）与重复题干题（68 道，部分重叠）默认排除。

## 数据与隐私

- **没有后端、没有数据库、没有任何第三方请求**（无统计脚本、无外部字体 CDN）。
- 作答记录、错题本、历史成绩保存在浏览器 **`sessionStorage`**：
  - 同一标签页内**刷新不丢**；
  - **关闭标签页即清空**；
  - **新开标签页是空白**，不同用户/设备之间互不影响。
- 站点本身不采集、不上传任何信息。

## 本地使用

直接双击 `index.html` 即可（`file://` 下也能正常使用）。
若浏览器限制 `file://` 的会话存储，可在目录里执行 `python -m http.server 8765`，然后访问 `http://127.0.0.1:8765/`。

## 部署（GitHub Pages）

```bash
git remote add origin https://github.com/Serene-Sigh/medreview-bank.git
git branch -M main
git push -u origin main
```

然后在仓库 **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)` → Save**，
等约 1 分钟即可通过 `https://serene-sigh.github.io/medreview-bank/` 访问。

本站没有构建步骤，`main` 分支根目录就是发布内容；`.nojekyll` 用于跳过 Jekyll 处理。

## 更新题库

题库由 `tools/build_bank.py` 从 Excel 生成（脚本不在本仓库内，属于本地工具）：

```powershell
python tools/build_bank.py --all   # 重新生成 data/ 下所有学科
```

生成后刷新页面确认，再提交推送，Pages 会在一分钟左右自动更新：

```bash
git add -A && git commit -m "chore: 更新题库" && git push
```

浏览器可能缓存旧的 JS，更新后按 `Ctrl+F5` 强制刷新。

## 目录结构

```
index.html              入口
assets/css/app.css      样式（蓝白配色）
assets/js/md.js         解析渲染（Markdown / 内联 HTML → 安全 HTML）
assets/js/engine.js     抽题与判分（纯函数）
assets/js/store.js      会话内存储（sessionStorage）
assets/js/app.js        页面与交互
data/subjects.js        学科注册表
data/surgery/           外科学数据（index + m0…m7）
data/pediatrics/        儿科学数据（index + m0）
```

## 免责声明

题库整理自人卫版教材配套习题，版权归原出版方所有，本项目仅用于个人复习，请勿用于商业用途或大规模公开传播。
如涉及版权问题，请联系删除。
