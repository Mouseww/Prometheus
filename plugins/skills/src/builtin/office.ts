/**
 * Office and productivity skills: decks, documents, spreadsheets, diagrams, reports and meetings.
 *
 * House style shared by all of them: produce a real file the user can open and edit (not a screenshot of one), put it
 * next to the conversation, and tell the user the path so the app offers a preview and a download. python-docx /
 * python-pptx / openpyxl are the tool of choice because they write genuine Office files; HTML or Markdown is only an
 * intermediate that some converters like Marp accept.
 */

const HOUSE = `## 通用约定（凡是产出文件都照做）

1. **产物是真的文件**：用能写原生格式的库生成 \`.pptx\` / \`.docx\` / \`.xlsx\` / \`.pdf\`，不要交付截图、Markdown 改名或 HTML 冒充。
2. **落在对话所在的目录**：文件名写清楚，例如 \`2026Q1-销售复盘.pptx\`。最终回复里用反引号单独写一遍完整路径，界面会给出预览和下载。
3. **先确认三件事**（没给就按最合理的默认走，并在开头一句说明假设）：给谁看、要多长/多少页、什么时候要。
4. **旧文件先读再改**：用户给了现成的模板或旧版文件，先解析它的结构（样式、母版、表头、公式），在原结构上增删，不要另起炉灶。
5. **能看的不靠猜**：拿到的 \`.docx\`/\`.pptx\`/\`.xlsx\` 先用脚本把文字、表格、样式抽出来看清楚再动手。
6. **字体与中英文**：中文用「思源黑体 / 苹方 / 微软雅黑」，西文用 Inter 或系统无衬线；标题与正文同一套，不要混搭。
7. **不要塞满**：PPT 每页一个观点，Word 每节一件事，Excel 一行一条记录。留白是设计的一部分。
`;

const ENV = `## 环境（Prometheus 桌面版）

- 系统里可能没有 Python。缺库时先试 \`python -m pip install python-docx python-pptx openpyxl\`（macOS/Linux 用 \`python3\`）。
- 装不上就先装运行时：告诉用户「设置 → 运行时 → Python」，装好后重新执行命令。缺命令时界面也会自动提示安装。
- 需要转换（\`.docx\` → PDF、\`.pptx\` → 图片预览）时用 LibreOffice：\`soffice --headless --convert-to pdf 文件\`；没装就说明，不要用截图顶替。
- 表格的数据量小（几万行以内）时用 openpyxl 就够；不要为了一个图表去装重型数据栈。
`;

const DECK = `# 做演示文稿（PPT）

目标：交付一份能直接投屏讲的 \`.pptx\`，有统一的版式、清楚的信息层级和一句一页的结论。

## 开始前（30 秒内定下来）

- 场合：汇报 / 提案 / 培训 / 路演。场合决定页数和密度：汇报 10–15 页，提案 15–25 页，培训不限但要分节。
- 叙事骨架：结论先行。默认用「结论 → 三条论据 → 行动项」，除非用户给了指定大纲。
- 视觉基调：拿用户公司的模板或 logo 就用它取色；没有就用中性深色标题 + 一个强调色，别用渐变大字和满屏图标。

## 逐页结构

| 页 | 内容 | 约束 |
| --- | --- | --- |
| 封面 | 标题 + 一句话副标题 + 日期/汇报人 | 标题不超过 20 字 |
| 结论页 | 一页讲完全部结论，3 条以内 | 每条一句，不超过 40 字 |
| 论据页 | 一页一个论点：标题就是结论句，下面图/表/要点 | 要点 ≤ 5 条，每条 ≤ 25 字 |
| 数据页 | 一个图，一句解读，标注来源与口径 | 不要 3D、不要双 Y 轴、不要饼图超过 5 块 |
| 风险/备选 | 不确定性、需要谁拍板 | 如实写，不粉饰 |
| 收尾 | 行动项：谁、做什么、什么时候 | 最多 4 条 |

## 生成方式

\`\`\`python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()                     # 需要用户模板时：Presentation("模板.pptx")
blank = prs.slide_layouts[6]             # 空白版式，自己摆位置最可控
s = prs.slides.add_slide(blank)
box = s.shapes.add_textbox(Inches(0.6), Inches(0.5), Inches(12), Inches(1.0))
p = box.text_frame.paragraphs[0]
p.text = "结论：华东区提前一个季度完成年度目标"
p.runs[0].font.size = Pt(28); p.runs[0].font.bold = True
prs.save("季度汇报.pptx")
\`\`\`

- 16:9：\`prs.slide_width = Inches(13.333); prs.slide_height = Inches(7.5)\`（默认是 4:3）。
- 图表：先在 Excel/openpyxl 或 matplotlib 出图存 PNG，再 \`add_picture\`；要能编辑的图表才用 \`add_chart\`。
- 母版/占位符：有用户模板时用 \`slide.shapes.title\` 与 \`placeholders[1]\` 填内容，保住模板的样式。
- 演讲备注：\`s.notes_slide.notes_text_frame.text = "讲这里停 10 秒"\`，讲稿写备注不放页面。

## 交付前自检

- 每页标题单独读一遍，连起来能讲完整个故事。
- 无占位残余文字（"Click to add text"）、无错字、无超出边界的文本框。
- 字体、字号、颜色不超过 3 种；对齐一致。
- 图片不拉伸变形（按原比例缩放）。
`;

