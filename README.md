# 截图审判所 · Screenshot Detective

评论之前，先审一审。

把一张截图或一段文字拆成**可核查的主张**，逐条查证，只给出三种结论：**已证实 / 证据冲突 / 暂无法核实**。查不到就说查不到，绝不编造来源。

## 架构

```
浏览器  ──POST /api/check──▶  Vercel Serverless  ──▶  Dify Web App  ──▶  元宝搜索
         (纯静态页面)          (唯一持有凭证处)        (工作流/推理)      (联网检索)
```

- `index.html` — 单文件前端，含教学案例的离线演示
- `api/check.js` — 唯一的服务端代码，负责鉴权、限流、上传与流式解析
- `信息检索.ifpkg` — Dify 应用导出包（不含任何密钥）

Dify 的 App-Code **等同于调用额度**。所以它只存在于服务端环境变量中，浏览器侧只和 `/api/check` 打交道。

## 部署

### 1. 准备 Dify 应用

1. 在 Dify 导入 `信息检索.ifpkg`
2. 在该应用的**环境变量**里填写 `YUANBAO_API_KEY`（腾讯云元宝搜索 SearchPro 的 Key）
3. 发布为 Web App，复制它的 App-Code

### 2. 部署到 Vercel

```bash
npm i -g vercel
cd screenshot-detective
vercel
```

在 Vercel 项目的 **Settings → Environment Variables** 里加：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DIFY_APP_CODE` | ✅ | Dify Web App 的 App-Code |
| `DIFY_WEB_API` | | 默认 `https://udify.app/api` |
| `RATE_LIMIT_MAX` | | 单 IP 时间窗内请求上限，默认 8 |
| `RATE_LIMIT_WIN` | | 时间窗秒数，默认 60 |

未设置 `DIFY_APP_CODE` 时接口返回 503，不会静默使用任何默认值。

### 本地开发

```bash
cp .env.example .env.local   # 填入 DIFY_APP_CODE
vercel dev
```

直接双击打开 `index.html` 只能看教学案例演示——真实查证需要服务端。

## 安全设计

- **凭证不下发前端**：前端只调用同源 `/api/check`，仓库里没有任何 App-Code 或 API Key
- **限流**：按 IP 的滑动窗口计数，超限返回 429 并带 `Retry-After`
- **输入约束**：文本截断至 8000 字符，截图上限 3.2 MB（Vercel 请求体上限 4.5 MB）
- **凭证缓存**：passport token 在实例内复用 5 分钟，遇 401/403 自动失效重取
- **结论不得超越证据**：前端解析时，标记为"已证实"但没有可点开来源的条目会被降级为"暂无法核实"

## 原则

不人肉，不定罪，不编造来源。

教学案例均为虚构。
