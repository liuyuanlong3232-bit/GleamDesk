# 数据与素材使用记录

核对日期：2026-10-27。范围是本仓库当前接入方式，不是“所有用途均已获授权”的结论。**本项目 MIT 许可不替代数据源条款、素材许可和商标权。**“公开可访问”“不需要密钥”“免费”都不等于可以商业再分发。

软件从用户电脑直接请求已启用的数据源，不由作者 VPS 汇总后转售。仓库不打包作者的实时行情库、账户或连接配置。各来源可在设置中关闭。以下记录区分条款已经核对的条件和仍需向权利方核实的范围；本次保留来源功能，没有将未明事项自动认定为允许。

## 数据来源

| 来源与当前用途 | 核对结果与条件 | 仍需处理 |
| --- | --- | --- |
| Open-Meteo：九个代表位置的天气，7 天最高温与降水总和 | **有条件。** [数据许可](https://open-meteo.com/en/licence)为 CC BY 4.0，要求署名、许可链接及说明改动；[免费 API 条款](https://open-meteo.com/en/terms)限非商业用途，另有调用限额。天气页保留来源并补充许可链接和汇总方法。 | 商业产品、广告或订阅用途不能仅沿用免费服务。当前无广告的个人/非营利使用与条款示例相符是本项目的理解，不是单独授权函。访问接口不等于复制其 AGPL 服务端代码。 |
| Natural Earth：内置简化世界底图 | **已确认版权使用条件。** [条款](https://www.naturalearthdata.com/about/terms-of-use/)将栅格和矢量数据列为公有领域；本项目仍保留来源链接。 | 公有领域说明不代替不同地区地图出版、边界表达要求的判断。 |
| ECB：参考汇率 | **有条件。** [统计再利用规则](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html)允许免费再利用公开统计，要求注明来源、不修改原统计及元数据；第三方数据例外。 | 保持来源、日期、货币对和单位；本地换算不能冒充 ECB 原值。 |
| ECB：新闻 RSS | **有条件。** [网站版权规则](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html)允许准确引用直接提供的信息并标注 ECB，修改须说明；署名论文等有例外。 | 不将统计数据规则泛化到所有图像、署名文章或第三方内容。 |
| Federal Reserve Board：货币政策 RSS | **有条件。** [官方声明](https://www.federalreserve.gov/disclaimer.htm)称无其他标记时信息为公有领域，要求注明 Board；第三方内容和官方印章另受限制。 | 保留文章来源与链接，不以机构名称或印章暗示背书。该规则不能套用到 St. Louis Fed/FRED。 |
| NOAA NCEI：美国站点 GHCND 历史天气 | **已找到官方开放数据政策。** [NOAA 政策](https://www.noaa.gov/organization/information-technology/policy-oversight)说明数据默认开放，法律明确限制的情况除外。 | 随数据保留站点、日期、单位和缺测，不把站点代表整个产区；新增数据集时重新检查例外。 |
| Gold API（`api.gold-api.com`）：金银参考价 | **部分确认。** [官方 FAQ](https://gold-api.com/faqs)明确实时接口无需密钥、允许商业应用、不强制署名，提示缓存与禁止滥用；当前客户端 300 秒缓存。 | [完整条款](https://gold-api.com/terms)本轮读取超时，仍需复核完整条款及上游限制。不是名称相似的 goldapi.io。不能承诺交易所级实时准确性。 |
| World Bank Pink Sheet：月度商品参考价工作簿 | **具体数据集许可待核实。** [官方页面](https://www.worldbank.org/en/research/commodity-markets)提供工作簿；[目录 FAQ](https://datacatalog.worldbank.org/faq)明确并非所有数据都同一许可或由 World Bank 拥有。 | 获取 Pink Sheet 本身及相关第三方系列的适用许可；不以一般 CC BY 政策替代。 |
| FRED：可选月价 CSV，PMAIZMTUSDM、PWHEAMTUSDM、PCOTTINDUSDM、PSUGAISAUSDM | **有限制，未完成用途核实。** [FRED 条款](https://fred.stlouisfed.org/legal/)要求来源署名，逐序列版权可能不同，并对与软件/系统开发、训练及 AI 有关的用途作广泛限制。当前客户端使用 `graph/fredgraph.csv`，不是带 API key 的 API。 | 需核实具体序列权利、CSV 访问方式及本应用用途，不将数据送入 AI 功能或训练作为当然获准事项。没有联系权利方或取得书面例外；本轮未擅自替换用户选择的来源。 |
| USDA WASDE、AMS 出口检验、NASS 年产/种植进度 | **具体报告条件待补。** 官方入口分别为 [WASDE](https://www.usda.gov/oce/commodity/wasde)、[AMS](https://www.ams.usda.gov/market-news)、[ESMIS](https://esmis.nal.usda.gov/)。[USDA 总政策](https://www.usda.gov/about-usda/policies-and-links)提示部分材料可能受其他权利限制。 | 逐项记录报告/表格的权利声明，保留来源及不代表 USDA 背书的现有说明；不能仅以美国政府网站推断每份附件均无限制。 |
| CFTC：农业管理基金持仓 | **具体数据再利用条款待补。** 来自 [CFTC Public Reporting](https://publicreporting.cftc.gov/)，保留市场代码、仅期货口径及持仓日期。 | 核对平台/API 与数据集本身的条款，不能把平台开源软件许可当成数据许可。 |
| IBGE SIDRA：巴西全国作物统计 | **具体表格许可待补。** [SIDRA API](https://apisidra.ibge.gov.br/)表 6588。 | 补齐该表的引用方式、许可及 API 访问要求；机构身份不代替授权。 |
| CONAB：巴西月度全国估产 | **具体工作簿许可待补。** [官方报告页](https://www.gov.br/conab/pt-br/atuacao/informacoes-agropecuarias/safras/safra-de-graos/boletim-da-safra-de-graos)。 | 核对报表权利、署名及修改标识，保留作物年度与原始单位。 |
| 阿根廷农业部门：月度全国估产 | **具体报告许可待补。** [官方估产页](https://www.magyp.gob.ar/sitio/areas/estimaciones/estimaciones/informes/)。 | 核对实际报告附件的许可，不把其他 Argentina.gob.ar 页面的一般说明套用到该站。 |
| 腾讯 `qt.gtimg.cn`：A 股/港股/美股自选快照 | **未取得可供本项目引用的再分发授权依据。** 当前是公开端点读取，不是证券交易所授权数据合同。 | 核实自动读取、缓存、显示及分发客户端的允许范围；商业发行前使用明确授权的来源或取得许可。 |
| 新浪 `hq.sinajs.cn`：国内指定月份期货 | **同上，待核实。** 显示明确月份，不宣称自动确认主力合约。 | 核对新浪及交易所上游条件；保留来源、单位和时间。 |
| Yahoo Finance `query1.finance.yahoo.com`、东方财富 `futsseapi.eastmoney.com`：海外期货参考 | **未确认该端点的使用授权。** Yahoo 条款入口本轮返回 999，接口能响应不构成授权。 | 分别核对自动化访问、行情展示与上游交易所限制；不能套用其他 Yahoo API 的许可。 |
| 中新网财经 RSS | **RSS 再利用范围待核实。** [当前 feed](https://www.chinanews.com.cn/rss/finance.xml)，页面显示标题/来源/时间及链接。 | 明确允许展示/缓存的字段和摘要范围；不批量转载正文或图片，不把 RSS 可读取当作全文转载许可。 |
| GitHub 每日榜单、用户自定义 HTTP 接口 | **按内容和服务分别处理。** 榜单链接不授予目标仓库代码许可；用户填写 URL 不代表数据已获授权。 | 核对 [GitHub 可接受使用规则](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)及目标内容许可；自定义接口由配置者核对来源和个人信息范围。 |

## 素材与代码来源

| 素材/代码 | 已有依据 | 剩余事项 |
| --- | --- | --- |
| `src/assets/hud/` 的 LobeIcons / Agent HUD 图标 | 本地 [图标记录](../src/assets/hud/README.md)、[MIT 声明](../src/assets/hud/LobeIcons-LICENSE.txt)与 [HUD 上游声明](licenses/agent-hud-THIRD-PARTY-NOTICES.txt)保留；[LobeIcons 当前许可](https://github.com/lobehub/lobe-icons/blob/master/LICENSE)本轮核对为 MIT。 | 图标库 MIT 不授予第三方商标所有权或背书。历史 PNG 的逐文件来源链需要进一步记录，不能只依据库级声明断言全部图像权利已清。 |
| `src/assets/dock/` 应用标志 | 当前用于识别被启动的第三方应用。 | PNG/SVG 的逐文件原始来源和权利声明未完整建立；列为待核实，不因同名 HUD 图标存在 MIT 就自动覆盖。 |
| `src/assets/avatars-3d/` 三张 3D 图集 | 开发会话中生成/设计；发布者明确授权个人头像作为软件默认品牌 logo 和公开截图使用，允许用户本地替换。 | 项目内展示授权已确认；不能因此保证参考角色、生成素材享有排他版权或已取得任何第三方角色授权。单独再授权、参考图来源链仍需整理。 |
| `src/assets/room/` 旧 PNG、`hud/daily-avatar.png`、`hud/workbench-penguin-source.png` | 当前角色显示使用 3D 图集；旧图仍在源码仓库。 | 本轮未发现运行时直接导入这些旧图，但公开源码本身仍会分发它们；原始来源与许可待补。不擅自删除用户原素材。 |
| 仓库截图 | 已有隐私说明要求使用独立预览与演示数据，默认品牌头像经发布者授权。 | 更新截图前检查账户、服务器、文件路径和对话；本轮没有重新核对每张已有截图的全部像素，不将流程说明当作像素审计通过。 |
| vendored wry、HUD 参考实现、可选 VPS 服务适配参考 | [致谢](../ACKNOWLEDGMENTS.md)、`vendor/wry` 许可证、`docs/licenses` 和 `licenses/vps-services` 记录继续保留。 | 不修改上游版权声明；增加/升级依赖或复制代码时再核对对应版本。 |

## 本轮已落地与下一次发布前事项

- 已补天气许可链接、汇总说明及底图条款链接；设置中区分“公开来源”和可自由再分发的数据。
- 已补隐私说明与默认关闭的本机 AI 账号/用量许可；不清除旧记录和用户凭据。
- 优先解决：腾讯/新浪/Yahoo/东方财富及中新网的端点/内容授权，FRED 的实际用途限制，Pink Sheet 特定数据许可，Dock 和历史图片的逐文件来源。
- 可选择取得明确许可、改用许可清楚的来源、或经维护者同意后不随公开发行版提供相关内容。本轮没有替维护者作这些产品取舍，没有发邮件申请授权、没有上传或发布。

“待核实”不是侵权判定，也不是已经获准的证明。只有取得能对应到具体端点、文件或用途的依据，才更新为已确认；功能测试通过不能替代授权核实。