const DOC = `# 写文档 / 报告（Word）

目标：交付 \`.docx\`，带真正的标题层级、目录、页眉页脚和页码，用户打开就能改。

## 结构模板

- 报告类：摘要（3–5 句给出结论）→ 背景与目标 → 现状/数据 → 分析 → 建议与行动项 → 附：口径与来源。
- 方案类：要解决的问题 → 目标与验收标准 → 方案与取舍（为什么不是别的方案）→ 风险与依赖 → 里程碑与资源。
- 说明书类：用途 → 前置条件 → 步骤（一步一屏/一命令）→ 常见问题 → 回滚方式。

## 写作规则

- 结论先行，一段一个意思，段首句就是那段的主张。
- 用动词开头的短句；删掉"非常/十分/进一步/有效提升"这类无信息词。
- 数字必须带口径（时间范围、样本、单位）；没有数据就写"待补"，不要编。
- 中英文之间留空格，专有名词首次出现给全称与缩写。

## 生成方式

\`\`\`python
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
doc.styles["Normal"].font.name = "微软雅黑"
doc.styles["Normal"].font.size = Pt(11)
doc.add_heading("华东区季度复盘", level=1)
doc.add_paragraph("结论：提前一个季度完成年度目标，但续约率下降了 4 个百分点。")
for i, (title, body) in enumerate([("一、业绩", "……"), ("二、问题", "……")], start=1):
    doc.add_heading(title, level=2)
    doc.add_paragraph(body)
doc.save("季报.docx")
\`\`\`

- 目录：\`doc.add_paragraph()._p\` 手工加 TOC 域较繁琐；更稳的做法是写好标题层级后让用户在 Word 里点"引用 → 目录"，或直接 \`add_page_break()\` 留出目录页说明。
- 表格：\`table = doc.add_table(rows=1, cols=3, style="Table Grid")\`，表头加粗、首行重复、数字右对齐。
- 页脚页码：用 \`section.footer\` 加域代码；本机 Word 会更新域。做不到就用"第 X 页"占位并告知用户。
- 长文档插图：\`doc.add_picture("chart.png", width=Cm(15))\`，图注写在图下方并编号。

## 交付前自检

- 标题层级连续（不跳级），一级标题能撑起目录。
- 表格跨页不裂行；单位统一；百分比与绝对值不混用。
- 没有"未完成/TODO"字样残留；引用来源写在附录。

## 相关

- 同一份内容要投屏讲：转成幻灯片，见 \`office-pptx\`。
- 文档里的数据表：先在 \`office-xlsx\` 里算好，再把表与图贴进来。
`;

