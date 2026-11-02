# 文献适配助手（lfa-miniprogram）

微信原生小程序 + 云开发云函数，帮研究生/研究者做两件事：

1. **帮我找文献** —— 输入课题与需求，真实检索 OpenAlex / Crossref / AMiner，返回可引用的候选文献并给出适配理由；
2. **核验已有文献** —— 粘贴或导入题名/DOI，对每一条做「是否存在 + 题名作者年份是否一致 + 与课题是否适配」的判定，并生成可导出的核验记录。

## 目录结构

```
lfa-miniprogram/
├─ pages/            # 8 个页面：index(首页) / topic(我的课题) / discover(找我文献)
│                    # import(粘贴原文) / adapt(初判) / verify(核验) / record(记录) / identity
├─ custom-tab-bar/   # 自定义 tabbar
├─ utils/            # store(本地存储) / cloud-config / verify-service / adapt-service
├─ cloudfunctions/
│   ├─ lfaVerify/    # 学术源核验：OpenAlex / Crossref / AMiner
│   └─ lfa_qwen/     # 千问模型段：题名抽取、AI 联网兜底核验
└─ project.config.json
```

## 云函数与环境

两个云函数职责分开（各自只带自己需要的环境变量）：

| 云函数 | 作用 | 需要的环境变量 |
| --- | --- | --- |
| `lfaVerify` | 学术数据库检索与核验 | `AMINER_TOKEN`（可选，AMiner 开放平台） |
| `lfa_qwen` | 题名抽取、AI 联网兜底 | `QWEN_API_KEY`（千问 API） |

> 代码里**不含任何密钥**，全部从云函数环境变量读取；未配置时对应数据源会自动跳过并在结果里说明原因。

## 本地运行

1. 用微信开发者工具导入本目录；
2. 复制配置模板并填入你自己的 AppID：
   ```bash
   cp project.config.example.json project.config.json
   ```
   然后把 `project.config.json` 里的 `appid` 换成你自己的小程序 AppID；
3. 开通云开发（环境 id 见 `utils/cloud-config.js`），分别上传部署 `lfaVerify`、`lfa_qwen` 两个云函数并配置上表环境变量；
4. 编译预览即可。

## 安全约定

- 仓库**不含**任何 AppID、AppSecret、API Key：`project.config.json` / `project.private.config.json` / `.env*`
  均已在 `.gitignore` 中忽略，仓库里只保留脱敏模板 `project.config.example.json`；
- 千问 Key（`QWEN_API_KEY`）、AMiner Token（`AMINER_TOKEN`）**只配置在云函数环境变量里**，
  代码统一从 `process.env` 读取，未配置时对应数据源自动跳过并在结果中说明原因。

## 核验流程简述

- 英文题名优先 OpenAlex / Crossref，再补 AMiner；中文题名直接走 AMiner；三源都无结果时用千问联网兜底；
- 结果区分「未找到 / 找到但不一致 / 一致且与课题适配」等状态，全部落库到本地 `store`，可在「核验记录」页查看、删除、导出。
