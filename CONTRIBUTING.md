# 贡献指南

## 环境

- Node.js >= 22（用到全局 `fetch` 和 `WebSocket`）
- 系统已安装 Chrome 或 Edge
- 无第三方 npm 依赖，`npm install` 只装开发工具（如有）

## 目录

```
src/cdp.js      CDP 客户端（原生 WebSocket）
src/chrome.js   启动/发现 Chrome
src/page.js     页面封装（evaluate/goto/click/scroll/screenshot/网络监听）
src/tiktok.js   采集器：列表/详情/店铺/关键词/类目 + 过滤
src/erp.js      ERP 客户端（cookie 直连 / 页面双模式）
src/where.js    条件表达式 DSL
src/pipeline.js 编排
src/cli.js      命令行
src/server.js   本地 Web UI
public/         前端
test/smoke.js   离线单测（不联网、不开浏览器）
```

## 提交前

```bash
node test/smoke.js     # 必须全绿
node --check src/*.js  # 语法
```

## 红线

- **不要提交 cookies.json、任何 cookie/token、账号 ID、店铺名、手机号**
- 不要在代码里硬编码个人路径（`C:\Users\你的名字`、`E:\某目录`）
- 新增选择器请在注释里写明「何时实测、对应页面结构」，方便别人日后修
- 涉及第三方站点的抓取，频率要克制