const SHEET = `# 做表格（Excel）

目标：交付 \`.xlsx\`，公式、格式、筛选、条件格式都是真的，别人改数据后结果会自动更新。

## 表设计

- 一张表只放一类记录：首行是表头（一列一个字段），每行一条记录，不留合并单元格、不留空行。
- 三个区放三个工作表：\`明细\`（原始数据）→ \`计算\`（透视/公式）→ \`汇总\`（给人看的结论页）。
- 列宽、冻结首行、自动筛选、数字格式（千分位、两位小数、日期 \`yyyy-mm-dd\`）都设好。

## 生成方式

\`\`\`python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from openpyxl.formatting.rule import ColorScaleRule

wb = Workbook(); ws = wb.active; ws.title = "明细"
head = ["日期", "区域", "客户", "金额", "状态"]
ws.append(head)
for c in range(1, len(head) + 1):
    cell = ws.cell(row=1, column=c)
    cell.font = Font(bold=True); cell.fill = PatternFill("solid", fgColor="EEEEEE")
ws.append(["2026-01-05", "华东", "示例客户", 128000, "已回款"])
ws["D2"].number_format = "#,##0"
ws.freeze_panes = "A2"
ws.auto_filter.ref = "A1:E2"
ws.column_dimensions["A"].width = 12
ws.conditional_formatting.add("D2:D100", ColorScaleRule(start_type="min", start_color="FFFFFF", end_type="max", end_color="63BE7B"))
wb.save("销售明细.xlsx")
\`\`\`

- 公式要写成 Excel 认的英文函数：\`=SUM(D2:D100)\`、\`=SUMIF(B:B,"华东",D:D)\`、\`=XLOOKUP(A2,客户!A:A,客户!B:B)\`。
- 透视表 openpyxl 不能生成；需要透视就先落明细 + 写公式汇总，或读出现成文件里的透视再改。
- 数据清洗（去重、拆列、透视、按格式合并多个表）：用 pandas，\`pd.read_excel\` 后用 \`pd.pivot_table\`，再写回 Excel。
- 用户发来的表先看清结构：\`openpyxl.load_workbook(path, data_only=True)\` 读值，\`data_only=False\` 读公式——判断是不是公式算出来的。

## 交付前自检

- 公式没有 \`#REF!\`/\`#NAME?\`；引用范围覆盖全部数据。
- 汇总页的每个数字都能追到明细某一列。
- 表头没被筛选挡住、没被冻结错位；数字列不是文本格式。
`;

const CHART = `# 做图表与示意图

两类活：**数据图**（读数用，必须准确）和**示意图**（讲结构/流程用，必须清楚）。先分清楚是哪一类。

## 数据图

- 选型只看一条：想让人比什么。比大小→条形图（横向，按值排序）；比趋势→折线图；比构成→堆叠条形或饼图（≤5 块）；比分布→直方图/箱线；比关系→散点。
- 起点 0：条形图的长度轴必须从 0 开始，截断轴会骗人；折线图可以不从 0，但要标出来。
- 一个图一个信息：标题直接写结论（"华东区是唯一正增长的区"），不要在图上再画 5 条线抢注意力。
- 配色：一个强调色 + 中性灰；超过 5 类数据时先合并小项。
- 交付：给 PNG/SVG 原图（300 dpi 以上）或直接放进 PPT/Excel 的可编辑图表；用 matplotlib/seaborn 生成，中文字体显式指定。

\`\`\`python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC"]
plt.rcParams["axes.unicode_minus"] = False
ax = (df.sort_values("amount")).plot.barh(x="region", y="amount", legend=False, color=["#8892a0"] * (len(df) - 1) + ["#e8663d"])
ax.set_title("华东区是唯一正增长的区", loc="left"); ax.set_xlabel("签约额（万元）")
plt.tight_layout(); plt.savefig("chart.png", dpi=200)
\`\`\`

## 示意图（流程图、架构图、时间线）

- 三选一：Mermaid（轻、可版本管理、渲染到 Markdown/HTML）、draw.io 的 \`.drawio\` XML（用户能改）、SVG（完全可控）。
- 图元控制在 5 种以内：框、箭头、分组、注释、强调色。框里只写名词短语。
- 流程从左到右或从上到下，单向为主；回环用虚线并标条件。
- 时序类用 Mermaid \`sequenceDiagram\`，状态机用 \`stateDiagram-v2\`，架构分层用 \`flowchart TB\` + \`subgraph\`。

\`\`\`mermaid
flowchart LR
  A[用户提问] --> B{知识库命中?}
  B -- 是 --> C[引用文档作答]
  B -- 否 --> D[转人工]
\`\`\`

## 交付前自检

- 图的标题能单独读懂（不看正文也知道说什么）。
- 轴有单位、有来源；图例没有重复项。
- 中文字体没变方框；导出 SVG 时文字仍是文字（可选中）。
`;

