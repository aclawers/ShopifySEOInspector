# Shopify SEO 检查器（Tampermonkey 油猴脚本）

在任意 Shopify 店铺前台一键做 SEO 体检：右下角悬浮按钮直接显示得分，点开即可看到按优先级排序的待办清单和修复建议，支持导出 Markdown / JSON 报告。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox / Safari 均可）。
2. 打开 Tampermonkey 面板 → **添加新脚本**，把 `shopify-seo-inspector.user.js` 的全部内容粘贴进去，`Ctrl/Cmd + S` 保存。
   （或把 `.user.js` 文件直接拖进浏览器窗口，Tampermonkey 会弹出安装页。）
3. 打开任意 Shopify 店铺页面，右下角出现 🔍 按钮和分数角标。

## 使用

| 操作 | 说明 |
| --- | --- |
| 点击 🔍 / `Alt + S` | 打开或关闭面板 |
| 点击检查项 | 展开 💡 修复建议 |
| ↻ | 重新检测（会重新拉取 robots.txt、sitemap、商品 JSON） |
| 📋 复制报告 | 复制 Markdown 报告，可直接贴进飞书 / Notion / 工单 |
| `{ }` JSON | 复制结构化 JSON，便于批量归档或二次处理 |
| 🎯 标记问题图片 | 在页面上用红框标出缺少 ALT 的图片，再点一次清除 |
| 拖动面板标题栏 | 移动面板位置 |

油猴菜单（浏览器右上角 Tampermonkey 图标）里还可以：自动打开面板、在非 Shopify 站点强制启用、直接复制报告。

## 检查项

**基础 SEO** — 标题（字符数 + SERP 像素宽度）、Meta Description、Canonical（含相对路径）、meta robots / noindex 误配、H1 数量、标题层级跳级、空标题、`lang`、viewport、编码、favicon、正文字数、URL 结构（大写 / 下划线 / 过长 / 参数过多）。

**社交分享** — Open Graph 五项必需标签、og:image 尺寸声明、Twitter Card。

**结构化数据** — JSON-LD 语法错误、`@graph` 展开、页面类型与 schema 是否匹配（product→Product、article→Article、collection→CollectionPage、首页→Organization/WebSite）、Product 必填字段（name/image/offers/price/priceCurrency/availability）、brand / sku / gtin / aggregateRating 建议、priceValidUntil 过期、BreadcrumbList、Microdata、Organization 的 logo 与 sameAs。

**图片** — ALT 缺失 / 为空 / 超 125 字符、缺 width/height（CLS）、首屏外未懒加载、首屏图误用 lazy、原图远大于显示尺寸、大图未用 srcset、文件名不规范（`IMG_1234.jpg`、中文名）、未走 Shopify CDN。

**链接** — 站内外数量、`href="#"` / `javascript:` 空链接、无可读文本的链接、通用锚文本、`target="_blank"` 缺 `rel="noopener"`、nofollow/sponsored 比例、同一 URL 锚文本不一致、HTTP 混合内容。

**Shopify 专项** — 店铺域名 / 主题名 / 主题 ID / 页面类型 / locale / 货币、密码保护页、主题编辑器预览态；
- 商品页：`/collections/x/products/y` 的 canonical 归一、`?variant=` canonical、商品图数量、描述字数（页面 + 后台原文）、SKU 与 vendor 缺失、变体是否关联图片；
- 集合页：集合描述字数、分页 `rel=next/prev`、**分页 canonical 误指第一页**、筛选/排序参数页是否 noindex；
- 多语言：hreflang 自引用、x-default、重复语言代码；
- 站点级：robots.txt 可访问性与 `Disallow: /` 告警、sitemap.xml 子地图列表；
- 通过 `/products/{handle}.js` 核对**结构化数据的价格、库存与后台真实数据是否一致**（富摘要被拒的高频原因）；
- 识别 40+ 常见第三方 App 脚本（评论、弹窗、翻译、建站、追踪等）并对数量过多给出告警。

**性能** — LCP、CLS、TTFB、FCP、DOMContentLoaded、Load、请求数与分类体积、阻塞渲染资源数、最大的 5 个资源。

**工具页** — 一键跳转富媒体结果测试、Schema 验证器、PageSpeed、`site:` 收录查询、Facebook 分享调试、Search Console、robots.txt、sitemap.xml、商品 / 集合 JSON 接口，并列出本页全部原始 meta 数据。

## 得分说明

每条检查带权重，`通过 = 满分`、`警告 = 半分`、`问题 = 0 分`，`信息` 类不计分；得分 = 加权得分率。≥80 绿、60–79 黄、<60 红。分数用于横向对比同类页面，不等同于 Google 排名。

## 说明与限制

- 脚本只读页面与同源接口（robots.txt / sitemap.xml / `{handle}.js`），不发送任何数据到外部服务器。
- 默认仅在识别为 Shopify 的站点显示；非 Shopify 站点可从油猴菜单强制启用。
- LCP / CLS 取自当前这次浏览的真实用户指标，刷新后重测更准；实验室数据请以 PageSpeed Insights 为准。
- 结构化数据只做字段级检查，最终以 Google 富媒体结果测试为准。

MIT License.