const REPORT = `# 工作汇报

输出类型：日/周报（过程同步）、月度或季度复盘（结果与原因）、对上汇报（要资源或要决策）、项目结项。先判断是哪一种，因为结构不同。

## 骨架

1. **一句话结论**：本期完成到什么程度，最需要对方知道的一件事。
2. **结果**：目标 vs 实际，差多少，为什么（只给 3 条以内主因，按贡献度排序）。
3. **过程要点**：做了什么关键动作、发现什么、改了什么做法。不列流水账。
4. **风险与不确定性**：可能翻车的地方、影响面、什么时候会知道结果。如实写，不粉饰。
5. **下一步**：下周/下阶段 3 件事，每件带负责人和完成标准。
6. **需要支持**：明确要谁做什么，不要写"希望领导支持"这种空话。

## 写法

- 数字先行："续约率 82%，比上期降 4pt"，不要写"续约率有所下降"。
- 区分事实与判断：事实直接陈述，判断标"我的判断是"。
- 一屏读完：周报 300–600 字，月报 800–1500 字，超出就砍细节留附件。
- 对上汇报控制在一页结论 + 附页依据；对方只看第一页也能做决策。

## 交付形式

- 习惯用 Markdown 就交 \`.md\`；需要发出去就给 \`.docx\`（见 \`office-docx\`）或 \`.pptx\`（见 \`office-pptx\`）。
- 数字从用户的数据里来：先读附件表格，算好再写，不要估。
- 附上口径：统计周期、数据来源、是否有剔除项。

## 自检

- 每条结论后面能不能接一句"所以呢"？接不上就删。
- 有没有把"做了什么"错当成"做出了什么"？结果层必须有着落。
- 风险段是否真的写了风险，而不是把好消息换个说法。
`;

const MEETING = `# 会议纪要

目标：会后 10 分钟内给出一份**能直接执行**的纪要，而不是逐句记录。

## 输入

- 用户贴的聊天记录、录音转写（\`audio-transcribe\` 技能可以把音频转成文字）、手写要点、或会议中的实时记录。
- 先分清楚谁说的：按发言人分段，人名统一（同一人不同称呼要合并）。

## 结构

1. **会议信息**：主题、时间、参会人、主持/记录。
2. **结论**：这次会定下来的事，每条一句，可执行。
3. **议题与讨论**：一事一段。每段写「背景一句 → 分歧点（如有）→ 结论或待定」。
4. **待办**：表格形式，必须有负责人 + 截止时间 + 验收标准。没有负责人的待办不算待办。
5. **待定与下次会**：悬而未决的问题、需要谁拍板、下次什么时候。

## 规则

- 不做会议转录：删掉寒暄、重复、跑题，保留决策与依据。
- 有分歧就记分歧，不要写成"大家一致同意"；记下反对意见和它的理由。
- 数字、日期、人名、金额原样保留，不四舍五入、不推测。
- 说得含糊的地方写"（待确认）"，不要替对方补全。
- 输出 Markdown 交 \`.md\`，需要发邮件就直接是邮件正文；需要存档就给 \`.docx\`。

## 模板

\`\`\`markdown
## 会议：周三产品对齐
- 时间：2026-03-04 10:00–10:40 ｜ 参会：张三、李四、王五

### 结论
1. 三月只做知识库检索，不做多模态。

### 讨论
**多模态优先级**：李四提出客户已催两次；王五判断四月再上不影响验收。结论：押后到四月，四月第一周出排期。

### 待办
| 事项 | 负责人 | 截止 | 完成标准 |
| --- | --- | --- | --- |
| 出四月多模态排期 | 王五 | 04-07 | 含人力与联调时间 |
| 回复客户交付时间 | 李四 | 03-06 | 邮件确认 |

### 待定
- 预算是否追加：等财务 3 月 10 日的口径。
\`\`\`
`;

const MAIL = `# 写邮件 / 公文

一封好邮件：对方 15 秒内知道要干什么。

## 结构

- **主题**：动作 + 对象 + 期限。「请确认：3 月合同用印（3 月 6 日前）」，不要写"关于…的事宜"。
- **第一句**：目的。要对方做什么、什么时候、为什么现在。
- **正文**：3–5 段或要点列表，一段一件事。背景放在目的之后，不要把人挡在背景里。
- **附件**：正文里点名"见附件 A（报价单 v3）"，附件本身起清楚的文件名。
- **落款**：称呼、署名、职务、联系方式。

## 语气

- 对上：结论 + 依据 + 请求，短、具体、给对方台阶（"如无异议我按此执行"）。
- 平级：直接说事，给选择（"A 或 B，我倾向 A，因为…"）。
- 对外：礼貌但不啰嗦，不承诺没有把握的时间。
- 催办：一次把事实、影响、需要对方做的动作说清，不带情绪、不追责。

## 常用骨架

- 请求决策：要决策的事 → 两个选项与代价 → 我的建议 → 需要的回复时间。
- 汇报进展：结论 → 已完成 → 卡点 → 下一步 → 需要的支持。
- 致歉与补救：发生了什么 → 对对方的影响 → 已做的补救 → 如何避免再发生 → 时间点。

## 交付

- 中文给正文纯文本（可直接粘贴到 Outlook/企业微信）；西文邮件保持简洁短句。
- 需要正式公文格式（红头、编号、抄送）时交 \`.docx\`（见 \`office-docx\`）。
- 群发前检查：收件人/抄送有没有错、附件有没有漏、时间地点人名对不对。发信是不可撤销的动作，只起草，不代发。
`;

export const OFFICE_SKILLS = [
	{
		name: "office-pptx",
		title: "做 PPT",
		tagline: "汇报、提案、培训的演示文稿",
		category: "office",
		examples: ["帮我做一份季度经营复盘 PPT，15 页左右，给老板看", "把这份 Word 方案改成 10 页提案 PPT"],
		description:
			"Make a PowerPoint deck (.pptx) that can be presented as is: conclusions first, one point per slide, consistent layout. Use when the user asks for 幻灯片 / PPT / 演示文稿 / 路演材料 / 提案 deck / slides / presentation.",
		body: DECK + "\n" + HOUSE + "\n" + ENV,
	},
	{
		name: "office-docx",
		title: "写文档",
		tagline: "报告、方案、合同附件的正式文档",
		category: "office",
		examples: ["写一份项目立项报告 Word，包含验收标准和风险", "把我们的会议记录整理成正式方案文档"],
		description:
			"Write a Word document (.docx) with real heading levels, tables and page setup: reports, proposals, specs, manuals. Use when the user asks for 文档 / Word / 报告 / 方案 / 说明书 / 合同附件 / docx / report.",
		body: DOC + "\n" + HOUSE + "\n" + ENV,
	},
	{
		name: "office-xlsx",
		title: "做表格",
		tagline: "Excel 台账、核算、数据清洗",
		category: "office",
		examples: ["把这两个月的销售流水整理成 Excel，按月汇总并标注同比", "做一个带公式的项目预算表，改数自动重算"],
		description:
			"Build or fix an Excel workbook (.xlsx) with real formulas, formats, filters and conditional formatting; clean and reshape messy data. Use when the user asks for 表格 / Excel / xlsx / 台账 / 对账 / 汇总 / 数据清洗 / 预算表 / spreadsheet.",
		body: SHEET + "\n" + HOUSE + "\n" + ENV,
	},
	{
		name: "diagram-chart",
		title: "画图",
		tagline: "数据图表、流程图、架构图",
		category: "office",
		examples: ["把这组数据画成图，放进 PPT", "画一张系统架构示意图，三层结构"],
		description:
			"Produce charts that read correctly (bar/line/scatter choice, zero baseline, labels) and diagrams that explain structure (Mermaid, draw.io, SVG flowcharts, architecture and timelines). Use when the user asks for 图表 / 画图 / 示意图 / 流程图 / 架构图 / 时间线 / chart / diagram / flowchart.",
		body: CHART + "\n" + HOUSE + "\n" + ENV,
	},
	{
		name: "work-report",
		title: "工作汇报",
		tagline: "周报、月报、复盘、对上汇报",
		category: "office",
		examples: ["根据这些数据写本周周报", "写一份季度复盘，重点讲问题和下一步"],
		description:
			"Turn raw notes and numbers into a report someone can decide on: conclusion first, results vs targets, honest risks, next steps with owners. Use when the user asks for 周报 / 日报 / 月报 / 复盘 / 汇报 / 述职 / 结项 / status update / weekly report.",
		body: REPORT + "\n" + HOUSE,
	},
	{
		name: "meeting-minutes",
		title: "会议纪要",
		tagline: "把录音或聊天记录变成待办",
		category: "office",
		examples: ["把这段会议记录整理成纪要和待办", "这段录音转成文字后帮我提取结论"],
		description:
			"Turn a transcript, chat log or notes into minutes with decisions and an owner-and-deadline action list, keeping disagreements visible. Use when the user asks for 会议纪要 / 纪要 / 会后总结 / 待办提取 / meeting notes / minutes.",
		body: MEETING + "\n" + HOUSE,
	},
	{
		name: "email-writing",
		title: "写邮件",
		tagline: "对外沟通、催办、请示、通知",
		category: "office",
		examples: ["写封邮件催客户确认合同用印", "给老板写邮件申请追加预算，两个方案"],
		description:
			"Draft emails and formal notices that are easy to act on: action-first subject, one purpose per message, the right tone for the audience. Use when the user asks for 邮件 / 写信 / 公文 / 通知 / 请示 / 催办 / email draft.",
		body: MAIL + "\n" + HOUSE,
	},
];
