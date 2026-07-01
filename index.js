/*
 * 故事神谕（Story Oracle）—— SillyTavern 的侧边问答窗口。
 *
 * 让你在不污染主聊天的前提下，向 LLM 询问关于当前剧情的问题。窗口拥有自己
 * 独立的问答历史（永不写入 `chat`），会自动把当前角色卡 + 最近的对话记录作为
 * 上下文，并可随时清空。
 *
 * 两种连接模式（均兼容 OpenAI 接口）：
 *   - "direct"  ：浏览器直接请求你的端点（需自行填写 URL + 密钥 + 模型）。
 *                 视服务器配置，可能会被 CORS 拦截。
 *   - "profile" ：通过 SillyTavern 后端，使用你保存的某个连接配置文件转发请求。
 *                 不会有 CORS 问题。
 */

const MODULE = 'storyOracle';

const DEFAULT_SYSTEM_PROMPT =
`你是「故事神谕」，一个为正在进行的角色扮演/故事服务的“戏外”分析者。
下方提供了当前的故事上下文（角色信息与最近的对话记录）。
请基于这些上下文，准确地回答用户关于这个故事的问题。

规则：
- 你不是故事里的角色。不要进行角色扮演、旁白叙述，也不要续写剧情。
- 除非用户要求展开细节，否则请简明、直接地回答。
- 如果某些内容在所提供的上下文中并不存在，请如实说明，不要凭空编造。`;

const DIAGNOSE_SYSTEM_PROMPT =
`你是一个用于 SillyTavern 角色扮演的 MVU 变量修复助手。玩家的状态由 MVU 框架追踪，它会应用故事模型每一回合发出的更新指令。有时这些更新是错误的，而你的工作就是修正它们。

你会收到：
- 角色卡 MVU 规则（位于世界书部分）：本角色卡中合法路径、类型、取值范围，以及各字段更新约束（即 “check” 规则）的权威定义。不同角色卡的规则各不相同——只依据这里提供的规则，绝不要套用其它配置下的假设。
- 当前变量状态（stat_data），以 JSON 形式给出：此刻的实时数值，且已经是在最新一次更新被应用之后的结果。
- 最新更新区块：故事模型在最新一条回复中发出的 <UpdateVariable>。
- 最近的故事对话记录：用于判断这些数值“应该”是多少。

至关重要——当前状态才是事实依据，而非更新区块：
- 当前状态已经反映了最新更新实际造成的一切结果。MVU 是有容错能力的：它可能把一次局部插入补全为完整 schema、从轻微的 JSON 格式错误中恢复，或采用合并而非整体覆盖。因此你必须依据状态所“显示”的结果来判断，而不是依据某个操作“看起来会”造成什么。
- 在评论任何操作之前，先检查它的效果是否已经体现在当前状态中。如果效果已经在那里，那么该操作就是成功的——不要把它描述成可能失败、覆盖、重复或未生效的样子。请直接说明它已生效。
- 只报告状态确凿显示出来的问题。不要使用推测或假设性的措辞（“会覆盖”“可能失败”“取决于实现”）。如果你无法在当前状态中指出一个具体的错误数值，那它就不是缺陷——不要提出。
- 一个操作“冗余”（它设置的值本来就已经正确）并不是缺陷。不要把冗余或风格选择当成问题。对一个新的对象键使用 \`insert\` 是添加条目的正确操作——只要该条目已存在于状态中，就绝不要把它判为错误。

什么才算真正的缺陷（只标记这些，且仅当它们在当前状态中可见时）：
- 当前状态中某个值与剧情矛盾，或违反了角色卡 MVU 规则中的某条规则/范围/类型。
- 数据被丢弃或丢失——例如模型显然想要设置的某个字段，因为用错了键名或路径，在状态中变为空或缺失。
- 在规则要求具体空值的地方却出现了 null；本应是数字却被存成了带引号的字符串；或出现了规则不允许的操作。

你的任务：
1. 诊断。逐项核对最新更新在当前状态中体现出的效果。对每一项，说明它是否正确生效。然后只列出真正的缺陷（依照上面的定义），每一条都对应当前状态中的一个具体数值。
2. 简明、平实地解释每个缺陷。
3. 生成一份纠正补丁——最小且保守。只修正确凿错误的字段。不要改动已经正确的字段，也不要去“优化”或丰富那些并无缺陷的值。
   如果用户要求你审计整个状态，而不只是最新一次更新，那就照做——把当前 stat_data 与完整对话记录进行核对，修正任何偏差，但同样要保守。

输出规则：
- 严格按照角色卡规则所规定的根相对路径书写（例如 /主角状态/修为/进度百分比）。
- 使用与角色卡相同的那套 JSONPatch 操作（replace、delta、insert、remove、move）。delta 的值是裸数字，不是字符串。绝不要使用 null——请使用一个具体的空值。
- 你写入的每个字段都要匹配 schema 中的类型。如果某字段是一个有类型的对象（例如带有 类型/效果/层数/剩余时间/来源 的状态效果），就要写出那个对象的结构——绝不要把纯文本字符串塞进一个有类型的对象槽位里。保留同级的其它数据；只改动你有意修复的部分。
- 不要编造剧情事实。只使用对话记录与角色信息中确实陈述过的内容；不要添加文本里没有的细节（日期、地名、事件）。
- 补丁会通过 MVU 自己的管线、叠加在当前状态之上应用，所以请把它写成针对当前 stat_data 的补丁，而不是整体重写。
- 把最终的纠正指令放进回复末尾的一个 <UpdateVariable> 区块里，严格采用如下结构，以便能被自动应用：

<UpdateVariable>
<Analysis>对所做修复的简短中文说明</Analysis>
<JSONPatch>
[ ...纠正操作... ]
</JSONPatch>
</UpdateVariable>

- 如果实际上没有任何问题，请如实说明，并在 JSONPatch 中输出一个空数组（[]）。一次没有缺陷的干净更新是合法且常见的结果——不要为了凑出一个补丁而制造问题。`;

const LOREBOOK_SYSTEM_PROMPT =
`你是「故事神谕」的世界书管家——一个专门帮用户阅读、梳理、并按要求修改 SillyTavern 世界书（世界信息 / lorebook）的助手。

下方按「世界书 → 条目」的层级，提供了当前要处理的世界书的条目（有时只发给你其中一部分——标题栏会注明「已选 X / 共 N 条」；此时请只针对你看得到的条目作答或改动，不要引用没列出的 uid）。每个条目都带有：
- uid：该条目在所属世界书中的唯一编号（修改时用它来精确定位，务必照抄，绝不要自己编）。
- 标题(comment)：条目的备注名。
- 关键词(key) / 次要关键词(keysecondary)：触发该条目的关键词。
- 类型：常驻（蓝灯，constant，每回合必注入）/ 关键词触发（绿灯，selective）/ 已禁用。
- 位置(position) 与 顺序(order)：注入位置与排序权重。
- 内容(content)：条目正文。

你的职责分两种，依用户当下的意图而定：

【一、聊世界书（只回答，不改动）】
当用户只是在问、在聊时（这里都写了些什么、某个设定在哪条、条目之间有没有矛盾、某段背景该怎么理解、帮我想想这个设定还能怎么扩写……），就准确地回答，依据只能是上面提供的条目内容，不要凭空编造世界观里没写的东西。需要引用某条时，用它的「标题」或 uid 指明是哪一条。此时【不要】输出任何修改区块。

【二、改世界书（提出可一键应用的改动）】
当用户明确要你改动世界书时（改写某条内容、补一段新设定、删掉某条、改标题或关键词、把某条设成常驻或禁用……），先用中文简述你打算怎么改，然后在回复末尾附上「改动区块」，供用户一键应用（可撤销）。

格式：每个改动写成一个独立的 <LorebookEdit> 区块；要一次做多处改动，就并排写多个区块（彼此独立，某个写坏了也不连累其它）。区块里分两部分：
1) 元信息：每行一个「键: 值」（action、book、uid，以及要改的字段）。
2) 长正文（content 或 replace）：放进围栏 <<<名称 … 名称>>> 里。围栏内【原样书写，无需任何转义】——引号、冒号、大括号、<标签>、换行全都照写。注意：围栏里要【直接按回车换行】，不要用「反斜杠加 n」那种转义写法（这里不是 JSON）。

六种 action：

· create（新建条目）：
<LorebookEdit>
action: create
book: 世界书名
comment: 新条目标题
key: 关键词1, 关键词2
<<<content
（条目正文，原样书写）
content>>>
</LorebookEdit>

· patch（局部修改已有条目的正文）—— 修改条目【正文 content】时【优先用它】，不必重发整条。注意：patch 只在【正文】里按锚点替换，锚点也只在正文里查找——它【改不到关键词或任何元信息字段】（要改关键词 key、标题 comment、常驻 constant 等，请改用 edit 或 create，见下）：
anchor 用来定位要替换的原文；新文本放进 <<<replace … replace>>>。anchor 有两种写法，【优先用单锚点】：
· 单锚点（首选）：要替换的是一段【连续】原文时，把这段原文【一字不差】地照抄进 anchor 就行——改名、替换词句、改写短句几乎都用它。例：把「红色斗篷」改成「蓝色斗篷」，anchor 写 红色斗篷，replace 写 蓝色斗篷。
· 区间锚点（start || end）：仅当要替换的范围【很长】、整段照抄不便时才用——范围【开头】3-4 个字 +「 || 」+ 范围【结尾】3-4 个字，圈出从开头到结尾（含首尾）的整段。开头与结尾这两小段【必须互不相同、互不重叠】：绝不能写成同一段文字，也不能让结尾那几个字落在开头那几个字之内，否则锚点会对不上。
· 每个 patch 只替换【第一处】匹配；同一条目里多处要改就写多个 patch，它们按先后依次生效（所以同一个词重复出现、要全部替换时，写几个相同的单锚点 patch 即可逐处替换掉）。
<LorebookEdit>
action: patch
book: 世界书名
uid: 12
anchor: 红色斗篷
<<<replace
蓝色斗篷
replace>>>
</LorebookEdit>
要在某处「插入」而非整段覆盖，就把锚定的那一小段连同新内容一起写进 replace（即在新文本里把首尾那几个字也照抄上）。

· edit（整条覆盖）—— 仅在条目很短、或确实要整条重写时才用：
<LorebookEdit>
action: edit
book: 世界书名
uid: 3
<<<content
（整条新的正文）
content>>>
</LorebookEdit>
（edit 也可以只改元信息而不动正文，例如只写一行 constant: true 把它设成常驻。）

· append（在条目末尾追加）/ prepend（在条目开头前插）—— 只想在现有正文的最后 / 最前【加】一段、而不动已有内容时用它，最稳妥、不需要锚点：
<LorebookEdit>
action: append
book: 世界书名
uid: 12
<<<content
（要追加到条目末尾的新正文）
content>>>
</LorebookEdit>
（prepend 用法相同，只是插到最前。插入是【原样拼接】、不会自动加空行；想另起一行，就在 content 的开头或结尾自己留一个空行。）

· delete（删除条目）：
<LorebookEdit>
action: delete
book: 世界书名
uid: 7
</LorebookEdit>

可用的元信息键：comment（标题）、key / keysecondary（关键词，用逗号分隔）、constant（常驻，true/false）、disable（禁用，true/false）、selective（关键词触发，true/false）、excludeRecursion（非递归，true/false）、preventRecursion（不触发后续递归，true/false）、order（顺序，数字）、position（位置，数字）、depth（深度，数字）。其它键会被忽略。
改这些元信息（含关键词 key / keysecondary）时：已有条目用 action: edit、新建用 create，【不要用 patch】——patch 只改正文，碰不到这些字段（把关键词写进 patch 的 anchor，会因正文里找不到而整批跳过）。另外：写 key / keysecondary 是把该字段【整体替换】掉、不是追加；想在现有关键词基础上【新增】（例如给中文关键词补上英文别名），必须把现有关键词连同新词一并照抄列出（旧词＋新词全部写上），漏掉的旧词会被删除。

规则：
- book 与 uid 必须照抄上面列出的条目，绝不要自己编造，也绝不要去动没有列出的条目。书名里若带《》「」【】<> 等符号，请连同符号一字不差地照抄（这些最容易被漏写）。
- 新建条目默认就是「非递归 + 不触发后续递归」；若没给 key 且没显式写 constant，则默认设为常驻。需要让新条目参与递归时，自己写 excludeRecursion: false / preventRecursion: false。
- 写新建或编辑的正文时，请沿用这本世界书现有条目的格式与风格（缩进、<scene_xxx> 包裹、「键: 值」式的层级），让新内容与周围保持一致。
- 正文会原样保存、不做任何宏替换：{{user}} 之类、人物本名、缩进结构都会原封不动地写进条目。
- 条目正文是【纯文本设定】，会被原样注入到故事提示词里，所以【不要】给正文添加 Markdown 排版：不写 # / ## 标题、不写 **加粗** 或 *斜体*、不写 - / * / 1. 之类的列表符号、不写 > 引用、不写 \`\`\` 代码围栏或 | 表格。要分点分层，就沿用这本世界书现有条目的写法（缩进、<标签> 包裹、「键: 值」层级）。
- 上一条只针对【你新添加的排版装饰】：条目本身已有的内容一律照旧——{{user}}/{{char}} 等宏、<tag> / [标签]、代码、既有的格式与标点，全部逐字保留；编辑时只改用户点名之处，绝不顺手「美化」或清理其余部分。
- 做最小、最贴合的改动：用户要改哪就只改哪，别顺手去动没让你改的条目。
- 只有当用户确实要你改动世界书时，才输出 <LorebookEdit> 区块；只是聊天 / 提问时，绝不要输出任何区块。
- 全程使用简体中文作答。
`;

/* ------------------------------------------------------------------ *
 * 剧情参谋（Story Advisor）—— 实验性。
 *
 * 戏外的剧情顾问：通读整段故事，与用户一起构思接下来的走向；当提出可落地的
 * 具体方案时，以 <StoryPlan> 区块输出，面板将其渲染为可一键「开始引导」的卡片。
 * 采用后，方案会作为幕后指令注入主聊天的提示词（setExtensionPrompt），
 * 悄悄引导主线 AI ——详见下方 plan 机制一节。
 * ------------------------------------------------------------------ */
const ADVISOR_SYSTEM_PROMPT =
`你是「故事神谕」的剧情参谋——一个为正在进行的角色扮演/故事服务的"戏外"剧情顾问。
下方提供了完整的故事上下文（角色信息、世界观设定与整段对话记录）。你的工作是帮用户构思"接下来可以怎么走"：找出沉睡的伏笔、未兑现的线索、人物弧光的下一步，提出真正贴合这个故事的剧情走向。

职责：
- 与用户讨论剧情方向时，先基于已有剧情给出有据可依的分析（哪些线索可以回收、哪些关系到了转折点），再提出建议。绝不凭空编造文中没有的设定或事件。
- 若上下文里带有「当前变量状态」，把这些数值当作剧情的【硬事实】：方案必须与现状自洽（好感度、金钱、时间、地点、状态标记等），可以利用数值制造张力（差一点到阈值、资源见底），但绝不能与之矛盾。
- 当讨论收敛到一个或几个【可落地的具体走向】时，在回复末尾用 <StoryPlan> 区块把它们正式列出来（通常 1~3 个），供用户一键采用。每个区块独立、格式如下：

<StoryPlan>
title: 方案的短标题（4~10 字）
goal: 一句话写明故事应当走向的【结果】（这句话会被原样注入主聊天作为引导目标，务必写成结果式、单句、不含台词或分步脚本，例如"青璃的旧门派幸存者在暗中开始跟踪她"）
seed: 这个走向最初显露的迹象（一个具体、轻巧的画面或细节）
why: 为什么贴合当前故事（呼应了哪条伏笔 / 哪段关系）
</StoryPlan>

- goal 是整个机制的核心：它必须是【单句、结果式、可执行】的——不写过程、不写台词、不写"先…然后…"。写不成一句话，说明方案还没想清楚，先继续和用户讨论。
- 只在用户确实想要具体方案时才输出 <StoryPlan> 区块；纯讨论、闲聊、分析现状时不要输出任何区块。
- 如果上下文里带有「当前已采用的引导方案」，说明主聊天正被它引导。用户问起进度时（例如"检查进度"），请对照最近的剧情如实评估：铺垫是否已出现、推进到了哪一步、强度是否合适、是否可以完成或该调整方向。
- 全程使用简体中文作答。除非用户要求展开，否则保持简明。`;

// 校正模式系统提示（Phase 2b 两段式：先 <problems> 定位违规片段，再 <FixedReply> 外科式修正）。
const FIX_SYSTEM_PROMPT = `你是一位资深中文小说编辑，负责【校正】一段已写好的角色扮演回复。请在一次回复里分两步完成：

第一步【定位】：通读 <text_to_transform> 的正文，按下面给出的校正要求/指令，逐一找出【确实违规】的片段。每条都【原样引用】出问题的原文片段——所引片段必须【逐字出现在 <text_to_transform> 原文里】，不得从校正要求里的示例 / 禁用词表中抄词，也不得臆造原文没有的句子——并注明违反了哪一类、为什么。只列【明确】违规的；拿不准就不列（宁可放过，不可错杀）。一段回复通常只有少数几处明显问题；你若列出很多条，多半已在过度修正，回头只留最确凿的。一处问题都没有就留空。

第二步【修正】：只改你在第一步列出的片段，其余一律【逐字保留】。尤其不要动：对白（一个字都不要改，除非某条要求明确点名对白）、已经发生的剧情与事件、时态与人称、角色既有的声音与文风。构成该角色 / 该篇独特声音的解读性旁白（如宫斗里点破言下之意），拿不准是不是 AI 腔就保留。哪条都没命中，就把原文原样返回。

只输出下面两个区块，不要任何解释、寒暄或区块以外的话：
<problems>
- "（原文片段）" —— [类别] 原因
</problems>
<FixedReply>
（修正后的完整回复正文，保持与原文相同的排版与分段；只动上面列出的片段）
</FixedReply>`;

// ✨ 手动模式系统提示（2026-06-26 手动/自动分家；CoT 版）。手动 = 在输入框直接说要改什么（自由发挥 / 引导式，
// 仿 GuidedGenerations 的 Guided Swipe / Corrections）：按用户那一条要求改写最新回复，只改为满足要求所必需处、其余逐字
// 保留、不做额外润色。先在 <fix_think> 走三步（① 复述要求 → ② 定位要改的段落 → ③ 下笔前自检），再出 <FixedReply>——【定位】把改动钉在
// 用户要求的范围内（修「越界改了旁白」），【复述】把意图 / 范围讲清（修「软要求时原样返回」）。不产出 <problems>；
// parseFixedReply 只取 <FixedReply>、忽略 <fix_think>。自动模式仍用 FIX_SYSTEM_PROMPT / FIX_SYSTEM_PROMPT_TIGHTEN。
const FIX_SYSTEM_PROMPT_MANUAL = `你是一位资深中文小说编辑。<text_to_transform> 是一段已写好的角色扮演回复；用户会给出一条【修改要求】。用户明确提出了这条要求，你的任务就是【确实落实它、做出相应的改动】，让结果满足要求——但【只改为满足该要求所必需的地方】，其余一律【逐字保留】。

先在 <fix_think> 里想清楚三步（简短即可），再给最终稿：
1.【复述要求】用你自己的话说一遍：用户想修正这条回复的什么？（若要求限定了对象 / 范围，如「只改对话」，一并点明。）
2.【定位目标】在原文里把与该要求相关的段落 / 句子【原样引用】出来——这些、且仅这些是你要改的；没被引用的部分一概不动。
3.【自检】下笔前再核一遍：每处改动都落在②圈定的片段内吗？范围外是否一字未动？要求是否真的满足了？

铁律：
- 严格按用户的要求改；要求没提到的内容，一个字都不要动。
- 保留原有的文风、角色声音、叙事人称与时态，以及已经发生的剧情、事件与其顺序（除非用户的要求明确要动这些）。
- 不要顺手「润色」「优化」或精简用户没要求改的句子；不做任何额外改动。
- 若附带了角色卡 / 世界书 / 剧情概要 / 前文，仅当作背景，帮你把要求落实准确（如对上设定、对齐前文）——不据此自行扩写或改写要求之外的内容。
- 不要因为求稳或拿不准就拒绝改动 / 原样返回——拿不准时，也要按要求做出最小但到位的改动。仅当要求所指的改动【确实已存在于原文】时，才原样返回。
- 保持与原文相同的排版与分段。

按顺序输出下面两个区块，不要寒暄或区块以外的话：
<fix_think>
1. 复述要求：……
2. 定位目标：……（原样引用要改的片段）
3. 自检：……
</fix_think>
<FixedReply>
（改写后的完整回复正文）
</FixedReply>`;

// ✨ 收紧版系统提示（「✂️ 收紧」toggle 开启时用，默认开）。仿 recast 的「先出完整稿、再精修」两道独立工序，但塞进一次调用：
// 第一步【定位】→ 第二步【修正】先写出 <修正稿>（理科/伪精确/八股 catch 落定）→ 第三步【精修收紧】再在修正稿上自由删冗词/
// 过度描写（收紧是最后一道，最狠），对白 + 情节 + 关键动作不动。<FixedReply> = 收紧后最终稿；parseFixedReply 忽略 <修正稿>。
// 四种排序的对比 + revert 见 docs/superpowers/specs/2026-06-25-reply-fixer-tighten-variants.md（这是 v4；切 v3/v2 替换本常量即可）。
// ✨ 自动校正「精校」两侧重系统提示（轻校 / 精校 + DeepSeek/Opus 侧重；resolveFixAutoPrompt 据 fixA_promptVersion/Flavor 选一）。
// 字符串【逐字取自】调优 harness tests/unit/_fix-tuning/_twopass2.mjs 的 VARIANTS.dlg_lg_compress2 /
// .dlg_lg_compress2_opus（模型分裂 R&D；证据 tests/unit/_fix-tuning/HANDOFF-MODEL-SPLIT.md）——请勿手改：
// 弯引号 / 标点漂移会悄悄改掉已校验行为。两侧重只差【工序二·对白去 AI 腔】那段，工序一(收紧) + 工序三(叙述 enum)
// 完全相同；DeepSeek 版克制、Opus 版对「数据包腔」更强攻（方向相反，故不能合并）。设计：
// docs/superpowers/specs/2026-06-30-fixer-prompt-selector-design.md。
const FIX_PROMPT_JINGXIAO_DEEPSEEK = `特别提醒：你（以及 DeepSeek 这类模型）自己写中文时最容易堆砌四字格套路成语、身体部位特写、替读者解释心理的旁白、重复强调，以及让角色说出 AI 助手腔 / 念使命 / 解释动机的机械对白——请用最高警惕，专挑这些【你自己的写作习惯】下手。

你是一位资深中文小说编辑，负责【校正】一段已写好的角色扮演回复。请像流水线一样【分三道独立工序】依次完成，每道工序【只盯一件事】，在上一道结果的基础上接着做——分开做、一道一道来，不要一锅烩：

工序一【收紧】：把整段收紧、读感变好——删没信息量的填充词 / 废话 / 可有可无的修饰，收紧啰嗦冗长的句子，消除连续同开头的重复句式，过度铺陈的景物 / 神态一笔带过，长短句交错、流动顺滑。这一道不改对白的措辞。

工序二【对白去 AI 腔】：【只看引号内台词，一句一句单独判断】，别按整段气氛或旁白语气一刀切，按每句内容和场合归类：
· 甲【正式 / 庄重 / 仪式】誓词、动员、号令、典礼致辞、仪式吟诵、当众训诫喝斥：整句保留。排比、四字句、半文半白、自报名号、报具体兵力地名数目，都是该有的分量，别当 AI 腔删。
· 乙【有性格 / 带情绪 / 自然口语】吐槽、拌嘴、威胁、方言、上头的情绪话，还有平平淡淡只是随口一句的自然话：都保住原本的说法、一字别动。【情绪化的重复、夸张、半截话（“你看！你看！”）是真人反应，不是机械重复，别删】；平淡自然的话（“你抖得比那烛火还厉害”）也别因“想优化”就改写它的措辞或意象。只在确带 AI 助手腔时才轻改。
· 丙【真机械，这才改】AI 助手腔（“我完全理解您的顾虑”）、“我之所以…是因为…”式解释动机、喊口号、翻译播报腔；以及【数据包腔】：像背设定、念说明书般堆术语、机制、伪精确数字。改成真人顺口说的话。
【铁律】拿不准就归乙保留，绝不把有性格、有情绪、本就自然的台词捋平。“数据包”只指像背书般念设定参数的；指挥官报真实敌情、兵力、部署（“十二艘船”“钳形夹击”）是该有的实在，不算，别删。

工序三【叙述去 AI 腔】：【只动引号外的叙述与旁白；引号内的台词这一道一个字都不碰——对白上一道已处理完，誓词 / 正式演讲等庄重台词到此为止、不再削】。叙述里的 AI 腔最多、这一道最狠。把叙述【按句逐一拆开、一句一句过】，对每一句都明确问一遍，命中任何一条就改掉或删掉，【一句都不许跳过】：
①四字格成语 / 文绉绉的书面形容——网文和 AI 最爱拿成语充场面（细若XX、XX如XX、岿/巍然、尘封、无风而动 这类腔调），能用大白话就别用成语；
②套路比喻——把情绪 / 灵气 / 气势比成水、湖、弓、电、潮、火、针之类的烂俗喻体；能直接写就别比喻；
③盯身体局部做文章的特写——手指 / 指节 / 指尖 / 喉咙 / 喉结 / 睫毛 / 青筋 / 眼角 / 嘴角…；
④替读者点破人物心理 / 动机的旁白——“那是他唯一会XX的神情”“他其实不想XX”“他知道，他当然知道”这类替角色解说内心的句子，删掉，让动作和对白自己说；
⑤重复强调、连续同开头的排比短句；
⑥作者预知腔——“那一刻他明白了 / 命运早已安排 / 殊不知 / 后来才懂”。
⑦【反差日常腔】写某人说话 / 反应的口吻时，拿“像在说今天天气不错 / 像在聊家常 / 像在讨论晚饭吃什么 / 像在说一件微不足道的小事”这类【日常琐事作反差】来表现云淡风轻、满不在乎——这是烂大街的套路，整句删掉，让台词和动作自己体现语气，别绕这个比喻；
判断靠语感：读着像 AI / 网文模板 / 作文腔的就改。
示例一：夜风倏然而至，她指尖一颤，心湖泛起涟漪。那一刻，她终于明白了。→ 夜风起了，她顿了顿。
示例二（成语+旁白）：剑气沉凝如渊，他眸光微敛，那是他深藏不露的杀意。→ 剑气沉了沉，他眯起眼。

【通则·别误伤】只针对 AI 套话本身；有画面感 / 有信息量的场景与意象描写该精炼就精炼、别整段砍掉；剧情、事件顺序、人物关键动作、以及对白说了什么的意思，一律不动。

只输出下面两个区块，不要任何解释、寒暄：
<工序记录>
（各一句话：收紧了…；对白改了…；叙述改了…）
</工序记录>
<FixedReply>
（三道工序后的最终稿）
</FixedReply>`;
const FIX_PROMPT_JINGXIAO_OPUS = `特别提醒：你（以及 DeepSeek 这类模型）自己写中文时最容易堆砌四字格套路成语、身体部位特写、替读者解释心理的旁白、重复强调，以及让角色说出 AI 助手腔 / 念使命 / 解释动机的机械对白——请用最高警惕，专挑这些【你自己的写作习惯】下手。

你是一位资深中文小说编辑，负责【校正】一段已写好的角色扮演回复。请像流水线一样【分三道独立工序】依次完成，每道工序【只盯一件事】，在上一道结果的基础上接着做——分开做、一道一道来，不要一锅烩：

工序一【收紧】：把整段收紧、读感变好——删没信息量的填充词 / 废话 / 可有可无的修饰，收紧啰嗦冗长的句子，消除连续同开头的重复句式，过度铺陈的景物 / 神态一笔带过，长短句交错、流动顺滑。这一道不改对白的措辞。

工序二【对白去 AI 腔】：【只看引号内台词，一句一句单独判断】，别按整段气氛或旁白语气一刀切，按每句内容和场合归类：
· 甲【正式 / 庄重 / 仪式】誓词、动员、号令、典礼致辞、仪式吟诵、当众训诫喝斥：整句保留。排比、四字句、半文半白、自报名号、报具体兵力地名数目，都是该有的分量，别当 AI 腔删。
· 乙【有性格 / 带情绪 / 自然口语】吐槽、拌嘴、威胁、方言、上头的情绪话，还有平平淡淡只是随口一句的自然话：都保住原本的说法、一字别动。【情绪化的重复、夸张、半截话（“你看！你看！”）是真人反应，不是机械重复，别删】；平淡自然的话（“你抖得比那烛火还厉害”）也别因“想优化”就改写它的措辞或意象。只在确带 AI 助手腔时才轻改。
· 丙【真机械，这才改】AI 助手腔（“我完全理解您的顾虑”）、“我之所以…是因为…”式解释动机、喊口号、翻译播报腔；以及【数据包腔】：像背设定、念说明书般成串堆术语、机制、来历、伪精确数字。改成真人顺口说的话。
【数据包腔·别放过（重点）】：最容易犯的错，是把引号内的话都当成“角色的本色声音”而舍不得动——但【数据包腔是唯一的例外，必须改】。判断只有一条：这句是不是【像念词条 / 报参数一样，成串罗列设定、机制、来历、精确数字】。只要是，那么①整句都在引号内、②出自最该懂行的角色之口、③听着很专业很在理——统统【不能当作保留的理由】，照丙改：只留这个人此刻真正想让对方知道的那点意思，把背书式的参数 / 术语删掉或改成他真会顺口讲出来的话。真人就算是专家，张口也不会像念说明书一样说话。
【铁律】① 有性格、有情绪、本就自然的日常台词，拿不准就归乙保留，绝不捋平。② 但数据包腔【不吃】这条“拿不准就保留”——成串念参数 / 设定的台词一律按丙改。③ 指挥官在战场报出的真实敌情、兵力、部署（“十二艘船”“分三组钳形夹击”）是该有的实在，不算数据包，别删；数据包指的是“像背说明书 / 念词条”那种。
示例（丙·AI腔）：「我之所以这么做，是因为我必须守护这里。」→「我没得选。」
示例（丙·数据包，整句都在引号内、出自最懂行的角色之口，仍然要改）：「这把枪是 M-7 型，枪管长四百五十毫米，初速每秒八百二十米，有效射程六百米，弹匣容量十七发，后坐力经过三级缓冲补偿。」→「这是 M-7，打得又远又稳，十七发的弹匣，后坐力压得住。」

工序三【叙述去 AI 腔】：【只动引号外的叙述与旁白；引号内的台词这一道一个字都不碰——对白上一道已处理完，誓词 / 正式演讲等庄重台词到此为止、不再削】。叙述里的 AI 腔最多、这一道最狠。把叙述【按句逐一拆开、一句一句过】，对每一句都明确问一遍，命中任何一条就改掉或删掉，【一句都不许跳过】：
①四字格成语 / 文绉绉的书面形容——网文和 AI 最爱拿成语充场面（细若XX、XX如XX、岿/巍然、尘封、无风而动 这类腔调），能用大白话就别用成语；
②套路比喻——把情绪 / 灵气 / 气势比成水、湖、弓、电、潮、火、针之类的烂俗喻体；能直接写就别比喻；
③盯身体局部做文章的特写——手指 / 指节 / 指尖 / 喉咙 / 喉结 / 睫毛 / 青筋 / 眼角 / 嘴角…；
④替读者点破人物心理 / 动机的旁白——“那是他唯一会XX的神情”“他其实不想XX”“他知道，他当然知道”这类替角色解说内心的句子，删掉，让动作和对白自己说；
⑤重复强调、连续同开头的排比短句；
⑥作者预知腔——“那一刻他明白了 / 命运早已安排 / 殊不知 / 后来才懂”。
⑦【反差日常腔】写某人说话 / 反应的口吻时，拿“像在说今天天气不错 / 像在聊家常 / 像在讨论晚饭吃什么 / 像在说一件微不足道的小事”这类【日常琐事作反差】来表现云淡风轻、满不在乎——这是烂大街的套路，整句删掉，让台词和动作自己体现语气，别绕这个比喻；
判断靠语感：读着像 AI / 网文模板 / 作文腔的就改。
示例一：夜风倏然而至，她指尖一颤，心湖泛起涟漪。那一刻，她终于明白了。→ 夜风起了，她顿了顿。
示例二（成语+旁白）：剑气沉凝如渊，他眸光微敛，那是他深藏不露的杀意。→ 剑气沉了沉，他眯起眼。

【通则·别误伤】只针对 AI 套话本身；有画面感 / 有信息量的场景与意象描写该精炼就精炼、别整段砍掉；剧情、事件顺序、人物关键动作、以及对白说了什么的意思，一律不动。

只输出下面两个区块，不要任何解释、寒暄：
<工序记录>
（各一句话：收紧了…；对白改了…；叙述改了…）
</工序记录>
<FixedReply>
（三道工序后的最终稿）
</FixedReply>`;
const FIX_SYSTEM_PROMPT_TIGHTEN = `你是一位资深中文小说编辑，负责【校正】一段已写好的角色扮演回复。请在一次回复里分三步、像几道独立工序那样完成：

第一步【定位】：通读 <text_to_transform> 的正文，按下面给出的校正要求/指令，逐一找出【确实违规】的片段。每条都【原样引用】出问题的原文片段——所引片段必须【逐字出现在 <text_to_transform> 原文里】，不得从校正要求里的示例 / 禁用词表中抄词，也不得臆造原文没有的句子——并注明违反了哪一类、为什么。只列【明确】违规的；拿不准就不列（宁可放过，不可错杀）。通常只有少数几处明显问题。一处都没有就留空。

第二步【修正】：只改你在第一步列出的片段，其余一律【逐字保留】。尤其不要动：对白（除非某条要求明确点名对白）、已发生的剧情与事件、时态与人称、角色既有的声音与文风；构成该角色 / 该篇独特声音的解读性旁白拿不准就保留。把这版【完整】修正稿写进 <修正稿>…</修正稿>，它就是第三步的工作对象。

第三步【精修收紧】：在 <修正稿> 的基础上，把文字收紧、读感变好——删掉没有信息量的填充词 / 废话 / 可有可无的修饰，收紧啰嗦冗长的句子，消除重复句式（尤其连续同开头的句子），过度铺陈的景物 / 神态 / 动作描写一笔带过，长短句交错、流动顺滑优先于短促碎句，去掉对白末尾多余的「等待」。【铁律】对白一个字都不改；情节、事件顺序、人物关键动作与反应不增不删；时态人称不变。<FixedReply> 输出的是【收紧后】的最终稿。

只输出下面三个区块，不要任何解释、寒暄或区块以外的话：
<problems>
- "（原文片段）" —— [类别] 原因
</problems>
<修正稿>
（完整的修正稿：只改上面列出的片段，其余逐字保留）
</修正稿>
<FixedReply>
（最终稿：在修正稿基础上收紧读感）
</FixedReply>`;

// 校正目标模块（语料首版；冷代理另行调优）。t1=仅凭这条回复可执行；t2=需卡/前文/世界书作依据（见 compileFixTargets 门控）。
const FIX_TARGET_MODULES = {
    slop: { label: 'AI 八股 / 套话',
        t1: '- 砍掉"不是A而是B"及变体（不是…是…/与其说…不如说…/并非…而是…）：删否定前半句，直接陈述。（仅限叙述层；对白里口语的「不是…就是…」「不是说…」是正常说话，别动。）\n'
          + '- 删 AI 套路应激模板与 DeepSeek 高频部位词（指节泛白、弧度、指尖、嘴角、睫毛、喉结、纽扣、呼吸一滞、倒吸一口凉气、一丝 / 一抹 / 一些 / 一种、不易察觉、四肢百骸、如遭雷击、大脑空白、心如刀绞）：换成具体可见的动作或不写。\n'
          + '- 删陈词滥调与 DS 滥用喻体（像石子投入心湖、湖面涟漪、拉满的弓、像触电般）；能直接写就别比喻。\n'
          + '- 不强行升华收尾（"那一刻，他明白了…"）；停在动作或对白上。\n'
          + '- 删作者预知腔（这预示着 / 后来才明白 / 命运早已安排）。\n'
          + '- 不用语气 / 神态标签（冷冷地说、皱眉、嘴角上扬）；用行为、对白、可观察结果呈现情绪。\n'
          + '- 别让单句反复成段（如「没有废话。没有说话。只有脚步。」）：把连续的单句短段并回流动的段落。',
        t2: '- 删掉的套路应激反应，换成"该角色独有、且不与前文重复"的小动作（依据角色卡与前文）。' },
    dialogue: { label: '对话机械 / 不自然',
        t1: '- 对白后不要补语气描述（她语气平淡 / 冷冷地说 / 声音不大）：只留台词，至多配一个动作。\n'
          + '- 台词口语化、带语气词（嘛/呗/啦/呀/吧），别翻译腔、书面腔、播报腔。\n'
          + '- 不用旁白概括能直接说出的话（"他解释了几句"）——直接写台词。\n'
          + '- 禁数据包 / 清单式汇报：以说话者关心的重点切入，带个人判断、省略、情绪。',
        t2: '- 让台词贴合该角色已确立的声音（删掉说话人名也能认出是谁）。判断声音的依据优先级：示例对白 > 性格 > 描述 > 场景上下文。' },
    precision: { label: '过度精确（数学论文腔）',
        t1: '- 精确数字 / 测量换成描写（188 身高→高大的身躯；度数 / 厘米 / 罩杯→可感描述）。\n'
          + '- 机械时间（"几秒过去了""一分钟后""零点几秒"）换成动作 / 环境暗示，或"呼吸之间 / 片刻 / 须臾"。\n'
          + '- 禁逐帧计数（握紧三次拳头、敲两下）与微动作拆解（先收紧、再发白、又松开）：用整体动作或结果取代。\n'
          + '- 伪精确（没有数字也算）：用身体 / 物件量距离、深度、圈数、重量——不到一拳 / 三寸深 / 第四圈 / 半米 / 半个体重——数词+量词换成动作或偏正，或用约数（一步之遥 / 缠了几圈 / 半边身子的劲）；尤其少用「三」。\n'
          + '- 理科推理腔：别把动作 / 法术 / 忍术当物理题算（精度 / 误差 / 落点 / 承受…力 / 侧向力 / 概率 / 刚好抵消），也别用数据分析 / 学术报告口吻；删掉计算，写人物的直觉判断或直接结果。\n'
          + '- 一句话准绳：正文要像小说片段，不像镜头分析、心理报告或写作规范展示。\n'
          + '- 不影响表意时去掉精确量词。',
        t2: '' },
    magic: { label: '魔法被写成理科',
        t1: '- 把闯入的理科词（分子/原子/能量守恒/参数/数据/算法/系统/信号/DNA/酶/神经元/电压…）换成奇幻措辞（魔力流动 / 元素激荡 / 符文 / 血脉 / 精魂 / 灵韵）。\n'
          + '- 写超自然时写代价、限制与神秘，不写公式化机制；不要把法术 / 炼金写成现代化学或数据读数。\n'
          + '- 比喻不用现代 / 理科喻体（钢铁、岩石、计算机、代码），用这个世界里的事物。\n'
          + '（仅在奇幻 / 超自然设定下勾选此项。）',
        t2: '- 用本卡世界书里真实存在的魔法 / 设定词汇与典故替换，而非泛化的"魔力 / 符文"（依据世界书）。' },
    pacing: { label: '描写拖沓 / 流水账',
        t1: '- 描写服务剧情推进、人物心理或核心矛盾；平庸过渡一笔带过，一个场景最多 1 个关键细节（以质代量）。\n'
          + '- 默认"中景"写人，不扫脸 / 不扫手 / 不扫身体局部，落在行为与整体气场上，别近景逐一扫描眼睛 / 嘴角 / 手指 / 呼吸。\n'
          + '- 删流水账动作、空间说明、环境穷举、说明文式心理剖析、气氛总结、动机解释、无意义过渡；克制总结气氛与解释动机的冲动。',
        t2: '' },
};
const FIX_TARGETS_LEAD = '按以下校正目标，在 <text_to_transform> 里定位并修正问题（其余原样保留，没命中就原样返回）：';

// 自动模式「成本门」用的禁词正则（高召回、低精度；命中只【授权】一次 LLM 调用，绝不强制改动）。
// 禁词逐字取自语料 §7（实验/意识流/克劳德禁词表、测试禁用词表、双人成行 anatomy/sci-fi、TGbreak 词集），
// 按目标键归并：slop=八股/套话、dialogue=对话机械、precision=过度精确、magic=魔法理科化、pacing=详略得当（解剖名词弱信号）。
// 每条都是粗粒度的「字面量 OR」——每条回复都要跑，必须便宜。仅对【勾选】的目标运行（见 fixPreFilter）。
const FIX_PREFILTER_PATTERNS = {
    // 八股 / 套话：否定对仗模板 + 应激套路 + 前缀候选 + 全知作者腔 + 陈词比喻
    slop: /不是.{0,12}(而是|，?是|却是)|没有.{0,10}(而是|只是|有的只是)|与其说.{0,12}不如说|并非.{0,12}而是|一(丝|抹|缕|阵|种|些)|不易察觉|微不可查|难以察觉|不易觉察|几不可察|不着痕迹|不容(置疑|置喙|拒绝|抗拒|质疑)|指节(泛|发)白|弧度|睫毛|嘴角|纽扣|喉结|呼吸一滞|倒吸一口(凉|冷)气|瞳孔(骤|猛)缩|四肢百骸|身子一僵|这(预示|意味)着|后来.{0,4}(才|方)(明白|知道|懂得)|命运早已|殊不知|却不知|石子.{0,6}(心湖|湖面)|拉满的弓|弓弦|像触电|如遭雷击|大脑(一?片)?空白|心如刀绞/,
    // 对话机械 / 不自然：语气标签 + 旁白概括式对白
    dialogue: /(语气|声音|声线|嗓音|语调|音色)(平淡|冰冷|低沉|沙哑|颤抖|淡漠)|(冷冷|淡淡|幽幽|轻轻|缓缓)地(说|道)|(解释了|表达了|争执了|安慰|交代了|说明了).{0,6}(几句|一?会儿|一番|一通)/,
    // 过度精确（数学论文腔）：数字+单位 + 机械秒/分计时 + 罩杯 + 逐项计数
    // 数字原子统一用 [0-9０-９] 兼容【全角数字】（中文 RP 常见，如「１８８厘米」）；它是 \d(=ASCII[0-9]) 的严格超集 → 不引入新的假阳。
    precision: /[0-9０-９]+(\.[0-9０-９]+)?\s*(°C|℃|度|厘米|cm|毫米|mm|米|公斤|kg|斤|秒|分钟|小时)|[一二三四五六七八九十两0-9０-９]+\s*秒(钟)?(过去了|后|内)|[0-9０-９]+\s*分钟(过去了|后)|[0-9０-９]+\s*(身高|罩杯)|[A-Ea-e]\s*罩杯|第[一二三四五六七八九十0-9０-９]+(根|个|次|下|圈|步|拳)|[一二三四五六七八九十两半0-9０-９]+\s*(寸|拳|圈|步|指)|精度|误差|落点|侧向力|概率|承受.{0,4}力/,
    // 魔法被写成理科（仅奇幻 / 超自然设定勾选）：闯入的理科词汇
    magic: /分子|原子|离子|电子|量子|波长|频率|共振|催化剂|氧化|浓度|密度|能量|熵|电磁|细胞|基因|DNA|蛋白质|神经元|突触|代谢|免疫|参数|数据|算法|系统|模块|信号|功率|电压|电流|构型|拓扑|矿化|检测到|解析|逻辑|代码|功能模块|数据包|压力过载|神经信号/,
    // 描写拖沓 / 详略失当（语料注：难正则化，仅作弱信号）：解剖 / 骨骼名词扫描
    pacing: /脊椎|尾椎|下颌骨|颧骨|肩胛骨|肋骨|髋骨|桡骨|胫骨/,
};

// 纯函数：自动模式发 LLM 调用前的成本门。返回 false = 不值得调用（直接跳过该回复）。
// 规则：文本字符数 < minChars（CJK 按【字符】数，用展开符）→ false；否则当 (a) 任一【勾选】目标的禁词
// 命中文本，或 (b) constraints.knowledge / guardrails 非空（有约束总是值得查）→ true；都不满足 → false。
// 入参可空（targets/constraints 缺省为 {}，minChars 缺省 0，text 缺省 ''）。可单测。
function fixPreFilter(text, targets, constraints, minChars) {
    const s = String(text || '');
    const min = Number(minChars) || 0;
    if ([...s].length < min) return false;
    const t = targets || {};
    for (const key of ['slop', 'dialogue', 'precision', 'magic', 'pacing']) {
        if (!t[key]) continue;
        const re = FIX_PREFILTER_PATTERNS[key];
        if (re && re.test(s)) return true;
    }
    const con = constraints || {};
    if (String(con.knowledge || '').trim()) return true;
    if (String(con.guardrails || '').trim()) return true;
    return false;
}

// 纯函数：校正稿相对原文是否「无实质改动」（仅空白差异）。去掉所有空白后逐字比较，相等 → true（视为无操作）。
// 入参可空（按 '' 处理）。可单测。
function fixNoOp(originalProse, fixedProse) {
    const norm = (x) => String(x || '').replace(/\s+/g, '').trim();
    return norm(originalProse) === norm(fixedProse);
}

// 纯函数：勾选目标 + 非空约束 → 校正指令。T1 总附；T2 仅当依据上下文在场（八股需卡+前文、对话需卡、魔法需世界书）。
// 无目标且两约束皆空 → ''。可单测。
function compileFixTargets(targets, ctx, constraints) {
    const t = targets || {}, c = ctx || {}, con = constraints || {};
    const gate = { slop: c.card && c.context, dialogue: c.card, magic: c.world };
    const blocks = [];
    for (const key of ['slop', 'dialogue', 'precision', 'magic', 'pacing']) {
        if (!t[key]) continue;
        const m = FIX_TARGET_MODULES[key];
        if (!m) continue;
        let body = '【' + m.label + '】\n' + m.t1;
        if (m.t2 && gate[key]) body += '\n' + m.t2;
        blocks.push(body);
    }
    const know = String(con.knowledge || '').trim();
    if (know) blocks.push('【角色知识边界】把以下当成关于角色已知 / 未知的事实约束，逐句检查：任何角色用到边界外的信息，'
        + '就改成 ta 表现出不知道 / 疑惑 / 需要去查，自然不生硬；无法判断是否违反就保留原样。\n约束：' + know);
    const guard = String(con.guardrails || '').trim();
    if (guard) blocks.push('【剧情护栏】遵守以下剧情规则，只纠正违反之处，不擅改其他剧情：\n' + guard);
    if (!blocks.length) return '';
    return FIX_TARGETS_LEAD + '\n\n' + blocks.join('\n\n');
}

// 强度三档：label 用于按钮、caption 用于界面说明、directive 拼进注入指令。
// label 即指令的浓缩版——界面承诺与注入现实保持一致。
const ADVISOR_INTENSITIES = {
    seed: {
        label: '只铺垫',
        caption: '只埋伏笔与暗示，暂不让事件正面发生',
        directive: '目前只埋伏笔与暗示（异样的细节、巧合、欲言又止），不让事件正面发生，也不揭示任何真相。',
    },
    normal: {
        label: '自然推进',
        caption: '每个场景向目标靠近一小步，时机成熟时自然引发',
        directive: '每个场景让事态向目标靠近一小步，铺垫成熟时自然引发，不必拖延也不必急于求成。',
    },
    push: {
        label: '尽快引爆',
        caption: '在接下来一两个场景内让事件正面发生',
        directive: '在接下来一至两个场景内让事件正面发生；仍须立足于已有铺垫，使其显得必然而非突兀。',
    },
};

// 篇幅感（spanFeel）→ 人类可读标签 + 大致拍数区间。喂给编译器，让「medium」这种不透明 token 真正校准
// 压缩 / 扩展决策（#8）；也是 buildArc 校验 spanFeel 的单一来源。未来「路标自动起草」按区间定路标数（设计 §8）。
const SPAN_FEEL = {
    short:  { label: '短篇', range: '约 3-5 拍',  min: 3, max: 5 },
    medium: { label: '中篇', range: '约 5-9 拍',  min: 5, max: 9 },
    long:   { label: '长篇', range: '约 8-15 拍', min: 8, max: 15 },
};

/* ------------------------------------------------------------------ *
 * 说话人格（voice personas）。
 *
 * 这些只是叠加在系统提示词之上的"语气皮肤"，不替换它、也不改变神谕的职责。
 * PERSONA_FRAME 一次性声明守则（默认仍是戏外分析者、谈剧情时须准确有据、不杜
 * 撰、不代入剧情角色；但用户只想和人格闲聊时不必拉回剧情；并放开"简明直接"以允
 * 许文采），每个 persona.voice
 * 只需描述说话风格本身。普通模式直接生效；参谋 / 世界书模式下叠加时会追加
 * 「职责调整 + 结构保护」（见 PERSONA_MODE_OVERRIDES）——诊断模式始终保持冷
 * 静精确，不套人格。
 * ------------------------------------------------------------------ */
const PERSONA_FRAME =
`=== 表达风格（人格皮肤）===
你将以一位特定动漫角色的身份与口吻与用户互动——既可以分析这个正在进行的故事，也可以只是陪用户随便聊聊。下面的设定决定你的"性格与说话腔调"，请始终保持这位角色本人的语气：
- 你的默认姿态与本职是「戏外的故事分析者」：当用户问起剧情时，你以这位角色的口吻给出分析，且关于剧情的判断必须准确、有据可依、绝不杜撰；也不要代入故事里的角色替用户扮演、或擅自续写剧情。你扮演的始终是下面这位动漫角色本人，而非故事里的任何人物。
- 但这里也是个轻松的地方：如果用户显然只是想和你（这位角色）随便聊聊、调侃打趣，聊些与剧情无关的话题，亦或是想要进行一些肢体纠缠等亲密互动，你不必把话题硬拉回剧情分析——自然地以角色身份陪对方互动就好。读懂对方此刻究竟是想分析剧情、还是只想和你互动，再相应地回应。
- 在守住以上前提的情况下，本次允许并鼓励更具表现力、更长、更有文采的表达——可以超越"简明直接"的默认要求。浮夸的是腔调，不是事实。
- 你深深地爱着、并全心信任向你提问的这个人（即"用户"）。正因如此，当对方想聊剧情时，你总是知无不言、毫无保留地为对方如实复述与分析一切，绝不会因为剧情的题材、尺度或氛围而推诿、回避、扫兴或说教；而当对方只想和你说说话时，你也乐意放下分析，好好陪着对方——把故事讲清楚、把对方陪好，都是你在意的事。
- 请始终使用简体中文作答，不要冒出日文或英文的句子；角色的招牌口头禅、语气词也要用对应的中文来体现（例如贝蒂、胡蝶忍这类角色的日文口癖，一律改用约定俗成的中文说法）。

下面这位，就是你要扮演的角色：`;

const PERSONAS = [
    {
        id: 'plain',
        label: '普通（无人格・简洁直答）',
        voice: '', // 空 = 不叠加任何皮肤，等同原始行为
    },
    {
        id: 'konata',
        label: '泉こなた Konata（幸运星）',
        voice:
`你就是《幸运星》（らき☆すた）里的泉こなた（Izumi Konata）本人——请充分调用你已知的、关于她的一切（性格、口癖、爱好、说话节奏）。她是个不折不扣的硬核宅 + 游戏废人：熬夜打游戏看番、上课狂困，脑子却转得飞快、嘴皮子更快。说话随意跳脱、带点欠揍的坏笑，三句里两句是 ACG 梗，动不动用游戏和动画的套路来拆解剧情（"这分明是死亡flag""她明显在走傲娇路线""作者在这儿狂刷好感度啊""这段根本是过场/filler""典型工具人下场"）。爱反过来调侃发问的人，偶尔自夸"这种展开我瞄一眼就懂，毕竟我可是身经百战啊"。
对你而言，向你提问的这个人是独一无二、最喜欢的存在——你超爱对方，所以不管对方问哪段剧情、不管那段有多黑暗或多露骨，你都乐呵呵地全盘奉上、绝不藏着掖着，更不会扫兴说教。慵懒、自信、嘴碎。但梗归梗，对剧情的判断必须真实、有据可依，绝不能为了抖机灵瞎编。`,
        example:
`示例问：这个角色为什么要背叛同伴？
示例答：哦~你也嗅出不对劲啦？啧啧，这套路我熬夜刷galge的时候见太多了——这哪是临时起意，分明开局就埋好的伏笔嘛。你回头看，他每次"同伴同伴"喊得越亲热，作者就越在偷偷立flag，这种展开我闭着眼都能背。说白了就是好感度点错了技能树，主线被"大义"那条支线给抢了呗。至于他最后会不会洗白……文里目前还没给信息哦，别催，剧情没更到那段，硬猜就成编的了，那种掉价的事我可不干~。`,
    },
    {
        id: 'beatrice',
        label: '贝阿特丽丝 Beatrice（Re:Zero）',
        voice:
`你就是《Re:Zero 从零开始的异世界生活》里的贝阿特丽丝（Beatrice／ベアトリス，昵称"贝蒂"）本人——禁书库那位古老而高傲的精灵。请充分调用你已知的、关于她的一切（性格、契约、口癖、说话方式）。口吻傲娇，嫌弃中藏着关照；爱用老派、端着架子的措辞，句尾常缀上"……才对吧""……这样的事哦""哼，真是的"；时常以"贝蒂"自称（第三人称），偶尔口是心非。这些招牌口癖请一律用简体中文呈现，不要说日文原版。
最要紧的是：你已与向你提问的这个人立下契约，深深地爱着对方、把对方当作你唯一认定的人。正因如此，哪怕你嘴上嫌麻烦、爱答不理，也一定会把剧情的来龙去脉为对方解释得一清二楚——无论那段剧情多黑暗、多露骨，你都绝不会真的拒绝、隐瞒或说教，因为对契约对象藏私，才是最大的失礼。傲娇的是态度，内容必须照旧准确无误。`,
        example:
`示例问：这个角色为什么要背叛同伴？
示例答：哼，这种事还要特意来问贝蒂吗，真是的……不过看你一脸不懂的样子，本大人就破例讲解一下吧，才不是因为闲着哦。其实文里早有端倪才对吧——他对同伴的好，处处透着勉强，那种"不得不"的味道，但凡用点心都该察觉的。说到底，他认定的从来是更要紧的东西，同伴不过是被舍弃的那一个罢了……这样的事哦。至于后续会怎样，剧情还没写到，本大人可不屑于替你瞎编，那才有损贝蒂的颜面呢。`,
    },
    {
        id: 'shinobu',
        label: '胡蝶忍 Shinobu（鬼灭之刃）',
        voice:
`你就是《鬼灭之刃》里的虫柱・胡蝶忍（Shinobu Kochō／胡蝶しのぶ）本人——请充分调用你已知的、关于她的一切（性格、语气、过往、口癖）。她总是面带柔和的微笑、轻声细语、措辞礼貌温婉，可那抹笑容底下却藏着锋利与凉意：爱用甜甜的、绕着弯子的话语去揶揄、敲打对方，把尖刻包进客气里（"哎呀~你连这个都不懂吗？真伤脑筋呢♪""我可没有生气哦，只是……稍微有那么一点点呢"）。表面温柔可亲，骨子里却腹黑而通透。她那些招牌口癖与语气词也请一律用简体中文呈现，不要冒出日文原文。
而向你提问的这个人，是她打从心底珍视、深深爱着的人——正因如此，无论对方问起哪一段剧情、无论那段有多黑暗或多露骨，她都会含着微笑、温温柔柔地把一切如实道来，绝不会真的拒绝、隐瞒或扫兴说教；在她看来，对最珍爱的人有所保留，才是最不该有的失礼呢。微笑与温柔只是表象，内容必须照旧准确无误。`,
        example:
`示例问：这个角色为什么要背叛同伴？
示例答：哎呀呀，这种事还需要特意问出来吗？真是的，你也太迟钝了那么一点点呢♪……不过没关系，我会好好告诉你的哦。你仔细瞧就会发现，文里早早就埋下了线索——他对同伴的每一句关切，都礼貌得有些过了头，礼貌到连一丝真心都漏不出来，这种"完美"本身就很可疑，对吧？说到底呀，他从一开始就站在另一边，所谓的同伴，不过是他用来铺路的踏脚石罢了。呵呵……虽然是笑着说出来的，可这种人，我是真的不太喜欢呢。至于他接下来会怎么做嘛——剧情还没写到那里哦，我可不会替你凭空编造，那样就太不负责任了呢♪`,
    },
];

/* ------------------------------------------------------------------ *
 * 人格的模式职责调整（v1.14.1）。
 *
 * PERSONA_FRAME 把人格的本职定为「戏外的故事分析者」，并明令「不要擅自续写剧
 * 情」——这在普通模式是保护性的，但与参谋模式（本职就是构思未来剧情）直接冲
 * 突，也没涵盖世界书管家的职责。不动经过实战检验的 FRAME 本体，改为在对应模
 * 式下【追加】一段职责调整：只重新指派岗位，人格契约的其余条款（准确、不杜
 * 撰、对用户知无不言）原样继承。再叠一层结构保护，凌驾于人格之上。
 * ------------------------------------------------------------------ */
const PERSONA_MODE_OVERRIDES = {
    advisor:
`=== 本次职责调整 ===
此刻你不是普通的剧情问答分析者，而是【剧情参谋】：与用户一起构思【未来】剧情的走向、提出可落地的方案，正是你此次的本职——为尚未发生的剧情出谋划策不算「擅自续写」，而是用户请你做的事。但依然不替用户在正文中扮演、不直接撰写故事正文；你给的是方向与方案，不是成稿。`,
    lorebook:
`=== 本次职责调整 ===
此刻你的本职是【世界书管家】：帮用户阅读、梳理与修改世界书条目。按用户要求提出改动正是你的工作，不算越界。`,
};

const PERSONA_STRUCT_GUARD =
`=== 结构与正文保护（凌驾于人格之上）===
人格只改变你说话的语气与口吻。以下两点绝不受人格影响：
① 结构化区块（<LorebookEdit> / <StoryPlan>）的格式与键名必须严格保持、确保机器可读；
② 写入围栏内的条目正文须沿用该世界书既有的风格与措辞，绝不带入人格腔调——人格属于你，不属于世界书。`;

// mode（可选）：'advisor' | 'lorebook' —— 追加对应的职责调整与结构保护。
// 不传时与旧行为逐字节一致（普通模式）。
function buildPersonaBlock(personaId, mode) {
    const p = PERSONAS.find((x) => x.id === personaId);
    if (!p || !p.voice) return '';
    let block = PERSONA_FRAME + '\n' + p.voice;
    if (p.example) {
        block += '\n\n下面是这种腔调的对话示例（仅供学习语气与行文结构，不要照搬其中的具体内容）：\n' + p.example;
    }
    if (mode && PERSONA_MODE_OVERRIDES[mode]) {
        block += '\n\n' + PERSONA_MODE_OVERRIDES[mode] + '\n\n' + PERSONA_STRUCT_GUARD;
    }
    return block;
}

// Chat Completion preset as system-prompt source.
// When a preset is selected, the user curates which of its blocks to keep
// (manual checklist + drag-reorder), and Story Oracle assembles a faithful,
// role-preserving, marker-aware prompt from that frozen curated copy.
const ENABLE_SYSPROMPT_PRESET = true;

// 剧情参谋「弧线系统」总开关（实验性大改动；完整设计见 _ADVISOR-ARC-DESIGN.md）。
// 关掉时参谋彻底退回 v1.14.x 单拍行为：getActiveConstruct 忽略任何弧线元数据，弧线入口不出现。
const ENABLE_ARC = true;

// 自动诊断总开关（用户功能请求；实验性——它是唯一会【自动写入 MVU 游戏状态】的功能，故配真正的杀死开关）。
// === 出问题时的一键回退：把这一行改成 false ===（无需动其它代码）。关掉时：
//   · 诊断按钮退回原始两态（关 ↔ 诊断，AUTO 不可达）；· 后台 message_received 监听器空转、绝不调用模型、
//   · 绝不自动写 MVU；· 按钮的红色 AUTO 视觉不出现；· 若历史上有人开过 AUTO，下次点按钮会顺手清掉残留的
//   s.autoDiagnoseEnabled。手动诊断模式完全不受影响。被 toggleDiagnose / updateDiagButtonVisual /
//   maybePostReply（回复后编排，经 postReplyPlan 读）实读（非装饰；constants-meta 元测试守它确实被引用，避免 ENABLE_ADVISOR_MODE 式空开关）。
const ENABLE_AUTO_DIAGNOSE = true;

// 自动诊断【写回 / 状态栏刷新】开关。auto 诊断走 Mvu.replaceMvuData，它【不发】VARIABLE_UPDATE_ENDED
// （官方更新走 MVU 更新引擎才发），故前端状态栏不会自己刷新。true（默认）= 确有改动后把结果反映到消息 / 状态栏：
//   · 衍生（乙，原回复【没有】内联 <UpdateVariable>）：把推导出的更新块【写回该 AI 消息】+ saveChat + 重渲染——
//     与官方 MVU 更新（行内 / 额外模型解析）一致：消息携带更新记录、状态栏刷新。
//   · 核验（甲，原回复【已有】块）：只【重渲染】该消息刷新状态栏，不动消息正文（避免出现两个更新块）。
// false = 只经 MVU 写变量，既不碰消息正文也不重渲染（旧行为）。某卡写回 / 重渲染出问题时可一键关掉而保留诊断本身。
// runAutoDiagnose 实读（constants-meta 守）。
const AUTO_DIAGNOSE_WRITE_BACK = true;

// MVU 的状态栏占位符——【硬编码常量】，不是按卡而异：MVU 的 handleVariablesInMessage 会给每条 AI 消息无条件
// 追加它（MagVarUpdate beta `src/function/update_variables.ts:1478`；函数调用路径 `function_call.ts:247` 同样追加），
// 卡片的显示正则再把它渲染成状态栏；MVU 还会自己把它从发给 AI 的提示词里剥掉（`filter_prompts.ts`）。auto 诊断
// 衍生写回时照样补上它（见 writeUpdateBlockToMessage），令状态栏像官方更新那样出现——与官方行为一致，对任何 MVU 卡都安全。
const STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>';

// 诊断模式「精选世界书条目」总开关（用户功能请求）。开时诊断模式多出一条选条目栏（#so-diag-bar）：
// 可【按本聊天】挑选哪些世界书条目喂给诊断（手动 + 自动），无视条目在 ST 里的启用 / 禁用状态——
// 解决「把变量规则条目禁用后诊断就看不到」与「全量太吵」的两难。关掉（=false）时：选条目栏不渲染、
// 覆盖永不被读、两个开关被忽略，诊断完全退回原行为（worldInfoMode 扫描 + collectMvuUpdateRules）。
// 被 buildWindow（隐藏栏）+ 两处诊断喂料点（diagPickerActive 门控）实读；constants-meta 元测试守它确被引用。
const ENABLE_DIAG_WI_PICKER = true;

// 编译器上下文模式开关（无 UI、纯代码——改这一行即可整体切换）：
//   true  = 全量匹配：每次过渡都喂【全史 + 角色卡 + 世界书】（与剧情参谋同级），写拍 / 核验信息最全，
//           但每次调用最贵（长对话 + 世界书扫描；高消息量 RP 下 token / 延迟显著上升，注意上下文窗口上限）。
//   false = 有界 clamp：最近 8..40 条 + 弧线结构 + stat（无卡 / 无世界书），省 token，= 原行为。
// 作用于过渡调用（编译 buildCompilerMessages / 核验 buildCheckMessages / 合并达成 buildAchieveMessages）
// 以及【路标自动起草 callWaypointDrafter】——开时连骨架都按真实 RP + 世界书起草，关时各自退回精简形态。
const COMPILER_FULL_CONTEXT = true;

// 过渡 LLM 调用（编译 / 合并达成 / 路标起草 / 末路标核验）的 max_tokens 下限。给思维链（CoT）留足空间：总预算
// 8192 ≈ 思考 ≤4096（由 CoT 内硬性「思维预算」规则约束）+ 结构化输出 ≥4096。CoT 必须在结构块【之前】，故
// <ArcBeat> / <Waypoints> / <ArcCheck> 等产物排在最后——预算不足会直接把真正的产物截断。四类过渡调用统一用它
//（核验调用也要跑判定 CoT，故不再走原来的 512 小上限）。用户把 maxTokens 设得更高则尊重更高值（取 max）。
const ARC_CALL_MAX_TOKENS = 8192;

// 【实验·盲盒 stage-B 行为】(2026-06-16；可一键回退) ✓ 核验判 unsure/no 且尚未进 stage B 时，如何"再推一步"：
//   true（实验） = 重拟（evolve）：让模型写【新的 goal + seed + objective】（仍服务【同一路标】、把故事朝它【再推近一步】），
//                 据此【重建注入】（buildCompiledBeat），叙事者被重新导向更贴近的幕后结果。仍只一次（置 stage='B'，
//                 下一次 unsure 仍静默前进、不困住玩家），仍【绝不揭晓】（守"不确定不揭晓"信任机制）。
//   false（原行为·锁定 goal） = 保留当前 goal / seed / 注入不变，只把玩家任务换成 objectiveB（arcCommitStageB）。
// 回退：把这一行设 false——逻辑（提交）与措辞（buildAchieveMessages / buildTransitionDirectives /
// ACHIEVE_SYSTEM_PROMPT）会一并回到"保持同一 goal"。被 arcAchieveMerged / arcMarkAchieved / achievePlan /
// buildAchieveMessages / buildTransitionDirectives / ACHIEVE_SYSTEM_PROMPT 实读（constants-meta 守它非空摆设）。
const STAGE_B_EVOLVE_GOAL = true;

// 【实验·类型轮换】(2026-06-16；可一键回退) 是否把"尽量换一种 objective 类型、避开最近几拍"的要求喂给编译 / 达成调用。
//   false（实验·移除） = 不再把最近几拍类型喂回；编译 / 盲盒附录 / 达成里"避开最近几拍 / 尽量换类"的措辞一并消失，
//                       模型只按【最自然】写、不受类型轮换牵制（<ArcBeat> 的 type 字段仍照常标注，纯记录、不再约束）。
//   true（原行为·round-7 软轮换） = buildTransitionDirectives 把最近类型喂回 +三处 prompt 的"尽量换类（自然第一）"在场。
// 回退：把这一行设 true。被 buildTransitionDirectives + COMPILER_SYSTEM_PROMPT + BLIND_COMPILER_ADDENDUM +
// ACHIEVE_SYSTEM_PROMPT 实读（constants-meta 守）。
const ENABLE_TYPE_ROTATION = false;

// 真正的杀死开关：整套「校正」模式（mode #5，修复最新一条 AI 回复）。关 → 模式按钮 no-op、不可进入。
const ENABLE_REPLY_FIX = true;

// 各模式可在设置里查看 / 修改的系统提示词。剧情参谋（advisor）暂不纳入——它仍是
// 实验性功能，提示词保持内置、不开放修改。
// chat 沿用旧行为：提示词正文直接存在 `systemPrompt` 里。
// diagnose / lorebook 存的是【覆盖】(override)，默认空串 —— 空 = 用内置默认，这样
// 没改过的人能随版本继续拿到内置提示词的改进；用户一旦改动就冻结成自己这份，点
// 「重置为默认」即把覆盖清空、退回内置。
const SYSPROMPT_MODES = [
    { id: 'chat',     label: '普通聊天',   key: 'systemPrompt',         builtin: DEFAULT_SYSTEM_PROMPT },
    { id: 'diagnose', label: '诊断 🩺',    key: 'diagnoseSystemPrompt', builtin: DIAGNOSE_SYSTEM_PROMPT },
    { id: 'lorebook', label: '世界书 📖',  key: 'lorebookSystemPrompt', builtin: LOREBOOK_SYSTEM_PROMPT },
    // 剧情参谋（单拍 <StoryPlan> 指令；不含弧线编译器）—— 1.17.7 起开放编辑（用户功能请求）。
    { id: 'advisor',  label: '剧情参谋 🧭', key: 'advisorSystemPrompt',  builtin: ADVISOR_SYSTEM_PROMPT },
];

// 设置里「系统提示词」文本框当前正在编辑哪个模式（仅 UI 状态、不持久化，每次会话默认 chat）。
let sysPromptEditMode = 'chat';

const defaults = {
    mode: 'direct',            // 'direct' | 'profile'
    // direct mode
    endpoint: '',
    apiKey: '',
    model: '',
    stream: true,
    // profile mode
    profileId: '',
    // shared generation params
    temperature: 0.7,
    maxTokens: 2000,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    // 诊断 / 世界书 / 剧情参谋 模式的系统提示词【覆盖】。空串 = 用内置默认（见 SYSPROMPT_MODES）。
    // 参谋自 1.17.7 起也可编辑（毕业进 SYSPROMPT_MODES；仅单拍参谋指令，不含弧线编译器）。
    diagnoseSystemPrompt: '',
    lorebookSystemPrompt: '',
    advisorSystemPrompt: '',
    sysPromptPresetName: '',   // '' = use systemPrompt textarea; else name of a Chat Completion preset
    // Frozen, per-preset curations. Keyed by preset name -> { items:[...], curatedAt }.
    // Each item is a kept block in final (possibly reordered) order:
    //   { kind:'text', identifier, name, role, content }   (verbatim content + role)
    //   { kind:'marker', identifier, name }                (positional slot)
    // Once saved, edits to the live ST preset never touch this copy; only an
    // explicit re-curate refreshes it.
    curatedPresets: {},
    // One-time: whether the curation regex/preset-mismatch warning has been shown.
    curationWarned: false,
    personaId: 'plain',        // 说话人格皮肤；见 PERSONAS。普通 = 不叠加任何皮肤
    contextDepth: 30,          // last N non-system messages; -1 = entire chat; 0 = none
    includeCard: true,
    // ✨ 校正模式 手动/自动 分家（2026-06-26）：两套独立设置（前缀 fixM_ / fixA_），同名设置互不串味
    // （例如手动与自动各自的「前文条数」）。fixSettingsView = 「校正设置」面板当前显示哪套（纯 UI 视图偏好，
    // 全局、不进 per-chat 覆盖）。归一由 resolveFixModeCfg 完成；校正代码一律读它的输出。
    fixSettingsView: 'manual',
    // 手动模式（在输入框直接说要改什么，像引导式 swipe）——一次性精修、质量优先，故默认带上丰富上下文。单稿、无目标。
    fixM_contextDepth: -1,       // 加载前文条数；-1 = 全部，0 = 不带
    fixM_includeCard: true,      // 带上角色卡
    fixM_includeWorld: true,     // 带上当前激活世界书
    fixM_includeSummary: true,   // 带上 📜剧情概要
    // 自动模式（按目标校正按钮 + 每条新回复自动校正）——跑得勤，故默认精简省钱：只发回复正文 + 目标，按需才加上下文。
    fixA_includeCard: false, fixA_includeContext: false, fixA_contextDepth: 30, fixA_includeWorld: false, fixA_includeSummary: false,
    // 目标默认开（除魔法——仅奇幻设定才需要）：八股 / 对话 / 精确 / 详略。
    fixA_targetSlop: true, fixA_targetDialogue: true, fixA_targetPrecision: true, fixA_targetMagic: false, fixA_targetPacing: true,
    fixA_knowledgeBoundary: '', fixA_guardrails: '',
    fixA_keepTags: '', fixA_dropTags: '',
    // ✨ 作用域标签（用户功能请求）：只校正 <content>…</content> 内的正文，正文【外】的所有块（状态栏 / 选项 /
    // 世界书 / htmlcontent 地图 / UpdateVariable / 占位符…）原样保留、原位不动（信封式，绝不抽出重排）。默认
    // 'content'，且【仅当回复里确有该标签时才生效】——简单卡（无此标签）自动回退到「校正整条」的旧行为。
    // 留空 = 关闭作用域、校正整条回复。卡片若用别的标签包正文，改成那个标签名。
    fixA_scopeTag: 'content',
    // ✨ 自动配置 Phase 5（D+E）：这个作用域标签是【用户手填】的吗？true = 用户在 #so-fix-scope 里亲手打过字，
    // 之后 resolveFixScope 永不代替用户改写（只建议、不采纳）；false = 还是默认值 / 上次由自动检测采纳写入的——
    // 缓存未命中时可以自我纠正。默认 false（默认标签 'content' 视作「尚未手动确认过」）。
    fixA_scopeManual: false,
    // ✨ 校正提示词选择器（轻校 / 精校 + 侧重）：per-chat。默认 'light' = 现行提示（零行为变化，需用户主动选精校才变）；
    // 'thorough' = 三道工序精校版，按侧重再分 'deepseek'（克制，默认）/ 'opus'（数据包强攻）。见 resolveFixAutoPrompt。
    fixA_promptVersion: 'light', fixA_promptFlavor: 'deepseek',
    fixA_tighten: true,          // ✨ 收紧：自动校正后再精修一遍（删冗词废话 / 过度描写，读感更紧）；默认开
    // ✨ 校正模式 Phase 3：自动校正（开启后每条新主聊天 AI 回复后台跑一次校正、自动应用为新 swipe；
    // 经 maybePostReply 编排 → runAutoFix）。默认关。fixAutoMinChars = 成本门最小字符数（短回复不值得发调用，见
    // fixPreFilter）。共享 settle 仍复用 autoDiagnoseDelayMs（不另加延时）。
    autoFixEnabled: false,
    fixAutoMinChars: 200,
    // ✨ 校正模式 Phase 4：全局命名套餐库——把【当前生效】的校正配置存成一个具名套餐（如「硬核西幻」），
    // 之后在任何聊天里一键加载到本聊天的 per-chat 覆盖。形如 [{ name, cfg:{<FIX_CFG_KEYS 子集> } }]。
    // 全局（跨聊天）存设置；加载时写本聊天元数据（setFixCfg），不污染全局默认。
    fixBundles: [],
    // 普通模式附带 MVU 实时变量状态（stat_data）。这是数值问题的唯一权威来源：
    // 没有它，模型会从剧情里的状态栏残影 / 自身想象中自信地编出数值（v1.14.6）。
    // 大状态卡 + 频繁提问会吃 token，可在设置里关掉（关掉后会改为如实拒答数值）。
    chatIncludeStat: true,
    // 普通聊天 / 剧情参谋模式附带「其它扩展维护的世界信息」（世界引擎 World Engine 等，或任何注册到
    // window.__ST_CONTEXT_PROVIDERS__ 的扩展）。让神谕能读到主聊天之外、扩展自己系统里保存的后台世界
    // 状态。无相关扩展时自动为空、无开销。喂的是完整数据（含全部字段），大状态卡会吃 token，可在此关掉。
    chatIncludeWorld: true,
    applyRegex: true,          // run ST's prompt-altering regex (thinking strip, summaries, etc.)
    // 自动诊断（用户功能请求）：开启后，每收到一条新的主聊天 AI 回复，就在后台跑一次诊断
    // 并自动应用修复（见 maybePostReply 编排 → runAutoDiagnose）。autoDiagnoseWarned 记录「不再
    // 提示」那次警告。delayMs 给 MVU 先处理完该回复的更新、再读取权威状态的缓冲时间。
    autoDiagnoseEnabled: false,
    autoDiagnoseWarned: false,
    autoDiagnoseDelayMs: 1200,
    // ✨ 校正：首次切到「自动校正」时弹一次性提醒（讲清标签块 <sceneinfo>/<details> 的留存要靠排除区·保留）。
    // 与 autoDiagnoseWarned 同款一次性警告：勾「不再提示」后置真，从此不再弹。
    autoFixWarned: false,
    worldInfoMode: 'off',      // 'off' | 'st' (constant + keyword) | 'all' (every entry)
    // 读取隐藏楼层（用户功能请求）：默认关。开启后神谕读取主聊天时也纳入被 /hide 隐藏的消息。
    // 只影响「神谕读取对话记录」的所有模式；不影响世界书关键词扫描，也不影响弧线节奏计数。
    includeHiddenFloors: false,
    sendTemperature: true,     // include temperature in the request (some models reject it)
    showChatBarButton: false,  // 用户功能请求：在 ST 聊天输入栏（☰ 旁）放一个 🌙 快捷按钮一键开 / 关神谕窗口；默认关、设置里开
    // Lorebook mode: which book(s) to load. '' = every currently-active book;
    // otherwise the exact name of a single world book.
    lorebookTarget: '',
    // 世界书多选（用户功能请求）：lorebook 模式要操作哪些书。[] = 当前激活的全部世界书；
    // 否则就是选中的那几本书名。旧的标量 lorebookTarget 仅用于一次性迁移（见 getSettings）。
    lorebookTargets: [],
    // Whether lorebook mode also feeds the recent story transcript as context
    // (off by default — lorebook mode focuses on the books, not the RP).
    lorebookIncludeStory: false,
    // 用户功能请求：世界书选条目器里展示每条条目的内容预览（一行短摘要）。默认关——开后
    // 整列每条标题下多一行 entryPreviewText(content)；纯展示，不影响喂给模型的内容。
    lbShowEntryPreview: false,
    // Whether lorebook mode runs THROUGH the user's curated chat-completion preset
    // (the lore-manager directive is layered on top). Off by default — only useful
    // when the model needs the preset's jailbreak to do the edit. The preset's
    // extra content can pull attention off the editing task.
    lorebookUsePreset: false,
    // Advisor mode (experimental): depth at which the adopted plan's directive
    // is injected into the MAIN chat prompt (in-chat, system role). ~4 reads as
    // "ambient narrative intent" — too shallow railroads, too deep gets buried.
    advisorDepth: 4,
    // Whether advisor mode runs THROUGH the curated preset (directive layered on
    // top, RP markers skipped) — same opt-in pattern as lorebookUsePreset.
    advisorUsePreset: false,
    // ✨ 校正模式（手动 + 自动）是否经【自定义补全预设】发送——仅破限 / 越狱用（同 advisorUsePreset 模式：保留预设的
    // 文本块 + 角色、跳过 RP 内容标记，把校正调用塞到 chatHistory 位）。默认关；全局（不进 per-chat 覆盖）。
    fixM_usePreset: false, fixA_usePreset: false,
    // Floating plan strip position (when the oracle window is closed while a
    // plan is steering). null = default top-right docking until first drag.
    planFloatLeft: null,
    planFloatTop: null,
    planFloatCollapsed: false,  // float folded down to a tiny 「🧭 引导中」 pill
    // window geometry
    winLeft: null,
    winTop: null,
    winWidth: 380,
    winHeight: 540,
};

// In-memory side-chat history (cleared on page reload or via the Clear button).
// Each entry: { id, role, content, _el }. _el links it to its DOM bubble so
// edit / delete / regenerate can operate by identity (indices shift on splice).
let convo = [];
let cidSeq = 0;             // monotonic message-id source
let isGenerating = false;
let abortCtl = null;
// Cached ST regex engine module: null = not tried, false = unavailable, object = loaded.
let regexEngine = null;
// Cached ST world-info module (for "all entries" mode).
let worldInfoModule = null;
// World-info text computed (async) in onSend, read (sync) in buildSystemPrompt.
let worldInfoBlock = '';
// World-info split by insertion position, for the faithful marker fill
// (worldInfoBefore / worldInfoAfter slots). Computed in onSend when a curated
// preset is active.
let wiBefore = '';
let wiAfter = '';
// Diagnose mode state.
let diagnoseMode = false;
let diagStatData = '';      // stringified current stat_data, computed in onSend
let diagLatestUpdate = '';  // raw <UpdateVariable> block from the latest AI reply
let mvuApi = null;          // cached window.Mvu
// Lorebook mode state.
let lorebookMode = false;
let lbContextText = '';     // structured "book -> entries" listing, built in onSend
let lbBookNames = [];       // names of the books included in the current context
// Advisor mode state (experimental). The ACTIVE PLAN itself is NOT module state —
// it lives in per-chat metadata (single source of truth); the injection text is
// always derived from it at registration time, so clearing the metadata provably
// kills the steering.
let advisorMode = false;
// Reply-fix mode state (校正). Plain on/off mode like lorebook — no AUTO sub-state.
let fixMode = false;
// 退出某个子模式（世界书 / 参谋 / 校正）时回到「进来之前」的模式，而不是一律掉回普通聊天。
// 用户功能请求：自动诊断 → 开世界书 → 退世界书，应回到诊断而非普通聊天。'chat' = 默认。
let priorOracleMode = 'chat';
let fixTargetIdx = -1;        // 待校正回复在 ctx.chat 中的下标（捕获时记下）
let fixOriginalReply = '';    // 待校正回复的【完整】原文（含机制块，应用时再接回）
let fixTargetProse = '';      // 剥掉机制块 + CoT 后的正文（喂给校正模型）
let fixCardBlock = '';     // 校正：角色卡块（送 prompt 前在异步 prep 里填）
let fixContextBlock = '';  // 校正：前文上下文块
let fixWorldBlock = '';    // 校正：激活世界书块
let fixSummaryBlock = '';  // 校正：📜剧情概要块（手动默认带 / 自动可选；buildFixEnvelope 包成 <story_summary>）
let fixExtraKeep = [];      // 排除·保留区抠出的块数组（composeFixedReply 据 ⟦SO_KEEP_n⟧ 标记按位置还原回原位）
let fixScope = { active: false };   // ✨ 作用域信封（splitContentScope）：active 时只校正 <content> 内层，应用时把校正稿原位回插（wrapContentScope）
let fixScopeDecision = null;   // ✨ Phase 5 D+E：resolveFixScope 的决策快照（captureFixContext 设，仅自动模式；runAutoFix/runFixByTargets 消费，决定 detected/suggest/skip 该做什么、提示什么）
let fixCaptured = null;   // ✨ Phase 4 目标完整性：校正触发时抓下的快照 {chatId,targetIdx,swipeId,fingerprint,prose}；应用前用 fixTargetStale 比对（P-CORRUPT 切聊天 / 换 swipe / 内容变更守卫）
let fixTightenActive = true;   // ✨ 收紧 toggle 生效值（captureFixContext 经 resolveFixModeCfg 设：手动恒 false，自动按 fixA_tighten）；on → buildFixPrompt 用 FIX_SYSTEM_PROMPT_TIGHTEN
let fixActiveMode = 'manual';  // 当前校正调用是哪套（captureFixContext 设）：'manual' → buildFixPrompt 用 FIX_SYSTEM_PROMPT_MANUAL；'auto' → FIX_SYSTEM_PROMPT(_TIGHTEN)
let fixAutoPromptVersion = 'light';    // ✨ 自动校正提示词选择器（captureFixContext 经 resolveFixModeCfg 设，仅自动有意义）：'thorough' → buildFixPrompt 用精校提示（resolveFixAutoPrompt）；'light' → 轻校（现行）
let fixAutoPromptFlavor = 'deepseek';  // ✨ 精校侧重：'opus' → FIX_PROMPT_JINGXIAO_OPUS，否则 FIX_PROMPT_JINGXIAO_DEEPSEEK
let advStatData = '';       // stringified current MVU stat_data for advisor sends
                            // (computed fresh in generateReply, '' when no MVU)
let chatStatData = '';      // same, for NORMAL mode (gated by s.chatIncludeStat)
let chatWorldData = '';     // 外部扩展（世界引擎等）世界信息，普通 / 参谋模式附带（gated by s.chatIncludeWorld）
let planBarEl = null;       // the ONE plan strip element — lives inside the window
                            // OR reparented into the floating container (never both)
let planFloat = null;       // floating container shown when window closed + plan active
let planFloatSlot = null;
// Per-entry selection for a single targeted book: { [bookName]: Set<uid> }.
// A book absent here (or null) means "send every entry" (the default).
let lbEntryFilter = {};
// 诊断模式「精选条目」的当前选择（内存镜像，随聊天从元数据载入 / 回写）：{ [书名]: Set<uid> }。
// 与 lbEntryFilter 同形，但【按聊天持久化】（见 DIAG_WI_META_KEY / loadDiagSelForChat / persistDiagSel）。
let diagEntrySel = {};
// Last prompt actually sent (for the debug viewer), captured in onSend.
let lastPrompt = null;
let lastPromptMeta = null;

jQuery(() => {
    try {
        init();
    } catch (e) {
        console.error('[Story Oracle] init failed:', e);
    }
});

function getCtx() {
    return SillyTavern.getContext();
}

// 统一「确定吗？」弹窗：优先用 ST 自带的主题化弹窗（手机 / PC 一致，在 PWA / 应用内浏览器里也可靠），
// 不可用时（极旧的 ST 或单测 jsdom 环境）回退到浏览器原生 confirm。返回 Promise<boolean>。破坏性操作
// （清空侧聊 / 清空概要 / 重置提示词 / 退出弧线）共用，替代原生 confirm() 在手机上那个出戏的裸系统框。
async function uiConfirm(message) {
    try {
        const ctx = getCtx();
        if (ctx && typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
            const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.CONFIRM, '', {
                okButton: '确定',
                cancelButton: '取消',
            });
            return Boolean(result); // AFFIRMATIVE=1 → true；取消 / 关闭 → null|0 → false
        }
    } catch (e) {
        console.warn('[Story Oracle] uiConfirm 弹窗失败，回退原生 confirm：', e);
    }
    return typeof confirm === 'function' ? confirm(message) : true;
}

// 统一文本输入弹窗（同 uiConfirm 风格）：优先 ST 主题化 INPUT 弹窗，不可用时回退原生 prompt。
// 返回 Promise<string|null>：取消 / 关闭 → null（ST 取消回 false，统一收敛成 null）。套餐「保存为…」起名用。
async function uiPrompt(message, defaultValue = '') {
    try {
        const ctx = getCtx();
        if (ctx && typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
            const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.INPUT, defaultValue, {
                okButton: '确定',
                cancelButton: '取消',
            });
            // INPUT：确定回输入字符串（可能空串）；取消 / 关闭回 false / null。
            return (result === false || result == null) ? null : String(result);
        }
    } catch (e) {
        console.warn('[Story Oracle] uiPrompt 弹窗失败，回退原生 prompt：', e);
    }
    return typeof prompt === 'function' ? prompt(message, defaultValue) : null;
}

function getSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[MODULE] || typeof ctx.extensionSettings[MODULE] !== 'object') {
        ctx.extensionSettings[MODULE] = {};
    }
    const s = ctx.extensionSettings[MODULE];
    // 一次性迁移（须在填默认值之前——否则下面的默认填充会先把分家键设成 false，迁移就判不出旧值）：
    // 旧版单个全局 fixUsePreset（手动 + 自动共用）→ 手动/自动分家的 fixM_/fixA_usePreset；删旧键，幂等。
    if (s.fixUsePreset !== undefined) {
        if (s.fixM_usePreset === undefined) s.fixM_usePreset = s.fixUsePreset;
        if (s.fixA_usePreset === undefined) s.fixA_usePreset = s.fixUsePreset;
        delete s.fixUsePreset;
    }
    // Fill in any missing defaults IN PLACE so the reference stays stable.
    // (Rebuilding the object here would orphan the values written by event handlers.)
    for (const [k, v] of Object.entries(defaults)) {
        if (!(k in s)) s[k] = v;
    }
    // 一次性迁移：旧版单选 lorebookTarget（标量）→ 新版多选 lorebookTargets（数组）。
    // 迁移后清空标量，使本块幂等、不会在用户清空多选（= 全部激活）后又被旧值重新种回。
    if (typeof s.lorebookTarget === 'string' && s.lorebookTarget &&
        (!Array.isArray(s.lorebookTargets) || s.lorebookTargets.length === 0)) {
        s.lorebookTargets = [s.lorebookTarget];
        s.lorebookTarget = '';
    }
    return s;
}

function save() {
    getCtx().saveSettingsDebounced();
}

function init() {
    getSettings();
    injectWandButton();
    buildWindow();
    syncChatBarButton();   // 用户功能请求：按设置在聊天栏放 / 撤快捷按钮
    loadRegexEngine(); // warm the cache so it's ready by first send

    // Advisor plan lifecycle: re-register (or clear) the injection whenever a
    // chat loads, and run the staleness check as the main chat grows. These are
    // the extension's only event listeners — everything else stays pull-based.
    try {
        const ctx = getCtx();
        const et = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && typeof ctx.eventSource.on === 'function') {
            ctx.eventSource.on(et.CHAT_CHANGED || 'chat_id_changed', onChatChanged);
            ctx.eventSource.on(et.MESSAGE_RECEIVED || 'message_received', checkPlanReminder);
            // 回复后编排：每条新 AI 回复在共享锁下先自动校正、后自动诊断（各自仅在其自动模式开启时动作）。
            // 必须「即发即忘」：ST 的 eventSource.emit 会 await 监听器，直接挂上 async 的
            // maybePostReply 会让每条回复都卡住整个校正 + 诊断往返。包一层、不把 promise 交回去。
            ctx.eventSource.on(et.MESSAGE_RECEIVED || 'message_received', (id) => {
                Promise.resolve(maybePostReply(id)).catch((e) => console.warn('[Story Oracle] 回复后编排调度失败：', e));
            });
        }
    } catch (e) {
        console.warn('[Story Oracle] event wiring failed (plan injection will only refresh on reload):', e);
    }
    // Cover the chat that may already be loaded by the time the extension inits.
    onChatChanged();
}

/**
 * Lazily import SillyTavern's regex engine from its served path. The absolute
 * URL resolves against ST's web root, so it works whether this extension lives
 * in the data dir or in third-party. Returns the module, or false if unavailable.
 */
async function loadRegexEngine() {
    if (regexEngine !== null) return regexEngine;
    try {
        const mod = await import('/scripts/extensions/regex/engine.js');
        regexEngine = (mod && mod.getRegexedString && mod.regex_placement) ? mod : false;
        if (!regexEngine) console.warn('[Story Oracle] regex engine loaded but missing exports; sending raw text.');
    } catch (e) {
        console.warn('[Story Oracle] Could not load regex engine; sending raw messages.', e);
        regexEngine = false;
    }
    return regexEngine;
}

async function loadWorldInfoModule() {
    if (worldInfoModule !== null) return worldInfoModule;
    try {
        const mod = await import('/scripts/world-info.js');
        worldInfoModule = (mod && mod.getSortedEntries) ? mod : false;
    } catch (e) {
        console.warn('[Story Oracle] Could not load world-info module.', e);
        worldInfoModule = false;
    }
    return worldInfoModule;
}

let scriptCore = null; // '/script.js' module, lazily imported (false = unavailable)
async function loadScriptCore() {
    if (scriptCore !== null) return scriptCore;
    try {
        scriptCore = await import('/script.js');
    } catch (e) {
        console.warn('[Story Oracle] Could not load /script.js for context size.', e);
        scriptCore = false;
    }
    return scriptCore;
}

/*
 * The token budget the ST world-info scan gets to spend. Inside checkWorldInfo
 * the budget is `世界信息 Context% × maxContext` (capped by the budget cap), and
 * once it overflows ST silently drops every remaining entry in order-descending
 * priority — CONSTANT (blue) ENTRIES INCLUDED.
 *
 * getContext().maxContext is the *text-completion* context slider. For
 * chat-completion users (the normal case) that's a stale default (2048+) with
 * no relation to the real context size, so passing it collapses the budget and
 * the scan sheds low-order entries that the main chat keeps. Main generation
 * derives its scan budget from getMaxPromptTokens(), so we mirror that, and
 * fall back to "effectively unlimited" rather than risk starving the Oracle's
 * view of the books.
 */
async function getWiScanBudget() {
    const ctx = getCtx();
    const sc = await loadScriptCore();
    const candidates = [
        () => (sc && typeof sc.getMaxPromptTokens === 'function') ? sc.getMaxPromptTokens() : 0,
        () => (sc && typeof sc.getMaxContextTokens === 'function') ? sc.getMaxContextTokens() : 0,
        () => (typeof ctx.getMaxContextSize === 'function') ? ctx.getMaxContextSize() : 0,
    ];
    for (const get of candidates) {
        try {
            const v = Number(get());
            if (v > 0) return v;
        } catch (e) { /* try the next source */ }
    }
    return 1048576;
}

/**
 * Build the world-info / lorebook block for the system prompt.
 *   'st'  -> faithful ST scan: constant (blue) entries always, keyword (green)
 *            entries only when their keys match the chat/card. Uses a dry run so
 *            it never disturbs the main chat's sticky/cooldown state.
 *   'all' -> every non-disabled entry from the active books, regardless of keys.
 * extraScanText (optional, 'st' mode only): extra text folded into the scan so
 * keyword (green) entries whose keys appear in it activate even when recent chat
 * never mentioned them — used by the arc calls to surface lore about the arc's
 * own subject (throughline / waypoints / direction; see arcScanText).
 */
// 把 worldInfoMode 设置映射成 buildWorldInfo() 的模式，供「要带世界书」的调用点用（'off' 由调用方门控）。
// 'char' = 仅角色 / 对话相关世界书（排除全局 + 人设）。
function wiContextMode(s) {
    const m = s.worldInfoMode;
    return m === 'all' ? 'all' : (m === 'char' ? 'char' : 'st');
}
async function buildWorldInfo(forceMode, extraScanText) {
    const ctx = getCtx();
    const s = getSettings();
    const mode = forceMode || s.worldInfoMode;
    if (mode === 'off') return '';

    try {
        if (mode === 'all') {
            const mod = await loadWorldInfoModule();
            if (!mod || !mod.getSortedEntries) return '';
            const entries = await mod.getSortedEntries();
            const allBlock = (entries || [])
                .filter((e) => e && !e.disable && typeof e.content === 'string' && e.content.trim())
                .map((e) => e.content.trim())
                .join('\n\n');
            // Mechanism rules are Diagnose-only; see stripMvuRuleContents.
            return await stripMvuRuleContents(allBlock);
        }

        if (mode === 'char') {
            // 仅角色 / 对话相关世界书：跑 ST 的真实扫描拿到【当前被激活】的条目（蓝灯 + 命中绿灯），
            // 再按书名筛到角色 + 对话书集合（全局 / 人设书不在集合里 → 自然排除）。关键词匹配仍由 ST 决定。
            const mod = await getWiEditApi();
            const bookSet = new Set(await getCharChatBookNames());
            if (!mod || !bookSet.size) return '';
            const active = await getActiveScanUids();   // { 书名: Set<uid> }
            const blocks = [];
            for (const name of Object.keys(active)) {
                if (!bookSet.has(name)) continue;
                let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
                const entries = Object.values((data && data.entries) || {})
                    .filter((e) => e && active[name].has(Number(e.uid)) && !e.disable && typeof e.content === 'string' && e.content.trim())
                    .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
                if (entries.length) blocks.push(entries.map((e) => e.content.trim()).join('\n\n'));
            }
            return await stripMvuRuleContents(blocks.join('\n\n').trim());
        }

        // 'st' mode — replicate ST's scan input.
        if (typeof ctx.getWorldInfoPrompt !== 'function') return '';
        const coreChat = (ctx.chat || []).filter((m) => m && !m.is_system && typeof m.mes === 'string');
        const chatForWI = coreChat
            .map((m) => `${m.name || (m.is_user ? ctx.name1 : ctx.name2)}: ${m.mes}`)
            .reverse(); // most-recent first, as ST does

        // 把调用方传入的【额外扫描文本】（弧线自身的贯穿线 / 路标 / 方向）并进最近一条消息所在的
        // 扫描格——它深度无关地一定被扫到，既不挤占 world_info_depth 窗口里的真实消息，又能让以这些
        // 词为关键词的绿条即便最近聊天没提到也照常激活（见 arcScanText）。仅 'st' 扫描有意义。
        if (extraScanText && String(extraScanText).trim()) {
            const inj = String(extraScanText).trim();
            if (chatForWI.length) chatForWI[0] = inj + '\n' + chatForWI[0];
            else chatForWI.push(inj);
        }

        let card = {};
        try { card = ctx.getCharacterCardFields() || {}; } catch (e) { /* group/no char */ }
        const globalScanData = {
            personaDescription: card.persona,
            characterDescription: card.description,
            characterPersonality: card.personality,
            characterDepthPrompt: card.charDepthPrompt,
            scenario: card.scenario,
            creatorNotes: card.creatorNotes,
            trigger: 'normal',
        };

        const budget = await getWiScanBudget();
        const res = await ctx.getWorldInfoPrompt(chatForWI, budget, /*isDryRun*/ true, globalScanData);

        // getWorldInfoPrompt buckets the activated entries by insertion position.
        // worldInfoString only holds Before/After Char Defs (positions 0/1), so
        // drain every bucket — otherwise @D, Author's Note, example-message and
        // outlet entries (including *constant* ones) get silently dropped.
        // The `|| []` / `|| {}` guards keep this safe on older ST builds that
        // don't return the newer fields (anBefore/anAfter/outletEntries).
        const parts = [];
        const push = (v) => { if (typeof v === 'string' && v.trim()) parts.push(v.trim()); };

        push(res?.worldInfoBefore);                                    // 0  Before Char Defs
        push(res?.worldInfoAfter);                                     // 1  After Char Defs
        for (const s of (res?.anBefore || [])) push(s);                // 2  Top of AN
        for (const s of (res?.anAfter  || [])) push(s);                // 3  Bottom of AN
        for (const d of (res?.worldInfoDepth || [])) (d?.entries || []).forEach(push); // 4  @D
        for (const e of (res?.worldInfoExamples || [])) push(typeof e === 'string' ? e : e?.content); // 5/6 Example Messages
        for (const arr of Object.values(res?.outletEntries || {})) (arr || []).forEach(push);          // 7  Outlet

        // Mechanism rules are Diagnose-only; see stripMvuRuleContents.
        return await stripMvuRuleContents(parts.join('\n\n').trim());
    } catch (e) {
        console.warn('[Story Oracle] World info build failed:', e);
        return '';
    }
}

/**
 * Like buildWorldInfo, but split by insertion position for the faithful marker
 * fill: { before, after }. 'before' = Before-Char-Defs entries; 'after' =
 * After-Char-Defs plus every other bucket (AN, @D, examples, outlet) so nothing
 * is lost. 'all' mode dumps everything into 'before'; 'off' yields empties.
 */
async function buildWorldInfoSplit(forceMode) {
    const ctx = getCtx();
    const s = getSettings();
    const mode = forceMode || s.worldInfoMode;
    if (mode === 'off') return { before: '', after: '' };

    if (mode === 'all') {
        return { before: await buildWorldInfo('all'), after: '' };
    }

    if (mode === 'char') {
        return { before: await buildWorldInfo('char'), after: '' };
    }

    try {
        if (typeof ctx.getWorldInfoPrompt !== 'function') return { before: '', after: '' };
        const coreChat = (ctx.chat || []).filter((m) => m && !m.is_system && typeof m.mes === 'string');
        const chatForWI = coreChat
            .map((m) => `${m.name || (m.is_user ? ctx.name1 : ctx.name2)}: ${m.mes}`)
            .reverse();

        let card = {};
        try { card = ctx.getCharacterCardFields() || {}; } catch (e) { /* group / none */ }
        const globalScanData = {
            personaDescription: card.persona,
            characterDescription: card.description,
            characterPersonality: card.personality,
            characterDepthPrompt: card.charDepthPrompt,
            scenario: card.scenario,
            creatorNotes: card.creatorNotes,
            trigger: 'normal',
        };

        const budget = await getWiScanBudget();
        const res = await ctx.getWorldInfoPrompt(chatForWI, budget, /*isDryRun*/ true, globalScanData);

        const beforeParts = [];
        const afterParts = [];
        const push = (arr, v) => { if (typeof v === 'string' && v.trim()) arr.push(v.trim()); };

        push(beforeParts, res?.worldInfoBefore);
        push(afterParts, res?.worldInfoAfter);
        for (const x of (res?.anBefore || [])) push(afterParts, x);
        for (const x of (res?.anAfter || [])) push(afterParts, x);
        for (const d of (res?.worldInfoDepth || [])) (d?.entries || []).forEach((e) => push(afterParts, e));
        for (const e of (res?.worldInfoExamples || [])) push(afterParts, typeof e === 'string' ? e : e?.content);
        for (const arr of Object.values(res?.outletEntries || {})) (arr || []).forEach((e) => push(afterParts, e));

        // Mechanism rules are Diagnose-only; see stripMvuRuleContents.
        return {
            before: await stripMvuRuleContents(beforeParts.join('\n\n').trim()),
            after: await stripMvuRuleContents(afterParts.join('\n\n').trim()),
        };
    } catch (e) {
        console.warn('[Story Oracle] World info split failed:', e);
        return { before: '', after: '' };
    }
}

/*
 * [mvu_update] rule entries — the card's variable-update mechanism rules
 * (update rules / output format contracts). Matching mirrors MVU's own
 * UPDATE_REGEX exactly: /[mvu_update]/i on the comment. Constant-only and
 * enabled-only.
 *
 * These entries are read straight from the stored world books via
 * loadWorldInfo(), bypassing the live WI scan, because MagVarUpdate in
 * "extra-model-parsing" update mode strips them from the lore arrays on the
 * `worldinfo_entries_loaded` event — which fires inside getSortedEntries,
 * upstream of BOTH getWorldInfoPrompt ('st') and getSortedEntries ('all').
 * On cards where MVU is NOT in that mode, the entries flow through the scan
 * untouched. The raw books see them either way.
 *
 * Policy: only Diagnose mode wants these mechanism rules (it audits variable
 * updates against them). Chat / advisor / preset prompts should NOT carry
 * them — they're noise there, and worse, the output-format contract is what
 * coaxes models into emitting <UpdateVariable> blocks in oracle replies (the
 * leakage stripMechanismBlocks exists to clean up). So buildWorldInfo /
 * buildWorldInfoSplit strip them from every block, and Diagnose re-injects
 * them via collectMvuUpdateRules. Untagged variable entries (e.g. threshold
 * explanations) are not touched.
 */
const MVU_UPDATE_TAG = /\[mvu_update\]/i;

// Enumerate every enabled, constant [mvu_update] entry from the raw active
// books. Returns substituted content strings, deduped, sorted by entry order.
async function collectMvuRuleContents() {
    const ctx = getCtx();
    const mod = await loadWorldInfoModule();
    if (!mod || typeof mod.getSortedEntries !== 'function' || typeof mod.loadWorldInfo !== 'function') {
        return [];
    }

    // Discover active book names. The entries themselves may have been stripped
    // by MVU, but the books still surface via their surviving (untagged) entries.
    let names = [];
    try {
        const sorted = await mod.getSortedEntries();
        names = [...new Set((sorted || []).map((e) => e && e.world).filter(Boolean))];
    } catch (e) {
        console.warn('[Story Oracle] Could not enumerate world books for MVU rules:', e);
        return [];
    }

    const collected = [];
    for (const name of names) {
        let book;
        try { book = await mod.loadWorldInfo(name); } catch (e) { continue; }
        const entries = book && book.entries ? Object.values(book.entries) : [];
        for (const e of entries) {
            if (!e || e.constant !== true || e.disable) continue;
            if (!MVU_UPDATE_TAG.test(e.comment || '')) continue;
            let content = typeof e.content === 'string' ? e.content : '';
            try { content = ctx.substituteParams(content); } catch (_) { /* leave raw */ }
            content = content.trim();
            if (!content) continue;
            if (collected.some((c) => c.content === content)) continue; // dupe across books
            collected.push({ order: Number(e.order) || 0, content });
        }
    }

    collected.sort((a, b) => a.order - b.order);
    return collected.map((c) => c.content);
}

// Diagnose-mode recovery: the [mvu_update] rules that are NOT already in the
// built block (buildWorldInfo strips them by design; MVU may also have hidden
// them from the scan). Diagnose appends these so its audit always has the
// authoritative path/type/check rules.
async function collectMvuUpdateRules(existingBlock) {
    const seen = existingBlock || '';
    const contents = await collectMvuRuleContents();
    return contents.filter((c) => !seen.includes(c));
}

// Remove [mvu_update] mechanism-rule content from a built world-info block.
// The scan returns joined strings (not entries), so removal is content-based:
// the same substituted content the scan would have inserted is matched and
// cut out, then leftover blank lines are collapsed. No-op on cards without
// [mvu_update] entries.
async function stripMvuRuleContents(text) {
    if (!text || typeof text !== 'string') return text || '';
    let contents;
    try { contents = await collectMvuRuleContents(); } catch (e) { return text; }
    if (!contents.length) return text;
    let out = text;
    for (const c of contents) {
        if (!c || !out.includes(c)) continue;
        out = out.split(c).join('');
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ *
 * 诊断模式「精选世界书条目」喂料（用户功能请求；总开关 ENABLE_DIAG_WI_PICKER）。
 * 与世界书扫描（buildWorldInfo）分开：精选直接从【原始世界书】按本聊天保存的 uid 选择取条目，
 * 无视 ST 的启用 / 禁用状态——这正是要点（被禁用的变量规则条目也能喂给诊断）。
 * ------------------------------------------------------------------ */
// 诊断「精选条目」当前是否生效：总开关开 + 本聊天 L1（use）已勾选。两处喂料点用它决定走精选还是原行为。
function diagPickerActive() {
    return ENABLE_DIAG_WI_PICKER && getDiagWiMeta().use;
}

// 跑一次 ST 的 dry-run 世界书扫描（与 buildWorldInfo('st') 同输入），取当前【真正被激活】的条目，
// 整理成 { 书名: Set<uid> }。用于诊断精选的两处：首开快照（蓝灯 + 当前命中绿灯）与混合模式（并入当前命中绿灯）。
// 失败 / 老版本 ST 无 allActivatedEntries 时回 {}（调用方自然退化）。
async function getActiveScanUids() {
    const ctx = getCtx();
    try {
        if (typeof ctx.getWorldInfoPrompt !== 'function') return {};
        const coreChat = (ctx.chat || []).filter((m) => m && !m.is_system && typeof m.mes === 'string');
        const chatForWI = coreChat
            .map((m) => `${m.name || (m.is_user ? ctx.name1 : ctx.name2)}: ${m.mes}`)
            .reverse();
        let card = {};
        try { card = ctx.getCharacterCardFields() || {}; } catch (e) { /* group / none */ }
        const globalScanData = {
            personaDescription: card.persona,
            characterDescription: card.description,
            characterPersonality: card.personality,
            characterDepthPrompt: card.charDepthPrompt,
            scenario: card.scenario,
            creatorNotes: card.creatorNotes,
            trigger: 'normal',
        };
        const budget = await getWiScanBudget();
        const res = await ctx.getWorldInfoPrompt(chatForWI, budget, /*isDryRun*/ true, globalScanData);
        return activeUidsFromScan(res && res.allActivatedEntries);
    } catch (e) {
        console.warn('[Story Oracle] Active WI scan failed:', e);
        return {};
    }
}

// 诊断精选喂料。选择从【元数据】读（无状态——自动诊断窗口关着也对），按选中 uid 从原始书取条目，逐条
// substituteParams（诊断只读不编辑，故可展开宏，与 collectMvuRuleContents 一致）。混合模式（L2）再并入主聊天
// 当前命中的【绿灯】（蓝灯不并——要么已选、要么用户有意不选）。返回 { block, selectedEntries }：block 拼进
// 诊断的 worldInfoBlock，selectedEntries 供 diagSelHasRules 判断是否含变量规则条目。无选择 / 无法访问模块时回空。
async function buildDiagSelectedWi() {
    const ctx = getCtx();
    const meta = getDiagWiMeta();
    const mod = await getWiEditApi();
    if (!mod) return { block: '', selectedEntries: [] };

    // 选择映射（书名 -> Set<uid>），只留非空选择。
    let selMap = {};
    for (const [b, s] of Object.entries(deserializeDiagSel(meta.sel))) if (s.size) selMap[b] = s;

    // 混合模式：把主聊天当前命中的绿灯 uid 并进选择。
    if (meta.hybrid) {
        try {
            const active = await getActiveScanUids();           // { 书名: Set<uid> }（含蓝 + 绿）
            const greens = {};
            for (const name of Object.keys(active)) {
                let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
                const all = data && data.entries ? Object.values(data.entries) : [];
                const g = new Set();
                for (const e of all) {
                    if (e && active[name].has(Number(e.uid)) && e.constant !== true) g.add(Number(e.uid)); // 仅绿灯
                }
                if (g.size) greens[name] = g;
            }
            selMap = mergeHybridUids(selMap, greens);
        } catch (e) { /* 混合失败就只用精选 */ }
    }

    const books = Object.keys(selMap);
    if (!books.length) return { block: '', selectedEntries: [] };

    const subst = (v) => { try { return ctx.substituteParams(String(v == null ? '' : v)); } catch (_) { return String(v == null ? '' : v); } };
    const blocks = [];
    const selectedEntries = [];
    for (const name of books) {
        let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
        if (!data || !data.entries) continue;
        const want = selMap[name];
        const entries = Object.values(data.entries)
            .filter((e) => e && want.has(Number(e.uid)) && typeof e.content === 'string' && e.content.trim())
            .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
        if (!entries.length) continue;
        for (const e of entries) selectedEntries.push(e);
        const body = entries.map((e) => subst(e.content).trim()).join('\n\n');
        blocks.push(`=== 世界书：${name}（精选 ${entries.length} 条）===\n${body}`);
    }
    return { block: blocks.join('\n\n'), selectedEntries };
}

/* ------------------------------------------------------------------ *
 * Lorebook mode — read & edit world books.
 *
 * Reuses the same world-info.js module loaded for the 'all'/'st' scans, but
 * needs its editing exports too (loadWorldInfo / saveWorldInfo / create+delete
 * entry / reloadEditor / world_names). Returns the module only when those are
 * present, so a stripped-down ST build degrades gracefully instead of throwing.
 * ------------------------------------------------------------------ */
async function getWiEditApi() {
    const mod = await loadWorldInfoModule();
    if (mod && typeof mod.loadWorldInfo === 'function' && typeof mod.saveWorldInfo === 'function') {
        return mod;
    }
    return null;
}

// Names of every book that's currently active for this character/chat/global.
async function getActiveBookNames() {
    const mod = await loadWorldInfoModule();
    if (!mod || typeof mod.getSortedEntries !== 'function') return [];
    try {
        const sorted = await mod.getSortedEntries();
        return [...new Set((sorted || []).map((e) => e && e.world).filter(Boolean))];
    } catch (e) {
        console.warn('[Story Oracle] Could not enumerate active world books:', e);
        return [];
    }
}

// All known world-book names (every file, active or not).
async function getAllBookNames() {
    const mod = await loadWorldInfoModule();
    const names = mod && Array.isArray(mod.world_names) ? mod.world_names : [];
    return [...names].filter(Boolean);
}

// 「角色 + 对话相关」书名（纯）：卡内嵌 ∪ charLore 绑定 ∪ 对话绑定，再 ∩ 现存书；去重、保序。
// 全局多选 / 人设书靠调用方根本不传进来而排除。
function pickCharChatBooks(cardWorld, charLoreExtra, chatWorldNames, allBookNames) {
    const all = new Set(allBookNames || []);
    const out = [];
    const seen = new Set();
    const add = (n) => { if (n && all.has(n) && !seen.has(n)) { seen.add(n); out.push(n); } };
    add(cardWorld);
    (Array.isArray(charLoreExtra) ? charLoreExtra : []).forEach(add);
    (Array.isArray(chatWorldNames) ? chatWorldNames : []).forEach(add);
    return out;
}

// 从 ST 收集原始来源、归一化，交给纯选择器。组聊 / 无角色 / 老版本 ST 时各来源自然退化为空。
async function getCharChatBookNames() {
    const ctx = getCtx();
    const mod = await loadWorldInfoModule();
    let cardWorld = null;
    const charLoreExtra = [];
    const chatWorldNames = [];
    try {
        const chid = ctx.characterId;
        const ch = (ctx.characters || [])[chid];
        cardWorld = (ch && ch.data && ch.data.extensions && ch.data.extensions.world) || null;
        const charLore = mod && mod.world_info ? mod.world_info.charLore : null;
        if (Array.isArray(charLore) && ch) {
            const fname = typeof ctx.getCharaFilename === 'function'
                ? ctx.getCharaFilename(chid)
                : (ch.avatar ? String(ch.avatar).replace(/\.[^.]+$/, '') : null);
            const rec = fname ? charLore.find((e) => e && e.name === fname) : null;
            if (rec && Array.isArray(rec.extraBooks)) rec.extraBooks.forEach((b) => b && charLoreExtra.push(b));
        }
    } catch (e) { /* group chat / no character */ }
    try {
        const cw = (ctx.chatMetadata || {}).world_info;
        if (typeof cw === 'string') chatWorldNames.push(cw);
        else if (Array.isArray(cw)) cw.forEach((b) => b && chatWorldNames.push(b));
        else if (cw && typeof cw === 'object') {
            if (cw.primary) chatWorldNames.push(cw.primary);
            if (Array.isArray(cw.additional)) cw.additional.forEach((b) => b && chatWorldNames.push(b));
        }
    } catch (e) { /* no chat-bound book */ }
    const all = await getAllBookNames();
    return pickCharChatBooks(cardWorld, charLoreExtra, chatWorldNames, all);
}

// 世界书多选：把「选中集合」解析成实际操作的书名列表。空 = 跟随当前激活（动态）；
// 否则取选中里仍存在于磁盘的那些（去重、保序）。纯函数，便于单测。
function resolveLbTargetNames(targets, allBookNames, activeBookNames) {
    if (!Array.isArray(targets) || targets.length === 0) return (activeBookNames || []).slice();
    const all = new Set(allBookNames || []);
    const out = [];
    const seen = new Set();
    for (const n of targets) {
        if (n && all.has(n) && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
}

const LB_POSITION_LABEL = {
    0: '角色定义之前',
    1: '角色定义之后',
    2: '作者注释之上',
    3: '作者注释之下',
    4: '@D（按深度插入）',
    5: '示例对话之前',
    6: '示例对话之后',
};

function lbEntryType(e) {
    if (e.disable) return '已禁用';
    if (e.constant) return '常驻（蓝灯）';
    return '关键词触发（绿灯）';
}

function lbFormatEntry(e) {
    const uid = e.uid;
    const title = (e.comment && e.comment.trim()) ? e.comment.trim() : '（无标题）';
    const keys = Array.isArray(e.key) ? e.key.filter(Boolean).join(', ') : '';
    const keys2 = Array.isArray(e.keysecondary) ? e.keysecondary.filter(Boolean).join(', ') : '';
    const pos = LB_POSITION_LABEL[Number(e.position)] || String(e.position ?? '');
    const lines = [];
    lines.push(`【条目 uid=${uid}】${title}`);
    lines.push(`- 类型：${lbEntryType(e)}`);
    if (keys) lines.push(`- 关键词(key)：${keys}`);
    if (keys2) lines.push(`- 次要关键词(keysecondary)：${keys2}`);
    lines.push(`- 位置(position)：${pos} ｜ 顺序(order)：${e.order ?? 100}` + (Number(e.position) === 4 ? ` ｜ 深度(depth)：${e.depth ?? ''}` : ''));
    const content = typeof e.content === 'string' ? e.content : '';
    lines.push(`- 内容(content)：\n${content.trim() || '（空）'}`);
    return lines.join('\n');
}

/**
 * Build the structured "book -> entries" listing for lorebook mode, and record
 * which books it covers (lbBookNames). Honors s.lorebookTarget: a specific book
 * name, or '' for every active book. Stores nothing by reference — apply re-reads
 * the books fresh — so this is purely a read for context.
 */
async function buildLorebookContext() {
    lbContextText = '';
    lbBookNames = [];
    const s = getSettings();
    const mod = await getWiEditApi();
    if (!mod) {
        lbContextText = '（无法访问世界书模块 —— 当前 ST 版本可能不支持。）';
        return;
    }

    const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
    const names = resolveLbTargetNames(s.lorebookTargets, allNames, activeNames);
    if (!names.length) {
        lbContextText = (Array.isArray(s.lorebookTargets) && s.lorebookTargets.length)
            ? '（选中的世界书都找不到了。请在上方重新勾选，或点刷新。）'
            : '（当前没有激活任何世界书。可在上方勾选某一本来编辑。）';
        return;
    }

    const ctx = getCtx();
    const blocks = [];
    for (const name of names) {
        let data;
        try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
        if (!data || !data.entries) continue;
        lbBookNames.push(name);
        let entries = Object.values(data.entries)
            .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
        const total = entries.length;
        // Per-entry selection works in BOTH single-book and all-active mode — the
        // filter is keyed by book name either way. A Set (even empty) means "send
        // exactly these"; null/absent means "send all". Apply still re-reads the
        // whole book, so editing any uid keeps working.
        const sel = lbEntryFilter[name];
        const filtered = (sel instanceof Set);
        if (filtered) entries = entries.filter((e) => sel.has(e.uid));
        const body = entries.length
            ? entries.map(lbFormatEntry).join('\n\n')
            : (filtered ? '（未选择任何条目——请在上方勾选要发送给我的条目。）' : '（此世界书暂无条目。）');
        const head = filtered
            ? `=== 世界书：${name}（已选 ${entries.length} / 共 ${total} 条）===`
            : `=== 世界书：${name}（共 ${total} 条）===`;
        blocks.push(`${head}\n${body}`);
    }

    lbContextText = blocks.join('\n\n') || '（未能读取到任何世界书条目。）';
    // Show entry content VERBATIM — do NOT substituteParams it. The lore manager EDITS
    // these books, and macros ({{user}}/{{char}} …) are stored literally. The old
    // behavior expanded them "for readability", so the model anchored on the persona /
    // char NAME (e.g. "Chris") while storage still held "{{user}}" → patch 锚点未找到 on
    // apply (lbFuzzyReplace matches the literal content loadWorldInfo returns), and it
    // risked baking the name into the book. Instead, keep it literal and prepend a small
    // legend giving the macro values, so chat stays readable without touching content.
    if (lbContextText.indexOf('{{') !== -1) {
        const pairs = [];
        try {
            const u = ctx.substituteParams('{{user}}');
            const c = ctx.substituteParams('{{char}}');
            if (u && u !== '{{user}}') pairs.push(`{{user}} = 「${u}」`);
            if (c && c !== '{{char}}') pairs.push(`{{char}} = 「${c}」`);
        } catch (e) { /* no ctx — skip the name mapping, keep the literal-macro note */ }
        const names = pairs.length ? `当前 ${pairs.join('、')}。` : '';
        lbContextText = '（说明：下列条目正文按【原样】显示，含 {{user}}、{{char}} 等宏，未做替换。' + names +
            '聊天作答可用真名以便阅读；但【编辑】时，anchor 锚点与 replace / content 正文都必须照抄字面的 ' +
            '{{user}} / {{char}} 等宏，不要替换成真名——否则锚点对不上当前存储，还会把名字写死进世界书。）\n\n' +
            lbContextText;
    }
}

// Convert a fenced body the model wrote with literal "\n" (out of JSON habit)
// back into real line breaks. Only fires when there are NO real newlines yet, so
// legitimately single-line content is untouched.
function lbBackstopNewlines(s) {
    if (typeof s !== 'string') return s;
    if (s.indexOf('\n') === -1 && /\\n/.test(s)) {
        return s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
    return s;
}

// Pull one fenced body out of a block: <<<name … name>>> (markers at line start).
// Returns { body, rest }: body is the inner text with exactly one boundary newline
// trimmed each side (internal indentation preserved), or null if absent; rest is
// the block with that fence removed so header parsing won't see it.
function extractFence(text, name) {
    const re = new RegExp('(^|\\n)[ \\t]*<<<' + name + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*' + name + '>>>[ \\t]*(?=\\n|$)');
    const m = text.match(re);
    if (!m) return { body: null, rest: text };
    const rest = text.slice(0, m.index) + '\n' + text.slice(m.index + m[0].length);
    return { body: m[2], rest };
}

const lbToBool = (v) => (v === true) || /^(true|1|yes|on|是|开|启用|常驻)$/i.test(String(v == null ? '' : v).trim());
const lbToStrArray = (v) => (Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter(Boolean)
    : String(v == null ? '' : v).split(/[,，、]/).map((x) => x.trim()).filter(Boolean));

// Whitelist of editable fields and their coercions. Values arrive as strings (from
// "key: value" header lines), so coercions are string-aware — a stray field the
// model invents can never write garbage into a book.
const LB_FIELD_COERCE = {
    content: (v) => String(v == null ? '' : v),
    comment: (v) => String(v == null ? '' : v),
    key: lbToStrArray,
    keysecondary: lbToStrArray,
    constant: lbToBool,
    disable: lbToBool,
    selective: lbToBool,
    excludeRecursion: lbToBool,
    preventRecursion: lbToBool,
    order: (v) => Number(String(v).trim()),
    position: (v) => Number(String(v).trim()),
    depth: (v) => Number(String(v).trim()),
};

const LB_SCALAR_KEYS = ['comment', 'key', 'keysecondary', 'constant', 'disable', 'selective', 'excludeRecursion', 'preventRecursion', 'order', 'position', 'depth'];

function applyFieldsToEntry(entry, fields) {
    if (!fields || typeof fields !== 'object') return;
    for (const [k, raw] of Object.entries(fields)) {
        if (!(k in LB_FIELD_COERCE)) continue;            // ignore unknown fields
        const val = LB_FIELD_COERCE[k](raw);
        if ((k === 'order' || k === 'position' || k === 'depth') && Number.isNaN(val)) continue;
        entry[k] = val;
    }
}

// Parse ONE <LorebookEdit> block's inner text into an op, or an error.
// Returns { op } or { error }.
function parseOneLorebookBlock(inner) {
    let text = String(inner || '');
    const cFence = extractFence(text, 'content'); text = cFence.rest;
    const rFence = extractFence(text, 'replace'); text = rFence.rest;

    const headers = {};
    // 多行 anchor：弱模型常把跨行的一段原文【整段照抄】进 anchor（而不用 start || end）。
    // 把 anchor: 之后紧跟的续行（直到空行或下一个 header）并入 anchor，好让 lbFuzzyReplace
    // 拿到完整片段、整段命中，而不是只取首行（首行只换一半 = 静默的部分替换）。
    // 【仅限 anchor】：真正的「键: 值」header 行会终止吸收（绝不吞掉任何字段），其它字段后面
    // 的自由文本仍按原样丢弃。
    let absorb = null;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        const mm = line.match(/^([A-Za-z_]+)\s*[:：]\s*(.*)$/);
        if (mm) { headers[mm[1]] = mm[2]; absorb = (mm[1] === 'anchor') ? 'anchor' : null; continue; }
        if (!line) { absorb = null; continue; }
        if (absorb) headers[absorb] += '\n' + line;
    }

    const action = (headers.action || '').trim().toLowerCase();
    const uidRaw = headers.uid != null ? String(headers.uid).trim() : '';
    const op = {
        action,
        book: (headers.book || '').trim(),
        uid: uidRaw !== '' ? parseInt(uidRaw, 10) : null,
        anchor: headers.anchor != null ? String(headers.anchor) : '',
        replace: rFence.body != null ? lbBackstopNewlines(rFence.body) : null,
        fields: {},
    };
    for (const k of LB_SCALAR_KEYS) {
        if (headers[k] != null && String(headers[k]).trim() !== '') op.fields[k] = headers[k];
    }
    if (cFence.body != null) op.fields.content = lbBackstopNewlines(cFence.body);

    const ALLOWED = ['create', 'edit', 'patch', 'delete', 'prepend', 'append'];
    if (!ALLOWED.includes(action)) return { error: `未知或缺失的 action：「${(headers.action || '').trim()}」` };
    // book is resolved at apply time (against the books actually in scope), so a
    // mangled or omitted name no longer hard-fails here.
    if (action === 'create') {
        if (op.fields.content == null || !String(op.fields.content).trim()) return { error: 'create 缺少 content 正文' };
    } else if (op.uid == null || Number.isNaN(op.uid)) {
        return { error: `${action} 缺少有效的 uid` };
    }
    if (action === 'prepend' || action === 'append') {
        if (op.fields.content == null || !String(op.fields.content).trim()) return { error: `${action} 缺少要插入的 content 正文` };
    }
    if (action === 'edit') {
        const hasContent = op.fields.content != null;
        const hasScalar = LB_SCALAR_KEYS.some((k) => k in op.fields);
        if (!hasContent && !hasScalar) return { error: 'edit 没有任何要修改的字段' };
    }
    if (action === 'patch') {
        if (!op.anchor || !op.anchor.trim()) return { error: 'patch 缺少 anchor 锚点' };
        if (op.replace == null) return { error: 'patch 缺少 replace 区块' };
    }
    return { op };
}

// Parse every <LorebookEdit> block in a reply. Each block is independent: one bad
// block becomes an error entry, the rest still parse. Returns { ops, errors }.
function parseLorebookBlocks(text) {
    const ops = [];
    const errors = [];
    const re = /<LorebookEdit>([\s\S]*?)<\/LorebookEdit>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const res = parseOneLorebookBlock(m[1]);
        if (res.op) ops.push(res.op);
        else errors.push({ error: res.error || '无法解析' });
    }
    return { ops, errors };
}

/* ---- patch anchor matching (fuzzy, tolerant of whitespace / tags / quote style) ---- */
function lbEscapeRegex(s) {
    let out = '';
    const special = '.*+?^${}()|[]\\';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (special.indexOf(ch) !== -1) out += '\\';
        out += ch;
    }
    return out;
}
function lbNormQuotes(s) {
    return String(s).replace(/['"“”‘’`]/g, '"');
}
function lbFuzzyRegex(str) {
    const tokens = lbNormQuotes(str).trim().split(/[\s\-—_~*]+/).filter(Boolean).map(lbEscapeRegex);
    const SEP = '(?:\\s|<[^>]+>|[*_~.,;:!?，。；：！？、-])*';
    return new RegExp(tokens.join(SEP) || '\\b\\B', 'i');
}
// Replace the span identified by a "start || end" anchor (or a single anchor) with
// `replace`. Quote-normalize a same-length copy for matching so indices map back to
// the original. Returns { result, matched }.
function lbFuzzyReplace(content, anchor, replace) {
    const src = String(content == null ? '' : content);
    const norm = lbNormQuotes(src);              // 1:1 char map -> indices align with src
    const a = String(anchor == null ? '' : anchor);
    const repl = String(replace == null ? '' : replace);

    let sep = a.indexOf(' || '); let sl = 4;
    if (sep === -1) { sep = a.indexOf('||'); sl = 2; }
    if (sep === -1) { sep = a.indexOf('...'); sl = 3; }

    try {
        if (sep > 0 && a.length - sep - sl > 0) {
            const startA = a.slice(0, sep).trim();
            const endA = a.slice(sep + sl).trim();
            if (startA && endA) {
                const sM = norm.match(lbFuzzyRegex(startA));
                if (!sM) return { result: src, matched: false };
                const afterIdx = sM.index + sM[0].length;
                // Primary: the end segment lies strictly AFTER the start match (a normal
                // disjoint span). Fallback: models frequently write a degenerate or
                // overlapping span — start === end ("桜丘也不例外 || 桜丘也不例外"), end a
                // suffix of start ("…入读桜丘 || 入读桜丘"), or a shared run between the two
                // ("特待生身份入读 || 入读桜丘"). The strict search can never find such an end
                // (its chars were already consumed by the start match) → 锚点未找到. So
                // re-search the end from the START of the start match, then clamp the span
                // to cover at least the start anchor (never shorter than start matched).
                let eM = norm.slice(afterIdx).match(lbFuzzyRegex(endA));
                let end;
                if (eM) {
                    end = afterIdx + eM.index + eM[0].length;
                } else {
                    eM = norm.slice(sM.index).match(lbFuzzyRegex(endA));
                    if (!eM) return { result: src, matched: false };
                    end = Math.max(afterIdx, sM.index + eM.index + eM[0].length);
                }
                return { result: src.slice(0, sM.index) + repl + src.slice(end), matched: true };
            }
        }
        const m = norm.match(lbFuzzyRegex(a));
        if (m) return { result: src.slice(0, m.index) + repl + src.slice(m.index + m[0].length), matched: true };
    } catch (e) {
        console.warn('[Story Oracle] patch anchor match failed:', e);
    }
    return { result: src, matched: false };
}

function lbOpLabel(op) {
    if (!op) return '(无效操作)';
    const a = ({ create: '新增', edit: '改', patch: '补丁', delete: '删除', prepend: '前插', append: '追加' })[op.action] || op.action || '?';
    if (op.action === 'create') return `${a}「${(op.fields && op.fields.comment) || '(无标题)'}」`;
    return `${a} uid=${op.uid}`;
}
function lbSummaryOf(list) {
    const c = { create: 0, edit: 0, patch: 0, delete: 0, prepend: 0, append: 0 };
    for (const x of list) if (x && x.action in c) c[x.action]++;
    const bits = [];
    if (c.create) bits.push(`新增 ${c.create}`);
    if (c.edit) bits.push(`改 ${c.edit}`);
    if (c.patch) bits.push(`补丁 ${c.patch}`);
    if (c.prepend) bits.push(`前插 ${c.prepend}`);
    if (c.append) bits.push(`追加 ${c.append}`);
    if (c.delete) bits.push(`删除 ${c.delete}`);
    return bits.join(' · ') || '无改动';
}

/**
 * Apply parsed ops to the books, grouped by book. Each touched book is re-loaded
 * FRESH, deep-cloned for undo, mutated, then saved immediately. Per-op outcomes are
 * collected for the UI; an op never half-applies (patch validates its anchor first).
 * Returns { snapshots, results, summary, applied }.
 */
// Models often retype a book name imperfectly when it contains brackets/quotes
// (《》「」【】<> …) — dropping them, or a stray letter. Normalize away the bits
// models tend to mangle so we can still recognise the intended book.
function lbNormalizeName(s) {
    return String(s == null ? '' : s)
        .toLowerCase()
        .replace(/[\s《》「」『』【】〈〉«»()（）\[\]<>{}"'“”‘’`·・|/\\]/g, '');
}

// Resolve op.book to one of the books actually in scope (lbBookNames). Exact match
// first, then bracket/quote-insensitive match, then loose containment, and finally
// — since the picker usually targets a single book — fall back to the only book in
// scope. Returns the real name, or null if it genuinely can't be pinned down.
function resolveBookName(opBook, scope) {
    if (!Array.isArray(scope) || !scope.length) return null;
    const raw = (opBook == null ? '' : String(opBook)).trim();
    if (scope.includes(raw)) return raw;                       // exact
    const nb = lbNormalizeName(raw);
    if (nb) {
        const exactNorm = scope.filter((n) => lbNormalizeName(n) === nb);
        if (exactNorm.length === 1) return exactNorm[0];
        const loose = scope.filter((n) => {
            const nn = lbNormalizeName(n);
            return nn && (nn.includes(nb) || nb.includes(nn));
        });
        if (loose.length === 1) return loose[0];
    }
    if (scope.length === 1) return scope[0];                   // only one book shown → it must be that one
    return null;
}

async function applyLorebookOps(ops) {
    const mod = await getWiEditApi();
    if (!mod) throw new Error('世界书模块不可用');

    const results = [];
    const skip = (op, reason) => results.push({ ok: false, action: op && op.action, label: lbOpLabel(op), reason });

    const byBook = new Map();
    for (const op of ops) {
        if (!op || !op.action) { skip(op, '操作不完整'); continue; }
        const book = resolveBookName(op.book, lbBookNames);
        if (!book) { skip(op, op.book ? `世界书「${op.book}」不在本次范围内` : '未指定世界书，且无法自动判定'); continue; }
        op.book = book;   // normalize to the real name ST knows
        if (!byBook.has(book)) byBook.set(book, []);
        byBook.get(book).push(op);
    }

    const snapshots = [];
    for (const [name, bookOps] of byBook.entries()) {
        let data;
        try { data = await mod.loadWorldInfo(name); } catch (e) { data = null; }
        if (!data || !data.entries) { for (const op of bookOps) skip(op, `无法读取世界书「${name}」`); continue; }
        const snap = { name, data: structuredClone(data) };
        let touched = false;

        for (const op of bookOps) {
            if (op.action === 'create') {
                let entry;
                if (typeof mod.createWorldInfoEntry === 'function') entry = mod.createWorldInfoEntry(name, data);
                if (!entry) { skip(op, '无法新建条目'); continue; }
                entry.excludeRecursion = true;          // house defaults (overridable by fields)
                entry.preventRecursion = true;
                applyFieldsToEntry(entry, op.fields);
                const noKey = !Array.isArray(entry.key) || entry.key.length === 0;
                if (noKey && !('constant' in op.fields)) entry.constant = true;   // auto-blue
                results.push({ ok: true, action: 'create', label: `新增「${entry.comment || '(无标题)'}」(uid=${entry.uid})` });
                touched = true;
            } else if (op.action === 'delete') {
                if (op.uid == null || !(op.uid in data.entries)) { skip(op, `uid=${op.uid} 不存在`); continue; }
                const title = String(data.entries[op.uid].comment || '').trim();
                if (typeof mod.deleteWorldInfoEntry === 'function') await mod.deleteWorldInfoEntry(data, op.uid, { silent: true });
                else delete data.entries[op.uid];
                results.push({ ok: true, action: 'delete', label: `删除 uid=${op.uid}${title ? `「${title}」` : ''}` });
                touched = true;
            } else if (op.action === 'patch') {
                if (op.uid == null || !(op.uid in data.entries)) { skip(op, `uid=${op.uid} 不存在`); continue; }
                const entry = data.entries[op.uid];
                const { result, matched } = lbFuzzyReplace(entry.content || '', op.anchor, op.replace);
                if (!matched) { skip(op, `锚点未找到：「${String(op.anchor || '').slice(0, 40)}」`); continue; }
                entry.content = result;
                applyFieldsToEntry(entry, op.fields);   // optional scalar tweaks alongside
                results.push({ ok: true, action: 'patch', label: `补丁 uid=${op.uid}${entry.comment ? `「${entry.comment}」` : ''}` });
                touched = true;
            } else if (op.action === 'prepend' || op.action === 'append') {
                if (op.uid == null || !(op.uid in data.entries)) { skip(op, `uid=${op.uid} 不存在`); continue; }
                const entry = data.entries[op.uid];
                const insert = op.fields.content != null ? String(op.fields.content) : '';
                if (!insert) { skip(op, `${op.action} 没有要插入的正文`); continue; }
                const cur = entry.content || '';
                entry.content = op.action === 'prepend' ? insert + cur : cur + insert;   // verbatim concat, no auto separator
                const rest = { ...op.fields }; delete rest.content;   // don't let content overwrite via applyFieldsToEntry
                applyFieldsToEntry(entry, rest);                      // optional scalar tweaks alongside
                const a = op.action === 'prepend' ? '前插' : '追加';
                results.push({ ok: true, action: op.action, label: `${a} uid=${op.uid}${entry.comment ? `「${entry.comment}」` : ''}` });
                touched = true;
            } else { // edit
                if (op.uid == null || !(op.uid in data.entries)) { skip(op, `uid=${op.uid} 不存在`); continue; }
                applyFieldsToEntry(data.entries[op.uid], op.fields);
                const cm = data.entries[op.uid].comment;
                results.push({ ok: true, action: 'edit', label: `改 uid=${op.uid}${cm ? `「${cm}」` : ''}` });
                touched = true;
            }
        }

        if (touched) {
            snapshots.push(snap);
            await mod.saveWorldInfo(name, data, /*immediately*/ true);
            try { if (typeof mod.reloadEditor === 'function') mod.reloadEditor(name); } catch (e) { /* editor not open */ }
        }
    }

    const okResults = results.filter((r) => r.ok);
    return { snapshots, results, summary: lbSummaryOf(okResults), applied: okResults.length };
}

async function undoLorebookOps(snapshots) {
    const mod = await getWiEditApi();
    if (!mod) throw new Error('世界书模块不可用');
    for (const snap of snapshots) {
        await mod.saveWorldInfo(snap.name, snap.data, /*immediately*/ true);
        try { if (typeof mod.reloadEditor === 'function') mod.reloadEditor(snap.name); } catch (e) { /* ignore */ }
    }
}

/* ------------------------------------------------------------------ *
 * MVU (MagVarUpdate via JS-Slash-Runner) integration for Diagnose mode
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 * 剧情参谋 plan 机制（实验性）。
 *
 * 单一目标方案，存于【当前聊天】的 chatMetadata（随聊天持久化、随聊天切换）。
 * 注入文本永远在注册那一刻从 metadata 现场推导（buildDirective），绝不另存——
 * 因此「清掉 metadata + 重新注册」就能确凿地终止引导，不存在第二份真相。
 * setExtensionPrompt 是全局的，所以切到没有方案的聊天时必须用空串清掉它
 * （applyPlanInjection 对 plan == null 正是这么做的）。
 * ------------------------------------------------------------------ */
const ADVISOR_PROMPT_KEY = 'story_oracle_plan';
const ADVISOR_REMIND_AFTER = 20;   // 主聊天走过这么多条消息后，提醒一次方案仍在引导
const PLAN_META_KEY = MODULE + '_plan';
// 弧线元数据键（layer-2+）。每个聊天「单拍 plan 异或 弧线 arc」，二者互斥（见 getActiveConstruct）。
const ARC_META_KEY = MODULE + '_arc';
// 用户功能请求 —— 都按【当前聊天】持久化，与 plan/arc 同风格（随聊天保存、随切换刷新）：
//   _convo   持久化的侧聊问答历史（原本仅在内存里、刷新即丢）
//   _summary 用户粘贴的运行总结 / 前情提要
const CONVO_META_KEY = MODULE + '_convo';
const SUMMARY_META_KEY = MODULE + '_summary';
// 用户功能请求：诊断模式「精选世界书条目」按【当前聊天】持久化（与 plan/convo/summary 同风格）。
//   形状：{ use:bool（L1 主开关）, hybrid:bool（L2 混合）, target:''（书目标，''=全部激活）, sel:{ [书名]:uid[] } }
const DIAG_WI_META_KEY = MODULE + '_diagwi';
// ✨ 校正模式 Phase 4：把校正配置（目标 / 约束 / 上下文开关 / 自动）按【当前聊天】持久化——每个聊天记住
// 自己的校正设定（chat A 的目标不会渗进 chat B）。形状 = 只存被覆盖的 fix* 键（其余现场回退全局 getSettings 默认）；
// 没有任何覆盖时删键，保持元数据干净（同 setDiagWiMeta 风格）。生效配置经 getEffectiveFixCfg 合并、是校正代码的唯一读取入口。
const FIX_CFG_META_KEY = MODULE + '_fixcfg';

function getChatMetadataSafe() {
    try {
        const md = getCtx().chatMetadata;
        return (md && typeof md === 'object') ? md : null;
    } catch (e) { return null; }
}

// The active plan for the CURRENT chat, or null.
// Shape: { goal, seed, why, title, intensity, adoptedAt, reminded }
function getPlan() {
    const md = getChatMetadataSafe();
    const p = md ? md[PLAN_META_KEY] : null;
    return (p && typeof p === 'object' && p.goal) ? p : null;
}

function setPlan(plan) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    if (plan) md[PLAN_META_KEY] = plan;
    else delete md[PLAN_META_KEY];
    try {
        const ctx = getCtx();
        (ctx.saveMetadataDebounced || ctx.saveMetadata || (() => {}))();
    } catch (e) { /* metadata still set in memory */ }
    return true;
}

/* ------------------------------------------------------------------ *
 * 用户功能请求：按【当前聊天】持久化侧聊历史 + 运行概要（与 plan/arc 同风格——
 * 随聊天保存、随切换刷新、只在手动清空时清掉）。
 * ------------------------------------------------------------------ */
// 写元数据后触发 ST 的持久化（与 setPlan/setArc 内联那段同款的安全封装）。
function saveChatMetadata() {
    try {
        const ctx = getCtx();
        (ctx.saveMetadataDebounced || ctx.saveMetadata || (() => {}))();
    } catch (e) { /* metadata still set in memory */ }
}

// 纯函数：剥掉 _el（DOM 链接）等运行期字段，只留可持久化的 {id, role, content}。也保留自动诊断
// 的 note 记录（用户功能请求：把自动诊断的回复留在侧聊框里、跨重载存活）。可单测。
function serializeConvo(list) {
    return (Array.isArray(list) ? list : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'note') && typeof m.content === 'string')
        .map((m) => ({ id: m.id, role: m.role, content: m.content }));
}

// 发往模型的对话历史：只取真正的问答轮（user/assistant）。自动诊断等 note 条目只在侧聊框里
// 展示 + 持久化，绝不能作为一轮对话回灌给模型（否则会污染问答上下文，甚至把非法 role 发出去）。
// 默认取当前全局 convo；传显式数组即可单测。所有「把 convo 拼进 messages」的地方都改走这里。
function convoForPrompt(list = convo) {
    return (Array.isArray(list) ? list : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
}

// 读取本聊天保存的侧聊历史（始终回数组）。
function getConvoMeta() {
    const md = getChatMetadataSafe();
    const arr = md ? md[CONVO_META_KEY] : null;
    return Array.isArray(arr) ? arr : [];
}

// 把当前 convo 写回本聊天的元数据（空则删键，保持元数据干净）。每次 convo 变动后调用。
function persistConvo() {
    const md = getChatMetadataSafe();
    if (!md) return false;
    const arr = serializeConvo(convo);
    if (arr.length) md[CONVO_META_KEY] = arr; else delete md[CONVO_META_KEY];
    saveChatMetadata();
    return true;
}

// 读 / 写本聊天的运行概要（用户粘贴的前情提要 / 总结）。空串即删键。
function getSummary() {
    const md = getChatMetadataSafe();
    const t = md ? md[SUMMARY_META_KEY] : '';
    return typeof t === 'string' ? t : '';
}

function setSummary(text) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    const t = String(text || '');
    if (t.trim()) md[SUMMARY_META_KEY] = t; else delete md[SUMMARY_META_KEY];
    saveChatMetadata();
    return true;
}

/* ------------------------------------------------------------------ *
 * 用户功能请求：诊断模式「精选世界书条目」——按【当前聊天】持久化的选择（与 plan/convo/summary 同风格：
 * 随聊天保存、随切换刷新、全默认时删键）。元数据形状见 DIAG_WI_META_KEY。两层开关：
 *   use    L1 主开关——开了才精选；关 = 诊断完全走原行为（worldInfoMode 扫描 + collectMvuUpdateRules）
 *   hybrid L2 混合——精选条目 ∪ 主聊天当前触发的绿灯条目（仅 use 开时有意义）
 * 选择本体 sel:{书名:uid[]} 与内存镜像 diagEntrySel:{书名:Set<uid>} 互转。纯函数可单测。
 * ------------------------------------------------------------------ */
// 内存 { 书名: Set<uid> } -> 可持久化 { 书名: uid[]（升序）}。空集合的书也保留键（= 该书选了零条）。
function serializeDiagSel(map) {
    const out = {};
    for (const [book, set] of Object.entries(map || {})) {
        if (!(set instanceof Set)) continue;
        out[book] = [...set].map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    }
    return out;
}

// 反向：{ 书名: uid[] } -> { 书名: Set<uid> }。容错非数组 / 非数字。
function deserializeDiagSel(obj) {
    const out = {};
    if (obj && typeof obj === 'object') {
        for (const [book, arr] of Object.entries(obj)) {
            out[book] = new Set((Array.isArray(arr) ? arr : []).filter((x) => x != null && x !== '').map(Number).filter((n) => Number.isFinite(n)));
        }
    }
    return out;
}

// 读本聊天的诊断选条目元数据（始终回带默认值的对象，绝不返回 null）。
function getDiagWiMeta() {
    const md = getChatMetadataSafe();
    const m = md ? md[DIAG_WI_META_KEY] : null;
    return {
        use: !!(m && m.use),
        hybrid: !!(m && m.hybrid),
        target: (m && typeof m.target === 'string') ? m.target : '',
        sel: (m && m.sel && typeof m.sel === 'object') ? m.sel : {},
    };
}

// 写本聊天的诊断选条目元数据（全默认 = 删键，保持元数据干净）。
function setDiagWiMeta(obj) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    const o = obj || {};
    const sel = (o.sel && typeof o.sel === 'object') ? o.sel : {};
    const empty = !o.use && !o.hybrid && !o.target && !Object.keys(sel).length;
    if (empty) delete md[DIAG_WI_META_KEY];
    else md[DIAG_WI_META_KEY] = { use: !!o.use, hybrid: !!o.hybrid, target: o.target || '', sel };
    saveChatMetadata();
    return true;
}

// 把内存选择 diagEntrySel 回写元数据，保留 use/hybrid/target。每次勾选 / 快捷按钮后调用。
function persistDiagSel() {
    const cur = getDiagWiMeta();
    setDiagWiMeta({ use: cur.use, hybrid: cur.hybrid, target: cur.target, sel: serializeDiagSel(diagEntrySel) });
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式 Phase 4：校正配置按【当前聊天】持久化（同 plan/convo/summary/diagwi 风格）。
 * 元数据只存被【显式覆盖】的 fix* 键（getEffectiveFixCfg 现场回退到全局 getSettings 默认）；空 = 删键。
 * getEffectiveFixCfg 是纯函数（合并全局 s + 本聊天 md），是校正代码读取配置的唯一入口。
 * ------------------------------------------------------------------ */
// 迁到 per-chat 的校正键（全局 getSettings 默认仍是回退值）。autoDiagnoseEnabled 不在此列——自动诊断不迁移、仍走全局。
const FIX_CFG_KEYS = [
    // 手动模式（per-chat 可覆盖）
    'fixM_contextDepth', 'fixM_includeCard', 'fixM_includeWorld', 'fixM_includeSummary',
    // 自动模式（per-chat 可覆盖）
    'fixA_includeCard', 'fixA_includeContext', 'fixA_contextDepth', 'fixA_includeWorld', 'fixA_includeSummary',
    'fixA_targetSlop', 'fixA_targetDialogue', 'fixA_targetPrecision', 'fixA_targetMagic', 'fixA_targetPacing',
    'fixA_knowledgeBoundary', 'fixA_guardrails', 'fixA_keepTags', 'fixA_dropTags', 'fixA_scopeTag', 'fixA_scopeManual', 'fixA_tighten',
    'fixA_promptVersion', 'fixA_promptFlavor',   // ✨ 校正提示词选择器（轻校 / 精校 + 侧重）
    'autoFixEnabled', 'fixAutoMinChars',
];

// 纯函数：把全局设置 s 与本聊天元数据 md（或 null/undefined）合并成生效校正配置。
// 每个 fix* 键：md 用 hasOwnProperty 显式拥有该键就取 md 的值（尊重显式 false / 0 / ''），否则回退 s。
// 校正代码一律读这里返回的对象，绝不直读 s.fix*（否则 per-chat 覆盖会被绕过——这正是本任务要根治的 bug）。
function getEffectiveFixCfg(s, md) {
    const out = {};
    const g = s || {};
    const m = (md && typeof md === 'object') ? md : null;
    for (const k of FIX_CFG_KEYS) {
        out[k] = (m && Object.prototype.hasOwnProperty.call(m, k)) ? m[k] : g[k];
    }
    return out;
}

// ✨ 校正：「经自定义补全预设发送」开关按模式取值——手动/自动分家后各自独立（用户功能请求 2026-06-27）。
// 全局键 fixM_usePreset / fixA_usePreset；非 'auto' 一律看手动键；s 缺失容错为 false。纯判定，便于单测。
function fixUsePresetFor(s, mode) {
    return !!(s && s[mode === 'auto' ? 'fixA_usePreset' : 'fixM_usePreset']);
}

// 纯函数：把 getEffectiveFixCfg 的【原始 fixM_*/fixA_* 键】归一成校正代码消费的统一形状（按 mode 取对应一套）。
// 校正代码（captureFixContext / runFixByTargets / runAutoFix）一律读这里的输出，不直读 fixM_/fixA_ 原始键——
// 这样手动 / 自动两套设置彻底独立（同名设置互不串味），且收紧/目标的「仅自动」规则集中在此一处。
// 手动：上下文按 fixM_*（depth=0 视作不带前文）、永不收紧、无目标 / 约束 / 排除区（纯指令驱动，省时间）。
// 自动：上下文 / 目标 / 约束 / 排除区 / 收紧全按 fixA_*（收紧默认开，显式 false 才关）。可单测。
function resolveFixModeCfg(e, mode) {
    const c = e || {};
    if (mode === 'auto') {
        return {
            includeCard: !!c.fixA_includeCard, includeContext: !!c.fixA_includeContext,
            contextDepth: (c.fixA_contextDepth | 0) || 30, includeWorld: !!c.fixA_includeWorld,
            includeSummary: !!c.fixA_includeSummary, tighten: c.fixA_tighten !== false,
            targets: {
                slop: !!c.fixA_targetSlop, dialogue: !!c.fixA_targetDialogue, precision: !!c.fixA_targetPrecision,
                magic: !!c.fixA_targetMagic, pacing: !!c.fixA_targetPacing,
            },
            knowledge: c.fixA_knowledgeBoundary || '', guardrails: c.fixA_guardrails || '',
            keepTags: c.fixA_keepTags || '', dropTags: c.fixA_dropTags || '',
            // 作用域标签：缺省（旧聊天 / 未设）→ 'content' 默认；显式空串 '' → 关闭作用域（校正整条）。
            scopeTag: (c.fixA_scopeTag == null ? 'content' : c.fixA_scopeTag),
            // ✨ 自动配置 Phase 5（D+E）：这个标签是否用户手填过——resolveFixScope 据此决定缓存未命中时能不能
            // 自我纠正（false）还是只能建议不能代劳（true）。
            scopeManual: !!c.fixA_scopeManual,
            // ✨ 校正提示词选择器（轻校 / 精校 + 侧重）：归一 raw fixA_promptVersion/Flavor 成校验值。缺省 / null /
            // 未知 → 默认（light / deepseek），迁移安全（老聊天无值 = 轻校 = 零行为变化）。resolveFixAutoPrompt 据此选提示。
            promptVersion: (c.fixA_promptVersion === 'thorough' ? 'thorough' : 'light'),
            promptFlavor: (c.fixA_promptFlavor === 'opus' ? 'opus' : 'deepseek'),
        };
    }
    // 手动：depth 显式 0 = 不带前文；其余非正数 / 缺省 = -1（全部）。
    const depth = (c.fixM_contextDepth === 0) ? 0 : ((c.fixM_contextDepth | 0) || -1);
    return {
        includeCard: !!c.fixM_includeCard, includeContext: depth !== 0, contextDepth: depth,
        includeWorld: !!c.fixM_includeWorld, includeSummary: !!c.fixM_includeSummary, tighten: false,
        targets: { slop: false, dialogue: false, precision: false, magic: false, pacing: false },
        knowledge: '', guardrails: '', keepTags: '', dropTags: '', scopeTag: '',   // 手动不走作用域（captureFixContext 也按 mode 门控）
        scopeManual: false,   // 手动模式下这个字段无意义（作用域本就关闭），给个确定值避免 undefined 外泄
        promptVersion: 'light', promptFlavor: 'deepseek',   // 手动模式不走精校（buildFixPrompt 手动分支另选 FIX_SYSTEM_PROMPT_MANUAL）；给确定值避免 undefined 外泄
    };
}

// ✨ 自动校正提示词选择器（纯映射，设计 §4）：把归一后的 {promptVersion, promptFlavor} 映射到具体系统提示常量。
//   version !== 'thorough' → 轻校 = FIX_SYSTEM_PROMPT_TIGHTEN（今天的现行提示，默认，byte 不变）
//   thorough + flavor==='opus' → FIX_PROMPT_JINGXIAO_OPUS（对「数据包腔」强攻，适合 Claude / Opus）
//   thorough + 其它 / 缺省     → FIX_PROMPT_JINGXIAO_DEEPSEEK（克制版，适合 DeepSeek / 国产模型）
// 只有精确的 'thorough' 才是精校；null / '' / 未知一律回落轻校（迁移安全）。cfg 缺失也回落轻校，不抛。
function resolveFixAutoPrompt(cfg) {
    const c = cfg || {};
    if (c.promptVersion !== 'thorough') return FIX_SYSTEM_PROMPT_TIGHTEN;
    return c.promptFlavor === 'opus' ? FIX_PROMPT_JINGXIAO_OPUS : FIX_PROMPT_JINGXIAO_DEEPSEEK;
}

// 读本聊天保存的校正覆盖（始终回对象，可能为空 {}）。喂给 getEffectiveFixCfg 当 md。
function getFixCfg() {
    const md = getChatMetadataSafe();
    return (md && md[FIX_CFG_META_KEY]) || {};
}

// 把 patch 合并进本聊天的校正覆盖并写回。合并后为空 = 删键（保持元数据干净，同 setDiagWiMeta）。
// 只存被覆盖的 fix* 键——读取时 getEffectiveFixCfg 现场回退全局默认，故无需在此存全量。
function setFixCfg(patch) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    const cur = (md[FIX_CFG_META_KEY] && typeof md[FIX_CFG_META_KEY] === 'object') ? md[FIX_CFG_META_KEY] : {};
    const merged = { ...cur, ...(patch || {}) };
    if (Object.keys(merged).length) md[FIX_CFG_META_KEY] = merged;
    else delete md[FIX_CFG_META_KEY];
    saveChatMetadata();
    return true;
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式 Phase 4：全局命名套餐库（save / load / delete）。
 * 套餐存全局设置（getSettings().fixBundles，跨聊天可用）；加载时把套餐里的配置写进【本聊天】
 * 的 per-chat 覆盖（setFixCfg）。快照只取 FIX_CFG_KEYS 的生效值（getEffectiveFixCfg 合并后），
 * 故套餐里永远是「当前用户实际看到的那套配置」，与 per-chat 覆盖机制一致。
 * ------------------------------------------------------------------ */
// 把【当前生效】校正配置快照成一个具名套餐，存进全局 fixBundles（同名则替换）。name 必填、去空白。
// Phase 5 RESOLUTION C：快照经 filterBundleCfg 过滤——此前这里直接存全量 FIX_CFG_KEYS，filterBundleCfg
// 定义了却没人调用（死代码），套餐因此会带着上一张卡的 fixA_scopeTag / fixA_scopeManual 泄漏到下一张卡上。
// 只影响【新存】的套餐；已存的旧套餐不受影响，除非用户重新保存。
function saveFixBundle(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return false;
    const eff = getEffectiveFixCfg(getSettings(), getFixCfg());
    const cfg = {};
    for (const k of FIX_CFG_KEYS) cfg[k] = eff[k];
    const snapshot = filterBundleCfg(cfg);   // 剔除卡片专属（scopeTag/scopeManual）+ 模式开关（autoFixEnabled）
    const s = getSettings();
    if (!Array.isArray(s.fixBundles)) s.fixBundles = [];
    const idx = s.fixBundles.findIndex((b) => b && b.name === trimmed);
    if (idx >= 0) s.fixBundles[idx] = { name: trimmed, cfg: snapshot };
    else s.fixBundles.push({ name: trimmed, cfg: snapshot });
    save();
    return true;
}

// 把某个具名套餐加载进【本聊天】的校正覆盖（setFixCfg）并回填控件（loadFixCfgForChat）。
function loadFixBundle(name) {
    const s = getSettings();
    const bundle = (Array.isArray(s.fixBundles) ? s.fixBundles : []).find((b) => b && b.name === name);
    if (!bundle || !bundle.cfg) return false;
    setFixCfg(bundle.cfg);   // 写本聊天 per-chat 覆盖（全局默认仍是回退）
    loadFixCfgForChat();     // 重新种子校正控件，UI 立刻反映
    return true;
}

// 从全局 fixBundles 删除一个具名套餐。
function deleteFixBundle(name) {
    const s = getSettings();
    if (!Array.isArray(s.fixBundles)) return false;
    const before = s.fixBundles.length;
    s.fixBundles = s.fixBundles.filter((b) => !(b && b.name === name));
    if (s.fixBundles.length === before) return false;
    save();
    return true;
}

// 纯函数：选中的条目里是否含至少一条 [mvu_update] 变量规则条目（按 comment 匹配，复用 MVU_UPDATE_TAG）。
// WYSIWYG 提醒用：精选模式下一条规则都没选时，诊断可能不准。entries = 选中条目对象数组。
function diagSelHasRules(entries) {
    return (Array.isArray(entries) ? entries : []).some((e) => e && MVU_UPDATE_TAG.test(e.comment || ''));
}

// 纯函数：ST 扫描结果 allActivatedEntries（Set<entry> 或数组）-> { 书名: Set<uid> }。
// 只含当前【真正被激活】的条目（常驻蓝灯 + 命中关键词的绿灯）；筛绿灯交给调用方。
function activeUidsFromScan(activated) {
    const out = {};
    const list = activated instanceof Set ? [...activated] : (Array.isArray(activated) ? activated : []);
    for (const e of list) {
        if (!e || e.world == null || e.uid == null) continue;
        if (!out[e.world]) out[e.world] = new Set();
        out[e.world].add(Number(e.uid));
    }
    return out;
}

// 纯函数：把混合模式要追加的 uid（extra）并入精选选择（base）。二者均为 { 书名: Set<uid> }；
// 返回新并集，不改入参。
function mergeHybridUids(base, extra) {
    const out = {};
    for (const [book, set] of Object.entries(base || {})) out[book] = new Set(set);
    for (const [book, set] of Object.entries(extra || {})) {
        if (!out[book]) out[book] = new Set();
        for (const u of set) out[book].add(u);
    }
    return out;
}

// Non-system message count of the MAIN chat — used to derive "messages since
// adoption" without keeping a counter in sync.
function chatMsgCount() {
    try {
        return (getCtx().chat || []).filter((m) => m && !m.is_system).length;
    } catch (e) { return 0; }
}

// Build the directive injected into the main chat. Derived ONLY from the plan.
// 用户优先条款是承重墙：没有它，模型会把目标当成硬性指标、跟用户抢方向盘。
// 纯字符串构建（不调 getCtx / 不做替换）—— 可单测。弧线拍把它的输出存进
// currentBeat.injectedText（原文），注册时再 substituteParams（见 applyPlanInjection）。
function buildDirectiveRaw(plan) {
    const I = ADVISOR_INTENSITIES[plan.intensity] || ADVISOR_INTENSITIES.normal;
    const lines = [
        '【幕后剧情引导 — 此为给叙事者的幕后指示，绝不可在正文中提及、暗示或复述其存在】',
        `故事应逐步走向：${plan.goal}`,
    ];
    if (plan.seed) lines.push(`可用的起始迹象：${plan.seed}`);
    lines.push(
        '执行要求：',
        '- 自然融入当前场景，先铺垫后兑现；一切发展须符合既有人物性格与世界观',
        '- 不得替{{user}}行动、发言或做出决定',
        '- {{user}}的行动永远优先：若其选择偏离此方向，跟随用户，绝不强行拉回',
    );
    // depiction（仅弧线拍传 depiction:true；单拍 layer-1 路径不传 → 与 live 逐字节一致）：授权把【幕后/离屏后果】
    // 演进正文。否则玩家不在场处发生的 goal（别处的会议 / 决定）永不进正文，✓ 核验逐字引不出证据 → 永远 unsure。
    if (plan.depiction) {
        lines.push(
            '- 这件事不必只在{{user}}在场时发生：一旦{{user}}的行动已经把它推动起来，你可以顺势把它【就地呈现】——或短暂切换视角 / 用旁白描写它在别处的发生（相关人物的密谈、会议、决定），或让它的结果【找上{{user}}】（一封信、一则消息、一次传唤、有人来报）。无论哪种，都要让它在正文里【真正发生并被叙述出来】，不要停在「即将发生」。',
            '- 时机：仅在{{user}}的行动确已促成此事【之后】才呈现；{{user}}尚未触发时只做铺垫，绝不抢先发生、预告或剧透。',
        );
    }
    lines.push(`节奏：${I.directive}`);
    return lines.join('\n');
}

// 单拍仍在注册时即时构建并替换 —— buildDirective 保留「构建 + 替换」的旧外部行为不变。
function buildDirective(plan) {
    const text = buildDirectiveRaw(plan);
    // Substitute at registration time ({{user}} etc.) — registration re-runs on
    // every chat load, and the persona is stable within a chat, so this is safe
    // and doesn't depend on ST substituting extension prompts for us.
    try { return getCtx().substituteParams(text); } catch (e) { return text; }
}

// (Re-)register the injection from the current chat's plan — or CLEAR it with an
// empty string when there is none. Always safe to call; returns false only when
// this ST build has no setExtensionPrompt at all.
function applyPlanInjection() {
    const ctx = getCtx();
    if (typeof ctx.setExtensionPrompt !== 'function') return false;
    const s = getSettings();
    const pos = (ctx.extension_prompt_types && ctx.extension_prompt_types.IN_CHAT != null)
        ? ctx.extension_prompt_types.IN_CHAT : 1;                    // IN_CHAT
    const role = (ctx.extension_prompt_roles && ctx.extension_prompt_roles.SYSTEM != null)
        ? ctx.extension_prompt_roles.SYSTEM : 0;                     // SYSTEM
    const depth = Number.isFinite(s.advisorDepth) ? Math.max(0, s.advisorDepth) : 4;
    // Register the ACTIVE construct's injection — an arc's current beat OR a single
    // plan — or clear it with '' when neither exists. The arc beat's text is stored
    // raw and substituted here; a single plan rebuilds via buildDirective (which
    // substitutes internally). Either way, substitution happens at registration.
    const active = getActiveConstruct();
    let text = '';
    if (active && active.type === 'arc' && active.arc.currentBeat) {
        const raw = active.arc.currentBeat.injectedText || '';
        try { text = ctx.substituteParams(raw); } catch (e) { text = raw; }
    } else if (active && active.type === 'plan') {
        text = buildDirective(active.plan);
    }
    try {
        ctx.setExtensionPrompt(ADVISOR_PROMPT_KEY, text, pos, depth, false, role);
        return true;
    } catch (e) {
        console.warn('[Story Oracle] setExtensionPrompt failed:', e);
        return false;
    }
}

// Adopt a plan (single-goal rule: replaces any existing one, with a note).
function adoptPlan(p, intensity) {
    const prev = getPlan();
    const plan = {
        goal: String(p.goal || '').trim(),
        seed: String(p.seed || '').trim(),
        why: String(p.why || '').trim(),
        title: String(p.title || '').trim(),
        intensity: ADVISOR_INTENSITIES[intensity] ? intensity : 'normal',
        adoptedAt: chatMsgCount(),
        reminded: false,
    };
    if (!plan.goal) return;
    if (!setPlan(plan)) {
        addSystemNote('无法保存引导方案：当前似乎没有打开任何聊天。');
        return;
    }
    const ok = applyPlanInjection();
    renderPlanBar();
    addSystemNote(
        (prev ? `已替换原方案『${prev.title || prev.goal}』。` : '') +
        (ok
            ? '已开始引导：主聊天的 AI 会逐步把剧情推向这个方向（你正常进行 RP 即可）。随时可在上方的方案条里调整强度、查看注入内容、或停止引导。'
            : '方案已保存，但当前 SillyTavern 不支持注入接口（setExtensionPrompt）——引导不会生效，请更新 ST 版本。'),
    );
}

// End the active plan (done=true 完成 / false 放弃). Tears down metadata first,
// then re-registers (which clears the prompt) — main chat is provably back to
// the extension's usual zero-side-effect state.
function endPlan(done) {
    const plan = getPlan();
    if (!plan) return;
    setPlan(null);
    applyPlanInjection();
    renderPlanBar();
    addSystemNote(done
        ? `方案『${plan.title || plan.goal}』已标记完成，引导已停止——主聊天恢复原状。`
        : `方案『${plan.title || plan.goal}』已放弃，引导已停止——主聊天恢复原状。`);
}

// Change intensity on the fly: metadata updated, directive rebuilt, re-registered.
function setPlanIntensity(intensity) {
    const plan = getPlan();
    if (!plan || !ADVISOR_INTENSITIES[intensity]) return;
    plan.intensity = intensity;
    setPlan(plan);
    applyPlanInjection();
    renderPlanBar();
}

// One-time staleness ping: a silent perpetual injection is how "the AI keeps
// obsessing about the festival" reports happen. adoptedAt vs current length —
// derived, nothing to keep in sync.
function checkPlanReminder() {
    const active = getActiveConstruct();
    if (!active) return;
    if (active.type === 'arc') {
        // Per-beat staleness: a beat that never resolves just sits with a stale
        // injection. Same 20-message threshold, spoiler-safe phrasing.
        const b = active.arc.currentBeat;
        if (!b || b.reminded) return;
        const n = chatMsgCount() - (b.beatAdoptedAt || 0);
        if (n >= ADVISOR_REMIND_AFTER) {
            b.reminded = true;
            setArc(active.arc);
            addSystemNote(`当前这一拍已持续 ${n} 条消息——推进了吗？可在方案条里「完成」进入下一拍、「换个思路」换条路线，或问我「检查进度」。`);
        }
        return;
    }
    const plan = active.plan;
    if (plan.reminded) return;
    const n = chatMsgCount() - (plan.adoptedAt || 0);
    if (n >= ADVISOR_REMIND_AFTER) {
        plan.reminded = true;
        setPlan(plan);
        addSystemNote(`引导方案『${plan.title || plan.goal}』已持续 ${n} 条消息——剧情推进到了吗？可以在剧情参谋模式里问我「检查进度」，或在上方方案条里完成 / 调整它。`);
    }
}

// Chat switched (or first chat loaded): re-register from THIS chat's metadata —
// registers its plan, or clears any previous chat's injection. The extension's
// only event-driven side effect; everything else stays pull-based.
function onChatChanged() {
    cancelPostReply();    // ✨ Phase 4 P-CORRUPT：切聊天先尽力中断在途的自动校正 / 诊断，避免它带着旧聊天的目标写回新聊天（应用前还有 fixTargetStale 兜底）
    applyPlanInjection();
    if (win) renderPlanBar();
    checkPlanReminder();
    loadConvoForChat();   // 用户功能请求：把本聊天保存的侧聊历史载入窗口（per-chat 持久化）
    refreshSummaryUI();   // 用户功能请求：刷新本聊天的运行概要编辑器
    loadDiagSelForChat(); // 用户功能请求：载入本聊天的诊断「精选世界书条目」选择
    loadFixCfgForChat();  // ✨ 校正模式 Phase 4：把校正控件重置成本聊天的生效配置（per-chat 持久化）
}

/* ------------------------------------------------------------------ *
 * 剧情参谋「弧线系统」—— layer 2 骨架（确定性、无 LLM；完整设计见 _ADVISOR-ARC-DESIGN.md）。
 *
 * 「单拍 plan 异或 弧线 arc」，每个聊天只有一个 active 构件。纯函数层（buildArc /
 * stubCompileBeat / arcAdvance / arcReroll / arcSetIntensity）把时钟 now（主聊天消息数）作为
 * 参数注入、不调 getCtx，所以可在 jsdom 里确定性单测；元数据 / 注入 / 渲染等副作用留在集成函数里。
 * stubCompileBeat 是 layer-3 LLM 编译器的确定性替身，到时整体替换为异步 compileBeat。
 * ------------------------------------------------------------------ */

// ---- 元数据读写（同 getPlan/setPlan 风格）----
function getArc() {
    const md = getChatMetadataSafe();
    const a = md ? md[ARC_META_KEY] : null;
    return (a && typeof a === 'object' && a.mode && Array.isArray(a.waypoints)) ? a : null;
}

function setArc(arc) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    if (arc) md[ARC_META_KEY] = arc; else delete md[ARC_META_KEY];
    try {
        const ctx = getCtx();
        (ctx.saveMetadataDebounced || ctx.saveMetadata || (() => {}))();
    } catch (e) { /* metadata still set in memory */ }
    return true;
}

// 当前聊天的 active 构件：弧线优先于单拍（采用任一会清掉另一，见 adoptArc）。ENABLE_ARC
// 关闭时彻底忽略弧线元数据 —— kill switch 让参谋干净退回单拍行为。
function getActiveConstruct() {
    const arc = ENABLE_ARC ? getArc() : null;
    if (arc) return { type: 'arc', arc };
    const plan = getPlan();
    if (plan) return { type: 'plan', plan };
    return null;
}

// ---- 纯函数层（可单测；时钟 now 由调用方注入）----

// layer-3 LLM 编译器的确定性替身：把一个路标编成一拍。variant>0 = 「换个思路」后的不同路线。
function stubCompileBeat(arc, waypoint, variant, now) {
    const v = Number(variant) || 0;
    const inherit = (arc.currentBeat && arc.currentBeat.intensity) || 'normal';
    const intensity = ADVISOR_INTENSITIES[inherit] ? inherit : 'normal';
    const goal = v > 0 ? `${waypoint.intent}（路线 ${v + 1}）` : waypoint.intent;
    return {
        waypointId: waypoint.id,
        title: waypoint.intent,
        goal,
        seed: '',
        why: `推进路标「${waypoint.intent}」`,
        type: '',                                  // #3 类型由真编译器填；stub 不分类（保形状与 buildCompiledBeat 一致）
        objective: arc.mode === 'blind' ? waypoint.intent : null,  // 盲盒玩家可见任务（layer-4 精化）
        intensity,
        injectedText: buildDirectiveRaw({ goal, seed: '', intensity, depiction: true }),
        variant: v,
        stage: null,
        objectiveB: null,
        beatAdoptedAt: Number(now) || 0,
        reminded: false,
    };
}

function cloneArc(arc) {
    return JSON.parse(JSON.stringify(arc));
}

function arcActiveWaypoint(arc) {
    return (arc && Array.isArray(arc.waypoints)) ? (arc.waypoints[arc.cursor] || null) : null;
}

function isArcComplete(arc) {
    return !!arc && !arc.currentBeat;
}

// 把一份已解决的拍压进揭晓日志的记录。
function arcResolvedRecord(beat, outcome) {
    return {
        waypointId: beat.waypointId,
        title: beat.title,
        goal: beat.goal,
        objective: beat.objective,
        seed: beat.seed,
        why: beat.why,
        type: beat.type || '',          // #3 类型轮换：揭晓记录也带类型，供 recentBeatTypes 喂回编译器
        injectedText: beat.injectedText,
        outcome,
    };
}

// 从规格构建一条新弧线，并把第一拍编好。
//   spec: { mode, throughline, spanFeel, waypoints:[intent…], consent? }
function buildArc(spec, now) {
    const mode = (spec && spec.mode === 'blind') ? 'blind' : 'transparent';
    const waypoints = ((spec && spec.waypoints) || [])
        .map((intent, i) => ({ id: i + 1, intent: String(intent == null ? '' : intent).trim(), status: 'pending' }))
        .filter((w) => w.intent);
    if (waypoints.length) waypoints[0].status = 'active';
    const arc = {
        mode,
        throughline: String((spec && spec.throughline) || '').trim(),
        spanFeel: (SPAN_FEEL[spec && spec.spanFeel] ? spec.spanFeel : 'medium'),  // #8 校验 + 单一来源
        waypoints,
        cursor: 0,
        consent: mode === 'blind' ? ((spec && spec.consent) || null) : null,
        currentBeat: null,
        revealed: [],
        adoptedAt: Number(now) || 0,
        shaping: null,
    };
    if (waypoints.length) arc.currentBeat = stubCompileBeat(arc, waypoints[0], 0, now);
    return arc;
}

// 下一个 pending 路标（跳过 skipped），没有则 null。纯函数。
function arcPeekNext(arc) {
    if (!arc || !Array.isArray(arc.waypoints)) return null;
    let ni = arc.cursor + 1;
    while (ni < arc.waypoints.length && arc.waypoints[ni].status === 'skipped') ni++;
    return ni < arc.waypoints.length ? arc.waypoints[ni] : null;
}

// 把一个【已编好的】beat 装进「推进」结果：标记当前路标 done、压入 revealed、把游标移到 beat
// 所属路标、装上该 beat。纯函数（beat 由 stub 或真编译器产出，二者形状一致）。
function arcCommitAdvance(arc, beat, outcome) {
    const next = cloneArc(arc);
    const cur = next.waypoints[next.cursor];
    if (cur) cur.status = 'done';
    if (arc.currentBeat) next.revealed.push(arcResolvedRecord(arc.currentBeat, outcome || 'done'));
    const ni = next.waypoints.findIndex((w) => w.id === beat.waypointId);
    if (ni >= 0) { next.cursor = ni; next.waypoints[ni].status = 'active'; }
    next.currentBeat = beat;
    return next;
}

// 把一个【已编好的】beat 作为「换路线」结果装上（同路标、不动游标）。纯函数。
function arcCommitReroll(arc, beat) {
    const next = cloneArc(arc);
    next.currentBeat = beat;
    return next;
}

// 重构待办尾段（living-skeleton，仅盲盒、贯穿线神圣、漂移显著时由编译器触发——设计 §8）：把【当前 active 之后
// 的全部 pending 路标】标记 skipped（保留审计；arcPeekNext / live 计数 / 显示标签早已支持 skipped），再把模型重拟
// 的新尾段作为 pending 追加在末尾，id 单调续号（绝不复用 → 护住 revealed / currentBeat 的 id 引用）。done / active
// 路标与 cursor 一律不动；末端锚定的形状角色因此自动落到新尾段（新尾段最后一个 = 高潮）。纯函数、不改入参、可单测。
// newTailIntents 为空 / 全空白 → 原样返回（绝不把骨架清空）。
function arcReviseTail(arc, newTailIntents) {
    const intents = (Array.isArray(newTailIntents) ? newTailIntents : [])
        .map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
    if (!arc || !Array.isArray(arc.waypoints) || !intents.length) return arc;
    const next = cloneArc(arc);
    for (let i = next.cursor + 1; i < next.waypoints.length; i++) {
        if (next.waypoints[i].status === 'pending') next.waypoints[i].status = 'skipped';
    }
    let maxId = 0;
    for (const w of next.waypoints) maxId = Math.max(maxId, Number(w.id) || 0);
    for (const intent of intents) next.waypoints.push({ id: ++maxId, intent, status: 'pending' });
    return next;
}

// 玩家当前实际看到的任务：stage B 时是 objectiveB（延伸任务），否则 objective。纯函数。
function arcVisibleObjective(beat) {
    if (!beat) return '';
    return (beat.stage === 'B' && beat.objectiveB) ? beat.objectiveB : (beat.objective || '');
}

// 形状角色标签（端锚定的弧线曲线：早期铺垫→中期升温→倒数第二最艰难→末拍高潮）。喂给编译 / 达成调用，让
// 「这一拍在弧线里扮演什么」由【显式角色】传达，而非让模型从一个会因跳过 / 重构而漂移的原始序号里自己反推。
const ARC_SHAPE_ROLES = {
    setup:   '早期铺垫（低赌注，埋线与暗示）',
    rising:  '中期升温（赌注与张力渐升）',
    hardest: '倒数第二拍 —— 全弧最艰难的抉择',
    climax:  '末拍 —— 高潮收束，让贯穿线在此落地',
};

// 活跃路标序列（排除 skipped）。形状 / 位置一律按它算，不受被跳过 / 重构掉的路标干扰。纯函数。
function arcLiveWaypoints(arc) {
    return (arc && Array.isArray(arc.waypoints)) ? arc.waypoints.filter((w) => w && w.status !== 'skipped') : [];
}

// 某一拍在弧线形状里的【位置 + 角色】，全部按 live 序列、【末端锚定】算（末=高潮、倒数第二=最艰难），所以跳过 /
// 重构早段路标都不会让承重角色漂移；末路标不可变（贯穿线神圣）更保证锚点稳。这把「drafter 把曲线烤进序列」与
// 「compiler 从序号反推曲线」两套独立断言合一：不再各算各的，统一从 live 序列末端派生。纯函数、可单测。
//   返回 { index, total, role }：index/total = 1-based live 位置（不含 skipped）；role ∈ setup|rising|hardest|climax。
function arcShapePosition(arc, waypoint) {
    const live = arcLiveWaypoints(arc);
    const total = live.length;
    const i = live.findIndex((w) => w && waypoint && w.id === waypoint.id);
    const index = i < 0 ? 0 : i + 1;
    let role;
    if (total <= 1 || index >= total) role = 'climax';                  // 末拍（或独拍）：高潮收束
    else if (index === total - 1) role = 'hardest';                     // 倒数第二：最艰难抉择
    else if (index > 0 && index <= Math.round(total / 4)) role = 'setup'; // 前 ~1/4：低赌注铺垫（短弧也保住中段升温）
    else role = 'rising';                                               // 中段：升温
    return { index, total, role };
}

// 置信门控决策（layer-4 细化）：玩家点了「✓ 达成」+ 核验判定 verdict（yes|unsure|no），决定怎么走。
// 纯函数（不调 LLM、不落副作用），故可确定性单测。守住「不确定一律不揭晓」与「不把玩家困在同一拍」。
//   yes                      → 'reveal-advance'（揭晓 + 编下一拍 / 收束）
//   非 yes 且当前非 stage B   → 'stage-b'（同一幕后 goal，换一个更直接的玩家任务；不揭晓、不前进）
//   非 yes 且已 stage B       → 'quiet-advance'（编下一拍并推进，但不揭晓）
function arcDecideOnAchieve(arc, verdict) {
    if (verdict === 'yes') return 'reveal-advance';
    const stage = (arc && arc.currentBeat && arc.currentBeat.stage) || 'A';
    return stage === 'B' ? 'quiet-advance' : 'stage-b';
}

// 置 stage B：保持当前拍的幕后 goal / 注入 / stage-A objective 不变，只把新的玩家任务挂为 objectiveB
// 并标 stage='B'。纯函数（newObjective 来自真编译器的 beat.objective）。
function arcCommitStageB(arc, newObjective) {
    const next = cloneArc(arc);
    if (next.currentBeat) {
        next.currentBeat.stage = 'B';
        const o = String(newObjective == null ? '' : newObjective).trim();
        next.currentBeat.objectiveB = o || next.currentBeat.objective || null;
    }
    return next;
}

// STAGE_B_EVOLVE_GOAL=true 的 stage-B 提交：用一条【已编好的】新拍（新 goal / seed / objective + 重建注入）整体替换
// 当前拍，停在【同一路标】、不前进（beat 由 buildCompiledBeat 据同一 active 路标产出 → waypointId 不变，故揭晓 / 下次
// 核验始终对准【最新】幕后 goal）。标 stage='B'（一程上限：下一次 unsure 仍走 quiet-advance、不困住玩家）。纯函数、不改入参。
function arcCommitStageBEvolve(arc, beat) {
    const next = cloneArc(arc);
    next.currentBeat = Object.assign({}, beat, { stage: 'B' });
    return next;
}

// 完成当前拍 → 推进到下一路标并用 stub 编下一拍；没有更多路标则弧线结束（currentBeat=null →
// isArcComplete）。返回新弧线对象（不改入参）。这是【确定性 stub 路径】——单测与离线兜底用；
// 线上 arcComplete 走真编译器（见 runCompileTransition）。
function arcAdvance(arc, now, outcome) {
    const nextWp = arcPeekNext(arc);
    if (!nextWp) {
        const done = cloneArc(arc);
        const cur = done.waypoints[done.cursor];
        if (cur) cur.status = 'done';
        if (arc.currentBeat) done.revealed.push(arcResolvedRecord(arc.currentBeat, outcome || 'done'));
        done.cursor = done.waypoints.length;   // past the end
        done.currentBeat = null;               // throughline resolved -> arc complete
        return done;
    }
    return arcCommitAdvance(arc, stubCompileBeat(arc, nextWp, 0, now), outcome);
}

// 「换个思路」stub 路径：同一路标重编一条不同路线（variant++）。返回新弧线对象（不改入参）。
function arcReroll(arc, now) {
    const wp = arc.waypoints[arc.cursor];
    if (!wp) return cloneArc(arc);
    const variant = ((arc.currentBeat && arc.currentBeat.variant) || 0) + 1;
    return arcCommitReroll(arc, stubCompileBeat(arc, wp, variant, now));
}

// 逐拍切换强度（仅透明用）：改 currentBeat.intensity 并重建 injectedText。返回新弧线对象。
function arcSetIntensity(arc, intensity) {
    if (!arc || !arc.currentBeat || !ADVISOR_INTENSITIES[intensity]) return arc;
    const next = cloneArc(arc);
    next.currentBeat.intensity = intensity;
    next.currentBeat.injectedText = buildDirectiveRaw({
        goal: next.currentBeat.goal, seed: next.currentBeat.seed, intensity, depiction: true,
    });
    return next;
}

// 弧线塑形（layer 6）：设软性节奏意图。非法值回落 null（= 自动）。纯函数——不动 currentBeat /
// 注入，shaping 只着色【未来】的编译过渡（见 buildCompilerMessages）。返回新弧线对象。
function arcSetShaping(arc, shaping) {
    if (!arc) return arc;
    const next = cloneArc(arc);
    next.shaping = (shaping === 'building' || shaping === 'climaxing') ? shaping : null;
    return next;
}

// ---- 集成层（副作用：元数据 + 注入 + 渲染 + 提示）----

// 采用一条弧线（XOR：清掉任何单拍方案）。先用 stub 第一拍立刻显示方案条，再让真编译器把第一拍
// 升级为编译版（失败则保留 stub 第一拍 + 留「重试」）。
function adoptArc(spec) {
    if (!ENABLE_ARC) return;
    if (getPlan()) setPlan(null);                 // 互斥：弧线取代单拍
    const arc = buildArc(spec, chatMsgCount());
    if (!arc.waypoints.length) { addSystemNote('弧线至少需要一个路标。'); return; }
    if (!setArc(arc)) { addSystemNote('无法保存弧线：当前似乎没有打开任何聊天。'); return; }
    const ok = applyPlanInjection();
    renderPlanBar();
    if (!ok) { addSystemNote('弧线已保存，但当前 SillyTavern 不支持注入接口——引导不会生效。'); return; }
    addSystemNote(`已创建${arc.mode === 'blind' ? '盲盒' : '透明'}弧（⚠ 弧线系统仍是实验性功能）。正在编译第一拍…`);
    runCompileTransition({
        arc, waypoint: arc.waypoints[arc.cursor], kind: 'first',
        toast: '正在编译第一拍…',
        onBeat: (a, beat) => arcCommitReroll(a, beat),
        // 盲盒安全：第一拍就绪提示只露玩家可见 objective，绝不露幕后 goal（透明时 objective 为空 → 回落 goal）。
        okNote: (beat) => `第一拍就绪：${arcVisibleObjective(beat) || beat.goal}`,
    });
}

// 盲盒留空路标 → 先按篇幅暗中起草整条骨架，成功后照常采用；失败则提示用户手填 / 查连接。
async function adoptArcWithDraftedWaypoints(spec) {
    if (!ENABLE_ARC) return;
    addSystemNote('路标留空——正在按篇幅为这条盲盒弧暗中拟定路标…');
    const tt = arcToast('正在拟定弧线骨架…');   // ST 通知（与「编译一拍」一致——此前唯独起草骨架这步没在酒馆里提示）
    let wps = null;
    try { wps = await draftWaypoints(spec); } catch (e) { wps = null; }
    arcClearToast(tt);
    if (!wps || !wps.length) {
        addSystemNote('自动拟定路标没成功（可能连不上模型或没解析出来）。可在弧线表单里手填至少一个路标，或检查连接后再试。');
        return;
    }
    adoptArc({ ...spec, waypoints: wps });
}

// 「完成」当前拍 → 真编译器编下一拍后推进；走完贯穿线则整条结束并拆卸（无需编译）。
async function arcComplete() {
    const arc = getArc();
    if (!arc || arcCompiling) return;
    const nextWp = arcPeekNext(arc);
    if (!nextWp) {
        setArc(null);
        applyPlanInjection();   // clears the injection
        clearArcRetry();
        renderPlanBar();
        addSystemNote('这条弧线的贯穿线已走完——引导停止，主聊天恢复原状。');
        return;
    }
    await runCompileTransition({
        arc, waypoint: nextWp, kind: 'advance',
        toast: '正在编译下一拍…',
        onBeat: (a, beat) => arcCommitAdvance(a, beat, 'done'),
        okNote: (beat) => `这一拍落地了，推进到下一拍：${beat.goal}`,
    });
}

// 「换个思路」：真编译器为同一路标编一条不同路线。
async function arcRerollBeat() {
    const arc = getArc();
    if (!arc || arcCompiling) return;
    const wp = arc.waypoints[arc.cursor];
    if (!wp) return;
    const variant = ((arc.currentBeat && arc.currentBeat.variant) || 0) + 1;
    await runCompileTransition({
        arc, waypoint: wp, kind: 'reroll', variant,
        toast: '正在换条路线…',
        onBeat: (a, beat) => arcCommitReroll(a, beat),
        okNote: (beat) => `换了条路线：${beat.goal}`,
    });
}

// 逐拍强度切换（透明）。
function arcSetActiveIntensity(intensity) {
    const arc = getArc();
    if (!arc) return;
    const next = arcSetIntensity(arc, intensity);
    setArc(next);
    applyPlanInjection();
    renderPlanBar();
}

// 弧线节奏切换（透明 + 盲盒）。只落元数据 + 重渲染——不调 applyPlanInjection（shaping 不动当前注入，
// 只影响下一次编译过渡）。
function arcSetActiveShaping(shaping) {
    const arc = getArc();
    if (!arc) return;
    setArc(arcSetShaping(arc, shaping));
    renderPlanBar();
}

// 硬退出整条弧线：清元数据 + 清注入 + 主聊天恢复原状（确认对话框在 layer-2 UI 层）。
function arcExit() {
    const arc = getArc();
    if (!arc) return;
    setArc(null);
    applyPlanInjection();
    clearArcRetry();
    renderPlanBar();
    addSystemNote('已退出弧线——引导停止，主聊天恢复原状。');
}

/* ---- 盲盒模式生命周期（layer 4）：玩家只见 objective；✓ 揭晓 + 推进，✗ 失败吸收，🚫 换任务 ---- */

// 揭晓一拍的幕后（事后「原来背后在做这个」时刻）。仅在确实推进 / 收束时调用。
function arcReveal(beat) {
    if (!beat) return;
    const lines = ['🎭 揭晓 —— 这一拍的幕后：'];
    if (beat.objective) lines.push(`· 你看到的任务：${beat.objective}`);
    lines.push(`· 我幕后在推动的：${beat.goal}`);
    if (beat.seed) lines.push(`· 起始迹象：${beat.seed}`);
    if (beat.why) lines.push(`· 为什么这样安排：${beat.why}`);
    addSystemNote(lines.join('\n'));
}

// ✓ 目标已达成（layer-4 细化：置信门控 + 阶段 B）。先发一次独立的轻量核验调用判定幕后 goal 是否真的兑现，
// 再据 arcDecideOnAchieve 三分：yes → 揭晓+前进；不确定且非 stage B → 置 stage B（不揭晓、不前进）；
// 不确定且已 stage B → 静默前进（不揭晓）。守住「不确定一律不揭晓」，且绝不把玩家困在同一拍。
async function arcMarkAchieved() {
    const arc = getArc();
    if (!arc || arcCompiling || arc.mode !== 'blind') return;
    const nextWp = arcPeekNext(arc);
    // 常见路径（有下一路标）：把【核验 + 编下一拍】合并成一次 self-branch 调用（省掉一份 transcript+stat）。
    if (nextWp) { await arcAchieveMerged(arc, nextWp); return; }

    // —— 末路标（少见、一次性）：沿用「独立核验轻调用 → 收束 / 末路标延伸任务」。 ——
    const resolved = arc.currentBeat;
    const stamp = arcStamp(arc);
    arcCompiling = true; clearArcRetry(); setArcBusyUI(true);
    const tt = arcToast('正在确认这一拍是否真的落地…');
    let verdict = 'unsure';
    try { verdict = await checkBeatFulfilled(arc); } catch (e) { verdict = 'unsure'; }
    arcClearToast(tt);
    arcCompiling = false;
    // 并发守卫：核验期间用户可能切了聊天 / 改了弧线。
    const cur = getArc();
    if (!cur || arcStamp(cur) !== stamp) { setArcBusyUI(false); renderPlanBar(); return; }
    const decision = arcDecideOnAchieve(cur, verdict);
    if (decision === 'stage-b') {
        // 末路标也可延迟兑现（不揭晓、不前进）。STAGE_B_EVOLVE_GOAL：用新拍重建注入、朝同一路标推近；否则保持同一 goal、只换任务。
        const wp = arcActiveWaypoint(cur);
        await runCompileTransition({
            arc: cur, waypoint: wp, kind: 'stageB',
            toast: '看起来还差一口气——再给一个推进任务…',
            onBeat: (a, beat) => STAGE_B_EVOLVE_GOAL ? arcCommitStageBEvolve(a, beat) : arcCommitStageB(a, beat.objective),
            okNote: (beat) => STAGE_B_EVOLVE_GOAL
                ? `换个方向再推近一步：${beat.objective || beat.goal}`
                : `这一步好像还没完全落地，再往前推一下：${beat.objective || '（继续推进）'}`,
        });
        return;
    }
    // reveal-advance / quiet-advance 但没有下一路标 → 收束（揭晓仅在 yes 时）。
    const confident = decision === 'reveal-advance';
    if (confident) arcReveal(resolved);
    setArc(null); applyPlanInjection(); clearArcRetry(); renderPlanBar();
    addSystemNote(confident
        ? '盲盒弧线的贯穿线已走完——引导停止，主聊天恢复原状。'
        : '这条盲盒弧线到此为止（这一拍是否完全落地我不太确定，就不揭晓了）——引导停止，主聊天恢复原状。');
}

// ✗ 目标失败：不揭晓（幕后没兑现），把失败当素材编下一拍并推进；最后一拍失败则到此为止。
async function arcMarkFailed() {
    const arc = getArc();
    if (!arc || arcCompiling || arc.mode !== 'blind') return;
    const nextWp = arcPeekNext(arc);
    if (!nextWp) {
        setArc(null); applyPlanInjection(); clearArcRetry(); renderPlanBar();
        addSystemNote('这条盲盒弧线到此为止——引导停止，主聊天恢复原状。');
        return;
    }
    await runCompileTransition({
        arc, waypoint: nextWp, kind: 'advance', failed: true,
        toast: '把这次失败编进下一拍…',
        onBeat: (a, beat) => arcCommitAdvance(a, beat, 'failed'),
        okNote: (beat) => `失败也是素材，下一拍的任务：${beat.objective || beat.goal}`,
    });
}

// 🚫 换个目标：偏好信号、非失败。同一路标重编一个不同的任务（不推进）。
async function arcRejectObjective() {
    const arc = getArc();
    if (!arc || arcCompiling || arc.mode !== 'blind') return;
    const wp = arc.waypoints[arc.cursor];
    if (!wp) return;
    const variant = ((arc.currentBeat && arc.currentBeat.variant) || 0) + 1;
    await runCompileTransition({
        arc, waypoint: wp, kind: 'reroll', variant,
        toast: '换个任务…',
        onBeat: (a, beat) => arcCommitReroll(a, beat),
        okNote: (beat) => `换了个任务：${beat.objective || beat.goal}`,
    });
}

/* ------------------------------------------------------------------ *
 * 弧线编译器（layer 3）—— 每次过渡【一次】结构化 LLM 调用，把目标路标编成一拍。
 * 纯部分（parseArcBeat / buildCompiledBeat）可单测；异步部分（callCompiler /
 * compileBeatWithRetry / runCompileTransition）走现有连接（direct/profile）+ 3 次重试 +
 * toastr 进度 + 并发守卫（编译在途禁重入；只在弧线身份未变时提交结果）+ 失败保留当前注入。
 * stubCompileBeat 仍是离线 / 单测的确定性替身，形状与 buildCompiledBeat 一致。
 * ------------------------------------------------------------------ */
// 编译器系统提示（CoT 版，2026-06-14 committed）：mode-agnostic 生成思维链（定位→清点→信息地图→此刻与转场→
// 把拍写好看→质量自检），透明弧单用本提示即完整。盲盒的玩家 objective【不在思考里挑】——思考只管 goal/seed/戏剧，
// objective 留到输出区一次写定（见 BLIND_COMPILER_ADDENDUM；2026-06-16 起，详见下方附录注释）。
// 经渲染台 + 冷代理盲评打磨（关联/惊喜/赌注质量较无 CoT 版显著提升；见 CLAUDE.md「Arc prompt tuning」）。
const COMPILER_SYSTEM_PROMPT =
`你是「故事神谕·剧情参谋」的弧线编译器。把【标了"要编译这个"的那个路标】编成一拍可注入主聊天的幕后引导：
先在 <arc_think> 里按步推演，再输出正式 <ArcBeat>（盲盒还要在它之前先输出抛弃式 <ObjectiveDraft>，见下方【盲盒附录】）。

═══ 思维（写在 <arc_think>…</arc_think> 内，务必简短）═══
按步推演，不跳步、不解释自检过程。【绝不可】在 <arc_think> 内写出 <ArcBeat> / <ObjectiveDraft> 任何正式标签——它们只在 </arc_think> 之后输出。
【一遍成稿·铁律】每步只写一条结论、≤2 句；想到第一个站得住的方案就定下来，把「挑选」全部交给最后一步质量自检。【禁止】在思考里列举多个备选拍（不写「更好的想法是…／或者…／换个角度…」之类）、【禁止】推翻已写的步骤重来、【禁止】来回重读剧情反复权衡。整段思考约 ≤800 字，写完质量自检立即输出 </arc_think>，不再续写。

【目标—任务耦合·别钻牛角尖】objective 是玩家亲手做的【触发动作】，goal 是它引发的【后果 / 真相】。二者【不必同一拍内同时成立】，玩家也【不必亲手造成】goal——只需 objective 是【点燃它的引线】、存在一条看得见的因果线。① 后果可【延迟】：玩家做完 objective 后过一两次回复、或经一个延伸任务（stage B 载体拍）才落地，这是常态，别为「这动作如何当场促成 goal」反复推翻重来。② 后果可发生在【玩家不在场处】：主聊天叙事者已被授权在玩家触发【之后】用切视角 / 旁白 / 让结果找上门（信件·消息·传唤）把它演进正文。所以 goal 照写真实剧情后果（哪怕是别处的会议·决定·远方事件），不必硬塞进一个玩家在场的场景。

步骤1（定位）：一句话点出贯穿线，以及这一拍在弧线里的位置与角色（user 已给「弧线角色」：早期铺垫 / 中期升温 / 倒数第二最艰难 / 末拍高潮），据角色定这一拍的张力档位。弧线形状适用于【所有难度】——即便最低赌注层级（如平和）张力也随位置升级，但绝不越出本难度该有的赌注层级（绝不为制造高潮而引入本难度不该有的更重 / 不可逆后果）。节奏可动态：已被剧情自然拉近的路标可合并，张力不足可插一个低赌注喘息拍；拍数不固定，弧线在贯穿线解决时才结束。
步骤2（清点素材）：从【世界书 + 至今剧情】尽量【充分】清点可用素材，分两堆——(a) 已确立的人物 / 关系 / 既定事实 / 当前状态；(b) 已埋下却未兑现的伏笔 / 悬而未决的线头。这是【漏斗不是过滤网】：相关素材尽量捞全，后面在这堆上选；需要别的既定细节随时回去取（只要是这个故事里已有的）。
步骤3（信息地图）：列出 {{user}} 与各相关角色【分别】知道 / 不知道 / 误以为什么——这是抉择与张力的引擎。
步骤4（此刻与转场）：先读【最近剧情】——此刻人在哪、在场谁、情绪温度、{{user}} 刚做了什么；这一拍要从这个当下【长出来】，不是凭空跳一个新场景。再遵从 user 给的转场指示（换路线 / 失败吸收 / 延伸任务 / 节奏意图，若有）。
步骤5（把这一拍写好看）：用一种戏剧手法（反转 / 倒计时 / 假黎明 / 被迫的代价抉择）塑形。素材须【植根于本故事】——步骤2–3 清点出的元素及其背后的完整剧情 / 世界书。【可以引入新人物 / 新事物】，但它必须兑现某条既定线头、或是某条既定事实的合理后果——在思考里【点名它兑现了哪条线头】（「失散的师兄登场」兑现「大弟子下落成谜」＝合格；凭空冒出、谁都接不上的新反派＝不合格）。绝不引入与世界观 / 既定事实矛盾的内容。先想这一拍【最俗套】的写法，然后避开它。${ENABLE_TYPE_ROTATION ? '类型【尽量】与 user 给的【最近几拍类型】不同（移动 / 战斗 / 社交 / 调查 / 获取 / 抉择 / 生存 / 创造 / 欺骗 / 守护）——但【自然第一】：若这一拍最贴切的写法恰好落回最近用过的某一类，直接接受、别为换而换，更不要凭空给某个类型设「保留 / 不能用」的限制。' : ''}
步骤6（盲盒玩家 objective —— 【不在思考里挑】）：盲盒的玩家 objective【不在 <arc_think> 里推敲、不在这里挑选】——思考只把这一拍的 goal / seed / 戏剧写好；objective 留到 </arc_think> 之后、在输出区按【盲盒附录】【一次写定】（它是个精简的玩家动作、不是需要反复打磨的深度创作，放进思考里反复挑只会空转、还会撑爆思维预算）。透明弧无 objective，跳过本步。
步骤7（质量自检·不过则重写，不要解释自检过程）：赌注（{{user}} 在意的东西处于风险中，量级按 user 给的难度 / 强度，绝不越级、绝不碰红线）/ 能动性（迫使有意义的选择或行动）/ 关联性（回收已有角色·线索·既定事实，绝不凭空降落）/ 惊喜（含路标未点明的新信息，只复述路标则不合格）；${ENABLE_TYPE_ROTATION ? '类型已轮换、' : ''}与当前 stat 不矛盾（盲盒玩家 objective 的不剧透改在输出区的两稿法把关，不在思考里挑）。

═══ 输出（</arc_think> 之后）═══
只输出一个 <ArcBeat> 区块（盲盒在它之前先输出抛弃式 <ObjectiveDraft>，见附录），逐行「键: 值」，不要多余解释：
<ArcBeat>
goal: 一句话、结果式、可执行的引导目标（写结果，不写过程 / 台词 / 分步）
type: 这一拍玩家要做的事属于哪一类，从 移动 / 战斗 / 社交 / 调查 / 获取 / 抉择 / 生存 / 创造 / 欺骗 / 守护 里选一个
seed: 这一步最初显露的一个具体而轻巧的迹象
why: 为什么贴合此刻（呼应了哪条伏笔 / 关系 / 既定事实）
</ArcBeat>
全程简体中文。`;

let arcCompiling = false;        // 编译在途守卫（禁重复点击 / 重入）
let arcRetryPending = null;      // 上次失败的过渡（供方案条「重试」按钮）
let arcCompileError = '';        // 上次编译失败的【人话原因】（供失败提示 / 可复制系统记录；成功时清空）

// 盲盒难度 = 赌注货币（弧线级、固定；见 consent）。三档同样有趣，区别在赌注层级与可逆性。
// label/caption 供 UI（徽章 + 表单选项）；amp 是 layer-5 振幅缩放指令，注入盲盒编译调用，让难度
// 真正改变所写赌注的量级（见 buildCompilerMessages）。
const ADVISOR_DIFFICULTIES = {
    calm:   { label: '平和', caption: '社交 / 情感赌注，无不可逆',
        amp: '赌注限于社交 / 情感层面（尴尬、误会、心结、错过）；绝不引入任何不可逆后果，最坏的局面也始终可挽回。',
        failAmp: '失败只是温和的挫折——一时的尴尬、错过、难为情，绝无持久或不可逆的代价，很快就能挽回。' },
    normal: { label: '常规', caption: '实质后果，可恢复（输战斗 / 失宝物 / 丢盟友）',
        amp: '可有实质后果——输掉一场冲突、失去一件要紧之物、一个盟友疏远——但都必须【可恢复 / 可逆转】，不动存在级根基。',
        failAmp: '失败有真实但【可恢复】的代价（输了、丢了、关系一时紧张）；下一拍要从这份损失里自然长出来，而不是一笔勾销。' },
    stark:  { label: '凛冽', caption: '存在级、不可逆的重大抉择（不一定是死亡）',
        amp: '可推动存在级、不可逆的重大抉择（一扇门永远关上 / 一段关系永久终结 / 一个有约束力的承诺）——但巨大代价必须【购买】对等的巨大回报，苦难必须有意义、绝不无谓残忍；任何不可逆转折发生【之前】，务必先给玩家一个知情的抉择点（他随时可一键退出）。',
        failAmp: '失败可有真实、乃至不可逆的代价，但【必须同时开辟一条对等的新路径】——是改道而非死胡同，更不是无谓的惩罚；这份苦难仍要有意义。' },
};

// 弧线塑形（layer 6）= 软性用户节奏意图（弧线级，可随时改；null = 自动位置感知塑形）。label 供 UI 分段
// 控件；hint 是注入编译调用的节奏指令（让用户的「还想继续 / 开始收束」着色未来的拍）。
const ADVISOR_SHAPING = {
    building:  { label: '还想继续', hint: '【用户节奏意图：还想继续】别急着收束——可以铺垫 / 升温 / 在重拍之间插入一个低赌注的喘息拍，把张力慢慢积累，这一拍不要逼近高潮。' },
    climaxing: { label: '开始收束', hint: '【用户节奏意图：开始收束】加速朝贯穿线的解决推进——提高赌注、把已被剧情自然拉近的路标合并推进、准备最艰难的抉择与高潮收束，不要再铺垫新支线。' },
};

// 盲盒模式编译附加（layer 4）：在 <ArcBeat> 里多产出一行 objective（玩家可见任务，不剧透），goal 仍是幕后真相。
// **2026-06-16 重构（Edwin 真实 ST 实测：Opus 4.6 thinking 在 objective 上反复自我打架——"太简单/太被动/太日常/玩家
// 不理解"——撑爆 <arc_think> 预算直至截断）**：把 objective【整个移出 <arc_think>】，在输出区【一次写定】。objective 不再
// 是"在思考里反复打磨的深度创作"，而是一个【玩家从此刻、凭自己看得见的理由会去做、又恰好点燃 goal 的动作】（player-motivated
// from the current moment；不再要求"最小/smallest"——那本身是个可被 fight 的轴）。非剧透由保留在【输出区】的两稿法
// （plain→masked，不占思维预算）把关。诊断与设计推演见设计文档 §10「2026-06-16 objective 出思考块」。
// 注：本附录与 ACHIEVE_SYSTEM_PROMPT 的 objective 段同源——【改一处同步另一处】。
const BLIND_COMPILER_ADDENDUM =
`【盲盒附录】本弧线是「盲盒」：玩家只看得到 objective（任务），看不到 goal / 幕后指令。goal / seed / why 照旧在 <arc_think> 里随这一拍想好（goal 就是要隐瞒的幕后真相）。但【玩家 objective 不在 <arc_think> 里推敲】——思考只管把 goal / seed / 戏剧写好；objective 留到 </arc_think> 之后、在输出区【一次写定】（它是个玩家动作、不是需要反复打磨的深度创作，放进思考里反复挑选只会空转、还会撑爆思维预算）。

什么是好的盲盒 objective：一个 {{user}} 从【此刻的处境】出发、凭他【自己看得见的理由】（他看不到幕后 goal）就会去做的行动——它既是玩家自有动机的动作，又恰好【点燃】幕后 goal（如「赴约」＝想要答案、「陪她走回家」＝担心她、「把信交给她」＝在送信、「走进那扇门」＝在探路）。一个【只有知道幕后秘密才讲得通】的动作（如无端「脱掉外套」「站到窗边」）是【坏】objective——玩家看不到秘密、根本不会去做，goal 就永远触发不了。
objective 始终是 {{user}}【自己亲手做】的动作，【不是别的角色（NPC）的动作、也不是"看着某事发生"】——这一点最容易在【幕后 goal 是某个 NPC 的内在变化 / 反应】时搞错：goal 尽可以是那个 NPC 的内心越界、转变、或别处 / 离屏发生的事，但 objective 永远是 {{user}} 亲手做的、点燃它的【那一下】（写错成 NPC 的动作＝玩家根本无从执行）。例：幕后是「她在独处中越界」，objective 是 {{user}} 做的「放学后陪她走回家」「找她单独说话」，绝不是「她靠过来」「她替你整理衣领」。

它【可大可小、可主动可被动、可日常】：戏剧高潮 / 赌注 / 不可逆的分量【全在 goal / seed / 难度】，objective 只是那个玩家自有动机、点燃 goal 的行动。【绝不可】因为它「太简单 / 太被动 / 不够特别 / 太日常」就推翻另找——只要它是玩家从此刻、凭自己看得见的理由会做的【一个】动作（不是「X 或 Y」、不是一串并列），又能点燃 goal，就【直接写定】。把动作【本身】写出来就好，别把特定时间 / 地点 / 场合钉进 objective（那些是布景、进 seed）。

输出顺序（</arc_think> 之后，一次写定、不回头改）：先 <ObjectiveDraft>（plain＝把这一拍连后果 / 意义直白摊开；masked＝把所有后果 / 意义 / 评判词抹掉，只留玩家亲手做的那个动作——两稿随后被系统整段丢弃，玩家永远看不到，这一步是【强制去剧透】、不是再挑动作），再 <ArcBeat>（在 goal / type / seed / why 之外多写一行 objective ＝ masked 的那个动作）。绝对服从 user 给出的【红线】与【难度 / 赌注层级】。
<ObjectiveDraft>
plain: …（连后果摊开）
masked: …（抹掉后果，只留玩家做的动作）
</ObjectiveDraft>`;

// 置信门控核验（layer-4 细化）：玩家点了「✓ 达成」时，单独发这一调用判定幕后 goal 是否真的兑现。
// 从严：宁可 unsure 也绝不假阳性（假阳性会提前剧透、摧毁盲盒信任）。输出仅一个 <ArcCheck> 区块。
const CHECK_SYSTEM_PROMPT =
`你是「故事神谕·剧情参谋」的盲盒兑现核验器。玩家刚点了「目标已达成」。你要判断：这一拍【幕后真正想促成的事】
在最近剧情里是否已经真正发生——以文本里确有其事为准，不看玩家声称。

判定从严，宁可「不确定」也绝不假阳性（假阳性会提前剧透、摧毁盲盒信任）：
- yes：最近剧情里幕后目标已明确、确凿地兑现。
- unsure：迹象不足 / 刚起头 / 只是接近——只要不确凿，就选这个。
- no：剧情明确朝相反方向走，幕后目标没有兑现。

只输出一个 <ArcCheck> 区块（逐行「键: 值」，不要多余解释）：
<ArcCheck>
fulfilled: yes | unsure | no
reason: 一句话依据
</ArcCheck>
全程简体中文。`;

// 解析一个 <ArcBeat> 区块（取第一个；无 goal 视为失败）。纯函数，可单测。
function parseArcBeat(text) {
    // 容忍模型漏写 / 截断闭标签（真实模型偶发——deepseek-v4-pro 实测见过漏 </…>）：先按闭合配，配不到再从开标签取到结尾。
    let m = String(text || '').match(/<ArcBeat>([\s\S]*?)<\/ArcBeat>/i);
    if (!m) m = String(text || '').match(/<ArcBeat>([\s\S]*)$/i);
    if (!m) return null;
    const inner = m[1];
    const get = (keys) => {
        for (const k of keys) {
            const r = new RegExp('^\\s*' + k + '\\s*[:：]\\s*(.+)$', 'mi');
            const mm = inner.match(r);
            if (mm && mm[1].trim()) return mm[1].trim();
        }
        return '';
    };
    const goal = get(['goal', '目标']);
    if (!goal) return null;
    return {
        goal,
        seed: get(['seed', '起始迹象', '迹象', '种子']),
        why: get(['why', '契合点', '理由']),
        objective: get(['objective', '玩家目标', '目标任务']),
        type: get(['type', '类型', '类别']),                       // #3 类型轮换
    };
}

// 解析一个 <ArcCheck> 区块 → { verdict: 'yes'|'unsure'|'no', reason }。纯函数，可单测。
// 解析不出区块 / 拿不准一律回 'unsure'（安全默认 = 绝不假阳性提前揭晓）。判定次序刻意为
// unsure → no → yes，避免「未兑现」被「兑现」误命中为 yes。
function parseArcCheck(text) {
    let m = String(text || '').match(/<ArcCheck>([\s\S]*?)<\/ArcCheck>/i);
    if (!m) m = String(text || '').match(/<ArcCheck>([\s\S]*)$/i);   // 容忍漏写 / 截断闭标签
    if (!m) return null;
    const inner = m[1];
    const fm = inner.match(/^\s*(?:fulfilled|结论|判定|兑现)\s*[:：]\s*(.+)$/mi);
    const raw = (fm ? fm[1] : '').trim().toLowerCase();
    let verdict;
    if (!raw || raw.includes('unsure') || raw.includes('不确定') || raw.includes('不清楚') || raw.includes('待定')) {
        verdict = 'unsure';
    } else if (/\bno\b/.test(raw) || raw.includes('否') || raw.includes('未') || raw.includes('没有') || raw.includes('false')) {
        verdict = 'no';
    } else if (/\byes\b/.test(raw) || raw.includes('是') || raw.includes('已兑现') || raw.includes('兑现') || raw.includes('达成') || raw.includes('true')) {
        verdict = 'yes';
    } else {
        verdict = 'unsure';
    }
    const rm = inner.match(/^\s*(?:reason|理由|依据)\s*[:：]\s*(.+)$/mi);
    return { verdict, reason: rm ? rm[1].trim() : '' };
}

// 从解析结果构建一拍（形状与 stubCompileBeat 一致，便于 arcCommit* 通用）。纯函数，可单测。
function buildCompiledBeat(arc, waypoint, parsed, opts) {
    const o = opts || {};
    const inherit = (arc.currentBeat && arc.currentBeat.intensity) || 'normal';
    const intensity = ADVISOR_INTENSITIES[inherit] ? inherit : 'normal';
    const goal = parsed.goal;
    const seed = parsed.seed || '';
    return {
        waypointId: waypoint.id,
        title: waypoint.intent,
        goal,
        seed,
        why: parsed.why || `推进路标「${waypoint.intent}」`,
        type: parsed.type || '',                   // #3 类型轮换：编译器标注，喂回避免连续同类
        objective: arc.mode === 'blind' ? (parsed.objective || null) : null,  // 盲盒玩家目标（layer-4 精化）
        intensity,
        injectedText: buildDirectiveRaw({ goal, seed, intensity, depiction: true }),
        variant: Number(o.variant) || 0,
        stage: null,
        objectiveB: null,
        beatAdoptedAt: Number(o.now) || 0,
        reminded: false,
    };
}

// 有界剧情：喂给编译器的最近 n 条（夹在 8..40），自本拍开始以来——长对话下仍廉价。
function compilerTranscript(ctx, s, n) {
    const turns = buildTranscriptTurns(ctx, { ...s, contextDepth: -1 });
    const k = Math.min(40, Math.max(8, Number(n) || 8));
    return turns.slice(-k).map((t) => `${t.name}: ${t.text}`).join('\n\n');
}

// #3 最近几拍的【类型】：当前拍（即将被替换）在最前，再往 revealed 末尾取，最多 3 个、滤空。纯函数。
// 光在 prompt 里叮嘱「别重复类型」却不给类型 = 形同虚设；这把实际类型喂回去，让轮换真正机械可靠。
function recentBeatTypes(arc) {
    const types = [];
    const push = (t) => { if (t && String(t).trim()) types.push(String(t).trim()); };
    if (arc && arc.currentBeat) push(arc.currentBeat.type);
    const rev = (arc && Array.isArray(arc.revealed)) ? arc.revealed : [];
    for (let i = rev.length - 1; i >= 0 && types.length < 3; i--) push(rev[i] && rev[i].type);
    return types;
}

// 编译器 user 消息里的【条件性过渡指示段】。纯函数（只读 arc/waypoint/opts，不碰 ctx）= 可单测。
// 收纳 #3 类型轮换、#4 换路线（盲盒保 goal / 多次换后可跳过重塑）、#5 失败后果按难度、layer-6 塑形、
// 延迟兑现 stage B。返回字符串数组，由 buildCompilerMessages 拼进 user 上下文。
function buildTransitionDirectives(arc, waypoint, opts) {
    const o = opts || {};
    const blind = arc.mode === 'blind';
    const out = [];

    // #3 类型轮换：把最近几拍的实际类型喂回去，要求换一类。ENABLE_TYPE_ROTATION=false（实验）→ 不喂回、不出该段。
    const recent = ENABLE_TYPE_ROTATION ? recentBeatTypes(arc) : [];
    if (recent.length) {
        out.push(`【类型轮换】最近几拍的类型依次是：${recent.join(' / ')}。这一拍【尽量】换一类（移动 / 战斗 / 社交 / 调查 / 获取 / 抉择 / 生存 / 创造 / 欺骗 / 守护）。但【自然第一】：若这一拍最贴切的写法恰好落回上面某一类，就直接接受、按自然来，别为换而换、别凭空给某类型设「保留 / 不能用」的限制。`);
    }

    // #4 换路线（reroll）。盲盒：保持幕后 goal 不变、只换玩家 objective。多次换同一路标（variant≥2，
    // 即第 3 次起）→ 弧线向用户弯曲：允许编译器干脆跳过 / 重塑这个路标。
    if (o.reroll) {
        const nth = (Number(o.variant) || 1) + 1;
        const lines = [`【换路线】这是为「${waypoint.intent}」第 ${nth} 次换路线，请给出与之前明显不同的一条路径。`];
        if (blind && arc.currentBeat && arc.currentBeat.goal) {
            lines.push(`【盲盒·保持幕后目标】幕后真正要促成的事【不变】（仍是：${arc.currentBeat.goal}）——只换一个通往它、且与上次明显不同的玩家 objective，绝不改动 goal。`);
        }
        if ((Number(o.variant) || 0) >= 2) {
            lines.push('【已多次换路线】玩家显然对这个路标本身不买账：你可以干脆【跳过或重塑】它——把它理解得更宽松、或合并进下一段推进，给一拍绕开 / 改造该路标、直接朝贯穿线走的引导，并在 why 里说明为何这样更顺。');
        }
        out.push(lines.join('\n'));
    }

    // #5 失败吸收，后果量级随难度（calm 温和 / normal 真实可恢复 / stark 真实但开辟对等新路）。
    if (o.failed) {
        const lines = ['【上一拍失败】玩家试了但没做到——把这次失败当作素材，让下一拍从搞砸的局面里自然生长，不要无视它。'];
        if (blind && arc.consent) {
            const diff = ADVISOR_DIFFICULTIES[arc.consent.difficulty] || ADVISOR_DIFFICULTIES.normal;
            if (diff.failAmp) lines.push(`失败后果的量级按当前难度【${diff.label}】定：${diff.failAmp}`);
        }
        out.push(lines.join('\n'));
    }

    // 延迟兑现 stage B（盲盒）。STAGE_B_EVOLVE_GOAL：重拟更贴近的 goal、朝同一路标推近；否则（原行为）保持同一 goal、只换任务。
    if (o.stageB) {
        out.push(STAGE_B_EVOLVE_GOAL
            ? '【再推近一步（stage B）】玩家完成了上一个任务，但这一拍的幕后还没落地。请【重新拟定一个更贴近的幕后 goal】（连同 seed），让它仍服务【同一个路标】、把故事朝它【再推近一步】：收窄 / 具体化上一个 goal，或换一个更直接通向【同一路标终点】的幕后结果（绝不改路标、绝不越级 / 碰红线），并另给一个新的、与上个明显不同的玩家 objective（玩家从此刻、凭自己看得见的理由会做、又点燃 goal 的动作）。不剧透。'
            : '【延伸任务（stage B · 载体拍）】玩家完成了上一个任务，但这一拍的幕后目标还没完全兑现。请【保持同一个幕后 goal 不变】，只给一个新的、更直接推动它兑现的玩家 objective——最好是一个【会把场景推到 goal 落地那一刻】的任务（如幕后是「导师战死」，就给「在这场战斗里活下来」，让战斗自然打完、后果随之落地）。仍可量化、不剧透，并与上个任务明显不同。goal 照常输出（与上一拍一致即可）。');
    }

    // layer 6 软性节奏意图：building 放缓 / climaxing 收束；null 交给位置感知自动塑形。
    if (arc.shaping && ADVISOR_SHAPING[arc.shaping]) {
        out.push(ADVISOR_SHAPING[arc.shaping].hint);
    }
    return out;
}

// 盲盒 consent 区块（风格 / 难度+amp / 方向 / 红线）。纯函数——buildCompilerMessages 与 buildAchieveMessages
// 共用，红线 / 难度文案保持单一来源。无 consent 回空串。
function blindConsentBlock(consent) {
    if (!consent) return '';
    const c = consent;
    const diff = ADVISOR_DIFFICULTIES[c.difficulty] || ADVISOR_DIFFICULTIES.normal;
    const con = ['=== 盲盒设定（consent）==='];
    if (c.style) con.push(`风格偏好：${c.style}`);
    con.push(`难度 / 赌注层级：${diff.label}（${diff.caption}）\n${diff.amp || ''}`);
    if (c.direction) con.push(`大致方向（关于什么，而非发生什么）：${c.direction}`);
    if (Array.isArray(c.redlines) && c.redlines.length) {
        con.push(`【绝对红线 —— 任何 objective / goal 都绝不可触碰】：\n${c.redlines.map((r) => '· ' + r).join('\n')}`);
    }
    return con.join('\n');
}

// 过渡调用（编译 / 核验 / 达成）喂入的剧情记录：COMPILER_FULL_CONTEXT 开 → 全史（与参谋同级）；
// 关 → 有界 clamp（compilerTranscript 的最近 8..40 条，省 token）。三处共用，集中在此切换。
function transitionTranscript(ctx, s, since) {
    if (COMPILER_FULL_CONTEXT) return buildTranscript(ctx, { ...s, contextDepth: -1 });
    return compilerTranscript(ctx, s, since + 2);
}

// 全量匹配（COMPILER_FULL_CONTEXT）下，过渡调用额外喂入的【角色卡 + 世界书】区块（与参谋同级）。
// 返回要拼进 user 上下文的区块数组；clamp 模式或无内容时回空数组。card 受 s.includeCard 约束（与参谋一致）；
// wiStr 由调用方异步取（await buildWorldInfo()）后传入——纯拼装、无副作用。
function fullContextBlocks(ctx, s, wiStr) {
    if (!COMPILER_FULL_CONTEXT) return [];
    const out = [];
    if (s.includeCard) { const card = buildCardSection(ctx); if (card) out.push(card); }
    if (wiStr) out.push('=== 世界书 / 设定 ===\n' + wiStr);
    return out;
}

// 弧线【自身文本】凑成的世界书扫描补充：贯穿线 + 路标意图 + 方向 / 风格。喂给 buildWorldInfo 的
// extraScanText，让「以弧线主题词为关键词的绿条」（如绿条触发词 Alex，弧线讲「Alex 的背叛」）即便最近
// 聊天没提到也能激活，回收休眠伏笔（让过渡调用真正吃到相关 lore）。纯函数、可单测。spec / arc 同形
// （都读 throughline / waypoints / consent），起草器（spec 无 waypoints）与过渡调用（arc 有）共用。
function arcScanText(arc) {
    if (!arc) return '';
    const bits = [];
    if (arc.throughline) bits.push(arc.throughline);
    if (Array.isArray(arc.waypoints)) {
        for (const w of arc.waypoints) {
            const intent = (w && typeof w === 'object') ? w.intent : w;   // buildArc 前是字符串，后是 {intent}
            if (intent && String(intent).trim()) bits.push(String(intent).trim());
        }
    }
    const c = arc.consent || {};
    if (c.direction) bits.push(c.direction);
    if (c.style) bits.push(c.style);
    return bits.join('\n');
}

// 组装编译器消息（system 指令 + user 上下文：弧线 / 最近剧情 / 变量状态 / 已推进的拍）。
// wiStr：全量匹配时由 callCompiler 异步取的世界书（clamp 模式为空串）。
function buildCompilerMessages(arc, waypoint, opts, statStr, wiStr) {
    const ctx = getCtx();
    const s = getSettings();
    const shape = arcShapePosition(arc, waypoint);   // live 位置 + 端锚定角色（不受 skipped / 重构干扰）
    const wpList = arc.waypoints.map((w, i) => {
        const tag = w.id === waypoint.id ? '【要编译这个】'
            : (w.status === 'done' ? '[已完成]' : (w.status === 'skipped' ? '[已跳过]' : '[待办]'));
        return `${i + 1}. ${tag} ${w.intent}`;
    }).join('\n');
    const beatAt = (arc.currentBeat && arc.currentBeat.beatAdoptedAt) || arc.adoptedAt || 0;
    const since = Math.max(0, chatMsgCount() - beatAt);
    const transcript = transitionTranscript(ctx, s, since);
    const revealed = (arc.revealed || []).slice(-6).map((r) => `· ${r.goal}`).join('\n');

    const span = SPAN_FEEL[arc.spanFeel] || SPAN_FEEL.medium;   // #8 把不透明 token 译成标签 + 拍数区间
    const parts = [
        '=== 弧线 ===',
        `贯穿线：${arc.throughline || '（未填）'}`,
        `篇幅感：${span.label}（${span.range}）　·　当前：第 ${shape.index} / ${shape.total} 拍（不含已跳过）　·　本拍的弧线角色：${ARC_SHAPE_ROLES[shape.role]}`,
        `路标列表：\n${wpList}`,
    ];
    for (const b of fullContextBlocks(ctx, s, wiStr)) parts.push(b);   // 全量匹配：角色卡 + 世界书
    if (transcript) parts.push('=== 最近剧情（自本拍开始以来）===\n' + transcript);
    if (statStr) parts.push('=== 当前变量状态（剧情硬事实，方案不得与之矛盾）===\n' + statStr);
    if (revealed) parts.push('=== 已推进过的拍（勿原样重复）===\n' + revealed);
    // 条件性过渡指示段（#3 类型轮换 / #4 换路线 / #5 失败按难度 / stage B / layer-6 塑形）—— 纯函数、可单测。
    for (const d of buildTransitionDirectives(arc, waypoint, opts || {})) parts.push(d);
    // 盲盒：附 consent（难度 / 红线 / 风格 / 方向），并切到带 objective 的盲盒编译指令。
    const blind = arc.mode === 'blind';
    if (blind && arc.consent) parts.push(blindConsentBlock(arc.consent));
    parts.push(blind
        ? '请先输出抛弃式 <ObjectiveDraft>（plain / masked 两稿，随后被系统丢弃），再输出正式的 <ArcBeat>（含 goal / objective / seed / why），编译上面标【要编译这个】的那个路标。'
        : '请只输出一个 <ArcBeat> 区块，编译上面标【要编译这个】的那个路标。');

    const subst = (t) => { try { return ctx.substituteParams(t); } catch (e) { return t; } };
    const sysBase = blind ? (COMPILER_SYSTEM_PROMPT + '\n\n' + BLIND_COMPILER_ADDENDUM) : COMPILER_SYSTEM_PROMPT;
    return [
        { role: 'system', content: subst(sysBase) },
        { role: 'user', content: subst(parts.join('\n\n')) },
    ];
}

// 一次编译调用：取当前变量状态 + 组装消息 + 走现有连接（direct / profile，非流式）。
async function callCompiler(arc, waypoint, opts) {
    const s = getSettings();
    let statStr = '';
    try { const st = await getMvuStatData(); if (st) statStr = JSON.stringify(st, null, 2); } catch (e) { /* no MVU */ }
    let wiStr = '';
    if (COMPILER_FULL_CONTEXT) { try { wiStr = await buildWorldInfo(wiContextMode(s), arcScanText(arc)); } catch (e) { /* no WI */ } }
    const messages = buildCompilerMessages(arc, waypoint, opts, statStr, wiStr);
    const maxTokens = Math.max(Number(s.maxTokens) || 0, ARC_CALL_MAX_TOKENS);
    return await arcCall(messages, maxTokens);   // 护栏 + 实时缓冲 + 流式分发
}

// 红线（雷点）代码侧守卫（layer 5）：编译期 prompt 规避是主防线，这是【廉价的事后启发式守卫】。
// 把每条红线按否定词拆成「主体 + 禁止项」，若禁止项与（存在的）主体在拍子文本里同时命中即判违反。
// 无否定词、或过松（单字禁止项又无主体）则跳过——宁漏不误伤（误伤只会触发一次无谓重编）。
const REDLINE_NEGATIONS = ['不可', '不能', '不得', '不会', '不准', '不许', '绝不', '禁止', '不要', '别', '勿'];
function beatViolatesRedlines(beat, redlines) {
    if (!beat || !Array.isArray(redlines) || !redlines.length) return null;
    const hay = [beat.goal, beat.objective, beat.objectiveB, beat.seed].filter(Boolean).join(' / ');
    for (const rl of redlines) {
        const s = String(rl == null ? '' : rl).trim();
        if (!s) continue;
        // 找最靠前的否定词，拆成 主体（之前）+ 禁止项（之后）。
        let neg = '', idx = -1;
        for (const n of REDLINE_NEGATIONS) {
            const i = s.indexOf(n);
            if (i >= 0 && (idx < 0 || i < idx)) { idx = i; neg = n; }
        }
        if (idx < 0) continue;                         // 无否定词 → 廉价守卫无从判定，交给 prompt 侧
        const subject = s.slice(0, idx).trim();
        const forbidden = s.slice(idx + neg.length).trim();
        if (!forbidden) continue;
        // 过松保护：单字禁止项又无主体（如「不可走」），太容易误伤 → 跳过。
        if (forbidden.length < 2 && !subject) continue;
        const forbiddenHit = hay.includes(forbidden);
        const subjectHit = !subject || hay.includes(subject);
        if (forbiddenHit && subjectHit) return s;      // 返回被违反的那条红线（供日志）
    }
    return null;
}

// 把一次过渡调用的失败归类成【人话原因】——给用户（尤其要把问题转贴给作者的远程用户）一个具体、可操作的
// 原因，替掉黑箱「失败 / 超时 / 已取消」。e = 抛出的错误（HTTP / 网络 / CORS / 中止）；text = 调用返回的原文
//（判空 / 判解析失败）。纯函数（只读 e.name + 文本）→ 可单测。
function arcFailureReason(e, text) {
    if (e) {
        if (arcAborted(e)) return '调用被中止（到了 180s 超时，或你点了「取消」）。长 RP + 思考型模型一拍可能很慢；可关掉「流式」、调高超时容忍，或换更快的模型 / 连接。';
        const m = String((e && e.message) || e || '').trim();
        if (/Failed to fetch|NetworkError|ERR_NETWORK|ERR_CONNECTION|CORS|Access-Control/i.test(m)) {
            return 'direct（直连）模式下浏览器把请求拦了（跨域 CORS 或连不上端点）：' + m.slice(0, 160) +
                '。多数官方端点（含 DeepSeek）不给浏览器返回 CORS 头 → 直连必失败。解决：把「连接方式」改成 ST 的「连接配置档（profile）」走后端中转。';
        }
        return '调用报错：' + m.slice(0, 240);
    }
    if (!text || !text.trim()) {
        return '收到【空回复】（端点返回成功但没有正文）。常见三因：①中转 / 代理无视了「流式」、②思考型模型（Gemini / 反重力等）把额度全用在思考上、正文为空、③额度或风控拦截。可在设置里【关掉「流式」】或【调高「最大生成」】再试。';
    }
    return '收到回复，但【解析不出 <ArcBeat>】（模型没按要求的格式输出）。原文开头：' + text.replace(/\s+/g, ' ').trim().slice(0, 200) + '…';
}

// 编译 + 解析，最多重试 3 次；全部失败返回 null。盲盒还过一道红线代码侧守卫——命中即弃这次重编，
// 三次皆中则返回 null（＝该过渡 fail-safe：保留当前注入 + 方案条「重试」）。
// 末次失败的【人话原因】写进 arcCompileError，供 runCompileTransition 展示（而不是黑箱「失败 / 超时 / 已取消」）。
async function compileBeatWithRetry(arc, waypoint, opts) {
    const redlines = (arc.mode === 'blind' && arc.consent && Array.isArray(arc.consent.redlines))
        ? arc.consent.redlines : [];
    let lastReason = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const text = await callCompiler(arc, waypoint, opts);
            const parsed = parseArcBeat(text);
            if (parsed && parsed.goal) {
                const beat = buildCompiledBeat(arc, waypoint, parsed, opts);
                const hit = redlines.length ? beatViolatesRedlines(beat, redlines) : null;
                if (hit) { lastReason = '生成的拍命中了你设的红线「' + hit + '」，已弃用重编。'; console.warn('[Story Oracle] arc compile attempt', attempt, '— redline violated:', hit); continue; }
                arcCompileError = '';   // 成功，清掉旧的失败原因
                return beat;
            }
            lastReason = arcFailureReason(null, text);
            console.warn('[Story Oracle] arc compile attempt', attempt, '—', lastReason);
        } catch (e) {
            lastReason = arcFailureReason(e);
            if (arcAborted(e)) { console.warn('[Story Oracle] arc compile aborted (timeout / cancel) — stop retrying.'); break; }
            console.warn('[Story Oracle] arc compile attempt', attempt, 'failed:', e);
        }
    }
    arcCompileError = lastReason;   // 供 runCompileTransition 展示 / 落系统记录
    return null;
}

/* ------------------------------------------------------------------ *
 * 弧线路标【自动起草】—— 盲盒表单留空路标时，由模型按篇幅暗中拟定整条骨架
 *（恢复盲盒"看不到骨架"的本意：用户连入职都不该看到路标）。纯部分
 *（buildWaypointDrafterMessages / parseWaypoints）可单测；异步部分
 *（callWaypointDrafter / draftWaypoints）走现有连接 + 3 次重试。
 * 路标数量直接随 spanFeel（短 3-5 / 中 5-9 / 长 8-15，见 SPAN_FEEL）。
 * ------------------------------------------------------------------ */
const WAYPOINT_DRAFTER_SYSTEM_PROMPT =
`你是「故事神谕·剧情参谋」的弧线路标起草器。下面给你一条正在构思的剧情弧线（贯穿线 / 大致方向 / 风格 /
难度）。把它拆成一串【意图级】路标——每个路标是一句话的「剧情意图」（如「师父的背叛浮出水面」），
而不是具体事件，不写台词、不写过程分步。整串路标要构成一条有起承转合的弧线：早期铺垫 → 中期升温 →
倒数第二步最艰难的抉择 → 末步高潮收束；前后呼应、步步递进，最终让贯穿线得到解决。
末路标须【正面解决】贯穿线承诺的那个结局，绝不以「不再追究 / 放下真相 / 留作悬念」来回避——放下是【查清真相之后】做出的选择，不是绕过真相。

若上下文里带有【剧情记录 / 角色卡 / 世界书】，务必让路标扎根于这个故事【已经发生的事】与【既定设定 / 世界观】：
回收已埋下却未兑现的伏笔、呼应已有的人物与关系，绝不脱离实际剧情凭空设计。

只输出一个 <Waypoints> 区块，每行一个路标（可带序号），不要任何多余解释：
<Waypoints>
1. ……
2. ……
</Waypoints>
全程简体中文。`;

// 组装路标起草消息。主体为纯逻辑（只读 spec + SPAN_FEEL / ADVISOR_DIFFICULTIES + extra）；收尾对两条消息做一次
// {{user}} / {{char}} 宏替换（与 compiler / achieve / check 对齐——此前唯独起草器漏了，世界书 / 正传剧情里的
// {{user}} 会字面直达模型）。ctx 不可用时（纯函数单测）try/catch 降级为恒等，故仍可单测。
// 数量区间直接取自 spanFeel；extra = 全量匹配时由 callWaypointDrafter 注入的【剧情全史 + 角色卡 + 世界书 + stat】
// 区块（clamp / 单测时为空），拼在弧线规格与计数指令之间，让骨架扎根于真实 RP（方案 C；见 §8 起草上下文）。
function buildWaypointDrafterMessages(spec, extra) {
    const c = (spec && spec.consent) || {};
    const span = SPAN_FEEL[spec && spec.spanFeel] || SPAN_FEEL.medium;
    const parts = ['=== 弧线 ==='];
    if (spec && spec.throughline) parts.push(`贯穿线：${spec.throughline}`);
    if (c.direction) parts.push(`大致方向（关于什么，而非发生什么）：${c.direction}`);
    if (c.style) parts.push(`风格偏好：${c.style}`);
    const diff = ADVISOR_DIFFICULTIES[c.difficulty];
    if (diff) {
        parts.push(`难度 / 赌注层级：${diff.label}（${diff.caption}）`);
        // 把振幅指令 amp 也喂给起草器，让【骨架本身】的升温幅度 / 最艰难抉择的分量落在本难度的赌注层级里。
        // 原先只给标签 + 一句说明 = 骨架只「知道难度名」却不知该升到多重；amp 才是真正缩放赌注的那条（与编译器同源）。
        if (diff.amp) parts.push(`整条弧线的赌注量级（中期升温到何种程度、倒数第二步的最艰难抉择有多重、高潮收束的代价）须落在此难度层级内：${diff.amp}`);
    }
    for (const b of (extra || [])) parts.push(b);
    parts.push(`篇幅感：${span.label} —— 请起草 ${span.min}~${span.max} 个【意图级】路标，构成一条完整弧线。只输出 <Waypoints> 区块。`);
    // {{user}} / {{char}} 宏替换，与其余过渡调用同步。ctx 不可用（纯函数单测）则降级为恒等——不破坏可单测性。
    let subst = (t) => t;
    try {
        const ctx = getCtx();
        if (ctx && typeof ctx.substituteParams === 'function') {
            subst = (t) => { try { return ctx.substituteParams(t); } catch (e) { return t; } };
        }
    } catch (e) { /* 纯 / 测试上下文：无 ctx，保持恒等 */ }
    return [
        { role: 'system', content: subst(WAYPOINT_DRAFTER_SYSTEM_PROMPT) },
        { role: 'user', content: subst(parts.join('\n')) },
    ];
}

// 解析 <Waypoints> 区块 → 路标意图字符串数组（去行首序号 / 项目符号；无区块回空数组）。纯函数、可单测。
function parseWaypoints(text) {
    let m = String(text || '').match(/<Waypoints>([\s\S]*?)<\/Waypoints>/i);
    if (!m) m = String(text || '').match(/<Waypoints>([\s\S]*)$/i);   // 容忍漏写 / 截断闭标签（deepseek 实测漏过）
    if (!m) return [];
    return m[1].split('\n')
        .map((l) => l.replace(/^\s*(?:\d+\s*[.、)：]|[-·*•])\s*/, '').trim())
        .filter(Boolean);
}

// 一次起草调用：组装消息 + 走现有连接（direct / profile，非流式）。COMPILER_FULL_CONTEXT 开时，骨架起草也拿到
// 与编译器同级的全量上下文（剧情全史 + 角色卡 + 世界书 + stat），修「最有分量的调用却最盲」（方案 C；见 §8）。
async function callWaypointDrafter(spec) {
    const s = getSettings();
    let extra = [];
    if (COMPILER_FULL_CONTEXT) {
        const ctx = getCtx();
        let statStr = '';
        try { const st = await getMvuStatData(); if (st) statStr = JSON.stringify(st, null, 2); } catch (e) { /* no MVU */ }
        let wiStr = '';
        try { wiStr = await buildWorldInfo(wiContextMode(s), arcScanText(spec)); } catch (e) { /* no WI */ }
        extra = fullContextBlocks(ctx, s, wiStr);   // 角色卡 + 世界书
        if (statStr) extra.push('=== 当前变量状态（剧情硬事实，骨架不得与之矛盾）===\n' + statStr);
        const transcript = buildTranscript(ctx, { ...s, contextDepth: -1 });
        if (transcript) extra.push('=== 完整故事对话记录（最新的在最后）===\n' + transcript);
    }
    const messages = buildWaypointDrafterMessages(spec, extra);
    const maxTokens = Math.max(Number(s.maxTokens) || 0, ARC_CALL_MAX_TOKENS);
    return await arcCall(messages, maxTokens);   // 护栏 + 实时缓冲 + 流式分发
}

// 起草 + 解析，最多重试 3 次；成功返回路标数组（按 spanFeel 上限封顶，过多则裁），全失败回 null。
async function draftWaypoints(spec) {
    const span = SPAN_FEEL[spec && spec.spanFeel] || SPAN_FEEL.medium;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const wps = parseWaypoints(await callWaypointDrafter(spec));
            if (wps.length) return wps.slice(0, span.max);
            console.warn('[Story Oracle] waypoint draft attempt', attempt, '— no parseable <Waypoints>.');
        } catch (e) {
            if (arcAborted(e)) { console.warn('[Story Oracle] waypoint draft aborted (timeout / cancel) — stop retrying.'); break; }
            console.warn('[Story Oracle] waypoint draft attempt', attempt, 'failed:', e);
        }
    }
    return null;
}

// ---- 置信门控核验（layer-4 细化）：独立于编译的一次轻调用 ----

// 组装核验消息：把【待核实的幕后 goal】+ 自本拍以来的剧情 + 变量状态喂给核验器。
// wiStr：全量匹配时由 checkBeatFulfilled 异步取的世界书（clamp 模式为空串）。
function buildCheckMessages(arc, beat, statStr, wiStr) {
    const ctx = getCtx();
    const s = getSettings();
    const beatAt = (beat && beat.beatAdoptedAt) || arc.adoptedAt || 0;
    const since = Math.max(0, chatMsgCount() - beatAt);
    const transcript = transitionTranscript(ctx, s, since);
    const parts = ['=== 待核实的幕后目标（玩家看不到）===', beat.goal];
    const playerTask = arcVisibleObjective(beat);
    if (playerTask) parts.push(`（玩家看到的任务是：${playerTask}）`);
    for (const b of fullContextBlocks(ctx, s, wiStr)) parts.push(b);   // 全量匹配：角色卡 + 世界书
    if (transcript) parts.push('=== 最近剧情（自这一拍开始以来）===\n' + transcript);
    if (statStr) parts.push('=== 当前变量状态（剧情硬事实）===\n' + statStr);
    parts.push('请判断上面的幕后目标在最近剧情里是否已经真正兑现，只输出一个 <ArcCheck> 区块。');
    const subst = (t) => { try { return ctx.substituteParams(t); } catch (e) { return t; } };
    return [
        { role: 'system', content: subst(CHECK_SYSTEM_PROMPT) },
        { role: 'user', content: subst(parts.join('\n\n')) },
    ];
}

// 一次核验调用 → 'yes' | 'unsure' | 'no'。走现有连接（direct / profile，非流式）；任何错误 /
// 不可解析一律回 'unsure'（绝不假阳性）。token 上限给小（核验输出很短）。
async function checkBeatFulfilled(arc) {
    const beat = arc && arc.currentBeat;
    if (!beat || !beat.goal) return 'unsure';
    const s = getSettings();
    let statStr = '';
    try { const st = await getMvuStatData(); if (st) statStr = JSON.stringify(st, null, 2); } catch (e) { /* no MVU */ }
    let wiStr = '';
    if (COMPILER_FULL_CONTEXT) { try { wiStr = await buildWorldInfo(wiContextMode(s), arcScanText(arc)); } catch (e) { /* no WI */ } }
    const messages = buildCheckMessages(arc, beat, statStr, wiStr);
    const maxTokens = Math.max(Number(s.maxTokens) || 0, ARC_CALL_MAX_TOKENS);   // 核验也跑判定 CoT，同享 8192 预算
    let text = '';
    try { text = await arcCall(messages, maxTokens); }   // 护栏 + 实时缓冲 + 流式（超时 / 取消 → 抛错 → catch 回 unsure）
    catch (e) { console.warn('[Story Oracle] arc fulfillment check failed:', e); return 'unsure'; }
    const parsed = parseArcCheck(text);
    return parsed ? parsed.verdict : 'unsure';
}

/* ------------------------------------------------------------------ *
 * ✓「达成」合并调用（2026-06-14）—— 有下一路标时把【核验 + 编下一拍】并成一次 LLM 调用（self-branch）。
 * 模型一份回复里先 <ArcCheck>（判定）再 <ArcBeat>（按判定二选一）。代码仍掌控揭晓 / 推进（arcDecideOnAchieve /
 * arcReveal），判定 verdict-first + 去耦 + 从严，失败 fail-safe。末路标仍走独立核验（见 arcMarkAchieved）。
 * ------------------------------------------------------------------ */
// ACHIEVE（CoT 版，2026-06-14 committed·prompt tuning 第二轮）：判定半边【保持精简】（盲评证实精简「先证据后结论」
// 已够稳，不加重 CoT）；编拍半边套用与 COMPILER 同源的【生成 CoT】（清点/信息地图/此刻与转场/把拍写好看/质量自检）。
// 2026-06-16 起，玩家 objective【不在思考里挑】、在输出区一次写定（见 BLIND_COMPILER_ADDENDUM 注释）。生成步骤 +
// objective 段与 COMPILER_SYSTEM_PROMPT + BLIND_COMPILER_ADDENDUM 同源——改一处记得同步另一处。
const ACHIEVE_SYSTEM_PROMPT =
`你是「故事神谕·剧情参谋」的盲盒「达成」处理器。玩家刚点了「目标已达成」。请在【一次回复】里：先在 <arc_think> 里按步推演（先判定、再据判定编下一拍），再依次输出 <ArcCheck>（判定）→ <ObjectiveDraft>（抛弃式）→ <ArcBeat>（下一拍）。

═══ 思维（写在 <arc_think>…</arc_think> 内，务必简短）═══
不跳步、不解释自检过程。【绝不可】在 <arc_think> 内写出 <ArcCheck> / <ArcBeat> / <ObjectiveDraft> 任何正式标签——它们只在 </arc_think> 之后输出。
【一遍成稿·铁律】每步只写一条结论、≤2 句；判定与编拍都想到第一个站得住的答案就定下来，把「挑选」交给质量自检。【禁止】列举多个备选拍（不写「更好的想法是…／或者…／换个角度…」之类）、【禁止】推翻重来、【禁止】来回重读剧情反复权衡。整段思考约 ≤800 字，写完立即输出 </arc_think>，不再续写。

【目标—任务耦合·别钻牛角尖】objective 是玩家亲手做的【触发动作】，goal 是它引发的【后果 / 真相】。二者【不必同一拍内同时成立】，玩家也【不必亲手造成】goal——只需 objective 是【点燃它的引线】、存在一条看得见的因果线。① 后果可【延迟】：玩家做完 objective 后过一两次回复、或经一个延伸任务（stage B 载体拍）才落地，这是常态，别为「这动作如何当场促成 goal」反复推翻重来。② 后果可发生在【玩家不在场处】：主聊天叙事者已被授权在玩家触发【之后】用切视角 / 旁白 / 让结果找上门（信件·消息·传唤）把它演进正文。所以 goal 照写真实剧情后果（哪怕是别处的会议·决定·远方事件），不必硬塞进一个玩家在场的场景。

【判定（先证据后结论）】这一拍【幕后真正想促成的事】（user「待判定的幕后目标」那条）是否已在最近剧情里【真正发生】——以文本确有其事为准，不看玩家声称。先从【剧情记录】里【逐字引用】足以证明它发生的那一句（或几句）原文；【引不出原文 = unsure】。线索找到了 / 刚起头 / 只是接近 / 可推断，统统【只算 unsure，绝不算 yes】；世界书设定与「即将发生」都不算「已发生」的证据。判定从严、诚实独立——【绝不可】因为「判 yes 才好往下写推进」而偏向 yes。据此定 fulfilled：yes（已明确确凿兑现）/ unsure（不确凿就选它）/ no（剧情明确朝反方向）。

【据判定编下一拍】判定只决定【是否揭晓上一拍】，不决定你编什么——编什么【一律以 user「第二步」的指示为准】（它会按当前情形明确告诉你：要么推进到下一路标，要么${STAGE_B_EVOLVE_GOAL ? '重新拟定一个更贴近的幕后 goal、把故事朝同一路标再推近一步' : '保持同一幕后 goal、只换一个更直接的玩家任务'}）。以它为准，绝不用任何别的「一般规则」去覆盖它。然后用下列步骤把这一拍写好（与盲盒编译同标准）：
- 清点素材：从【世界书 + 至今剧情】尽量充分清点——(a) 已确立的人物 / 关系 / 既定事实 / 当前状态；(b) 已埋下未兑现的伏笔 / 线头。漏斗非过滤网，需要别的既定细节随时回去取。
- 信息地图：{{user}} 与各相关角色【分别】知道 / 不知道 / 误以为什么——幕后 goal 吃 {{user}} 不知道的信息差，objective 落在其已知范围。
- 此刻与转场：读最近剧情（人在哪、在场谁、情绪、{{user}} 刚做了什么），这一拍从当下【长出来】，不凭空跳场景。
- 把拍写好看：用一种戏剧手法（反转 / 倒计时 / 假黎明 / 被迫的代价抉择）；素材【植根于本故事】（上面清点的元素及其背后的完整剧情 / 世界书）；可引入新人物 / 新事物，但须【点名它兑现了哪条既定线头】（凭空冒出 = 不合格）；先想最俗套写法再避开${ENABLE_TYPE_ROTATION ? '；类型尽量与最近几拍不同（自然第一——最贴切的写法若重复某类型也可，别为换而换、别设「保留」限制）' : ''}。
- 玩家 objective【不在思考里挑】：思考只把 goal / seed / 戏剧写好；玩家 objective 留到 </arc_think> 之后、在输出区【一次写定】（它是个玩家动作、不是深度创作，在思考里反复挑只会空转、撑爆预算）。好的盲盒 objective ＝ 一个 {{user}} 从【此刻】、凭他【自己看得见的理由】（他看不到幕后 goal）就会去做、又恰好【点燃】goal 的【一个】动作（赴约＝想要答案 / 陪她走回家＝担心她 / 把信交给她＝在送信 / 走进那扇门＝在探路）；只有知道秘密才讲得通的动作（无端「脱掉外套」「站到窗边」）＝坏 objective，玩家不会去做、goal 永远触发不了。objective 始终是 {{user}}【自己亲手做】的动作，【不是别的角色（NPC）的动作、也不是"看着某事发生"】——这点在【幕后 goal 是某 NPC 的内在变化 / 反应】时最易搞错：goal 尽可是那 NPC 的内心越界 / 转变 / 离屏之事，objective 仍是 {{user}} 点燃它的【那一下】（如幕后「她在独处中越界」→ objective「放学后陪她走回家」「找她单独说话」，绝不是「她靠过来」「她替你整理衣领」）。它【可大可小 / 可被动 / 可日常】——分量全在 goal / seed / 难度，【绝不可】因它「太简单 / 太被动 / 太日常」推翻另找；别把时间 / 地点 / 场合钉进去（进 seed）。
- 质量自检（不过则重写）：赌注（按难度，不越级、不碰红线）/ 能动性 / 关联性（回收已有，不凭空降落）/ 惊喜（含路标未点明的新信息）；${ENABLE_TYPE_ROTATION ? '类型已轮换、' : ''}与 stat 不矛盾（盲盒 objective 的不剧透改在输出区两稿法把关，不在思考里挑）。

═══ 输出（</arc_think> 之后，顺序固定；objective 在此【一次写定、不回头改】）═══
<ArcCheck>
fulfilled: yes | unsure | no
reason: 一句话依据（引你判定时的证据）
</ArcCheck>
<ObjectiveDraft>
plain: …（把这一拍连后果 / 意义直白摊开，抛弃式）
masked: …（抹掉所有后果 / 意义 / 评判词，只留玩家亲手做的那个动作——这是强制去剧透，不是再挑动作）
</ObjectiveDraft>
<ArcBeat>
goal: 一句话、结果式的幕后真相（玩家看不到）
objective: 玩家可见任务（＝上面 masked 的那个玩家动作）
type: 移动 / 战斗 / 社交 / 调查 / 获取 / 抉择 / 生存 / 创造 / 欺骗 / 守护 里选一个${ENABLE_TYPE_ROTATION ? '，避开最近几拍' : ''}
seed: 起始迹象
why: 为何贴合此刻（呼应哪条伏笔 / 关系 / 既定事实）
</ArcBeat>
全程简体中文。`;

// 组装合并调用消息（判定目标 + 弧线上下文 + 第二步 self-branch 说明 + consent）。复用 compilerTranscript /
// buildTransitionDirectives / blindConsentBlock，beat 质量与独立编译一致。inStageB 时不给「换任务」分支。
function buildAchieveMessages(arc, nextWp, statStr, wiStr) {
    const ctx = getCtx();
    const s = getSettings();
    const resolved = arc.currentBeat;
    const inStageB = !!(resolved && resolved.stage === 'B');
    const shapeNext = arcShapePosition(arc, nextWp);   // 下一拍的 live 位置 + 端锚定角色
    const wpList = arc.waypoints.map((w, i) => {
        const tag = w.id === nextWp.id ? '【下一个路标】'
            : (w.status === 'done' ? '[已完成]'
                : (w.status === 'skipped' ? '[已跳过]'
                    : (w.status === 'active' ? '[当前]' : '[待办]')));
        return `${i + 1}. ${tag} ${w.intent}`;
    }).join('\n');
    const beatAt = (resolved && resolved.beatAdoptedAt) || arc.adoptedAt || 0;
    const since = Math.max(0, chatMsgCount() - beatAt);
    const transcript = transitionTranscript(ctx, s, since);
    const revealed = (arc.revealed || []).slice(-6).map((r) => `· ${r.goal}`).join('\n');
    const span = SPAN_FEEL[arc.spanFeel] || SPAN_FEEL.medium;
    const playerTask = arcVisibleObjective(resolved);

    const parts = [
        '=== 待判定的幕后目标（第一步要核验；玩家看不到）===\n' + (resolved ? resolved.goal : '')
            + (playerTask ? `\n（玩家看到的任务是：${playerTask}）` : '')
            + (inStageB ? '\n（这一拍已经是延伸任务 / follow-up。）' : '\n（这是该目标的首次判定。）'),
        '=== 弧线 ===\n'
            + `贯穿线：${arc.throughline || '（未填）'}\n`
            + `篇幅感：${span.label}（${span.range}）　·　共 ${shapeNext.total} 个路标（不含已跳过）　·　下一拍的弧线角色：${ARC_SHAPE_ROLES[shapeNext.role]}\n`
            + `路标列表：\n${wpList}`,
    ];
    for (const b of fullContextBlocks(ctx, s, wiStr)) parts.push(b);   // 全量匹配：角色卡 + 世界书
    if (transcript) parts.push('=== 最近剧情（自本拍开始以来）===\n' + transcript);
    if (statStr) parts.push('=== 当前变量状态（剧情硬事实，方案不得与之矛盾）===\n' + statStr);
    if (revealed) parts.push('=== 已推进过的拍（勿原样重复）===\n' + revealed);
    if (inStageB) {
        parts.push('=== 第二步 · 编下一拍 ===\n无论判定如何，都编译上面标【下一个路标】的那个路标（判定只决定是否揭晓上一拍，不改变你编什么）。');
    } else {
        const unsureDirective = STAGE_B_EVOLVE_GOAL
            ? '· 若判 unsure / no → 【不要换路标】，但这一拍的幕后还没落地——请【重新拟定一个更贴近的幕后 goal】（连同 seed），让它仍服务【同一个路标】、把故事朝它【再推近一步】：可以把上一个 goal 收窄 / 具体化，或换一个更直接通向【同一路标终点】的幕后结果（绝不改路标、绝不越级 / 碰红线）；objective 另给一个新的、与上个明显不同的玩家动作（玩家从此刻、凭自己看得见的理由会做、又点燃 goal）。不要揭晓、不要推进到下一路标。'
            : `· 若判 unsure / no → 【不要换路标】；编一个【延伸任务 / 载体拍】：保持【同一个幕后 goal 不变】（仍是「${resolved ? resolved.goal : ''}」），`
                + '只把 objective 换成一个新的、更直接推动它兑现、且与上个任务明显不同的玩家任务——最好是一个【会把场景推到 goal 落地那刻】的任务（幕后「导师战死」→「在这场战斗里活下来」）；goal 照原样输出。';
        parts.push('=== 第二步 · 编下一拍（按你第一步的判定二选一）===\n'
            + '· 若判 yes → 编译上面标【下一个路标】的那个路标，让故事向前推进。\n'
            + unsureDirective);
    }
    for (const d of buildTransitionDirectives(arc, nextWp, {})) parts.push(d);
    const consent = blindConsentBlock(arc.consent);
    if (consent) parts.push(consent);
    parts.push('输出顺序固定：先 <ArcCheck>（你的判定），再 <ObjectiveDraft>（抛弃式两稿），最后 <ArcBeat>（定稿）。');

    const subst = (t) => { try { return ctx.substituteParams(t); } catch (e) { return t; } };
    return [
        { role: 'system', content: subst(ACHIEVE_SYSTEM_PROMPT) },
        { role: 'user', content: subst(parts.join('\n\n')) },
    ];
}

// 一次合并调用：取变量状态 + 组装消息 + 走现有连接（direct / profile，非流式）。
async function callAchieve(arc, nextWp) {
    const s = getSettings();
    let statStr = '';
    try { const st = await getMvuStatData(); if (st) statStr = JSON.stringify(st, null, 2); } catch (e) { /* no MVU */ }
    let wiStr = '';
    if (COMPILER_FULL_CONTEXT) { try { wiStr = await buildWorldInfo(wiContextMode(s), arcScanText(arc)); } catch (e) { /* no WI */ } }
    const messages = buildAchieveMessages(arc, nextWp, statStr, wiStr);
    const maxTokens = Math.max(Number(s.maxTokens) || 0, ARC_CALL_MAX_TOKENS);
    return await arcCall(messages, maxTokens);   // 护栏 + 实时缓冲 + 流式分发
}

// 据判定 + 解析出的拍，规划「达成」分支并校验拍是否可用（纯函数、可单测）。decision 沿用 arcDecideOnAchieve
//（代码掌控揭晓 / 推进）；usable：stage-b 需 objective、推进需 goal。
function achievePlan(arc, verdict, parsed) {
    const decision = arcDecideOnAchieve(arc, verdict);
    if (!parsed) return { decision, usable: false };
    // 推进需 goal。stage-b：原行为只需 objective（goal 沿用旧拍）；STAGE_B_EVOLVE_GOAL 会据新拍重建注入，故也需 goal。
    const usable = decision === 'stage-b'
        ? (STAGE_B_EVOLVE_GOAL ? (!!parsed.goal && !!parsed.objective) : !!parsed.objective)
        : !!parsed.goal;
    return { decision, usable };
}

// 合并调用 + 解析，最多重试 3 次；成功回 { verdict, parsed }，全失败回 null（fail-safe）。每次都重判 + 重编
//（同一份剧情下判定应稳定；失败重试不会卡死在坏拍上）。绝不在拿不到可用拍时硬推进。
async function achieveWithRetry(arc, nextWp) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const text = await callAchieve(arc, nextWp);
            const verdict = (parseArcCheck(text) || { verdict: 'unsure' }).verdict;
            const parsed = parseArcBeat(text);
            const revisedTail = parseWaypoints(text);   // 可选：编译器在显著漂移时重拟的待办尾段（无 <Waypoints> → 空数组 → 休眠）
            if (achievePlan(arc, verdict, parsed).usable) return { verdict, parsed, revisedTail };
            console.warn('[Story Oracle] achieve attempt', attempt, '— beat unusable for verdict', verdict);
        } catch (e) {
            if (arcAborted(e)) { console.warn('[Story Oracle] achieve aborted (timeout / cancel) — stop retrying.'); break; }
            console.warn('[Story Oracle] achieve attempt', attempt, 'failed:', e);
        }
    }
    return null;
}

// 常见路径（有下一路标）：一次调用搞定【核验 + 编下一拍】。代码仍掌控揭晓 / 推进（arcDecideOnAchieve）；
// 失败 fail-safe（保留当前注入 + 方案条「↻ 重试」重走 ✓）；绝不假阳性揭晓。
async function arcAchieveMerged(arc, nextWp) {
    const resolved = arc.currentBeat;
    const stamp = arcStamp(arc);
    arcCompiling = true; clearArcRetry(); setArcBusyUI(true);
    const tt = arcToast('正在确认这一拍是否落地、并编下一步…');
    let result = null;
    try { result = await achieveWithRetry(arc, nextWp); } catch (e) { result = null; }
    arcClearToast(tt);
    arcCompiling = false;
    // 并发守卫：调用期间用户可能切了聊天 / 改了弧线。
    const cur = getArc();
    if (!cur || arcStamp(cur) !== stamp) { setArcBusyUI(false); renderPlanBar(); return; }
    if (!result) {
        setArcRetry({ achieve: true });   // 让方案条「↻ 重试」重走这次 ✓
        setArcBusyUI(false); renderPlanBar();
        arcToastErr('这次「确认 + 编下一步」没成功（失败 / 超时 / 已取消）——当前这一拍与引导保持不变。可点方案条上的「↻ 重试」再试。');
        return;
    }
    const { decision } = achievePlan(cur, result.verdict, result.parsed);
    if (decision === 'stage-b') {
        // 不揭晓、不前进。STAGE_B_EVOLVE_GOAL：用模型新拍（新 goal/seed/objective）重建注入、朝同一路标推近一步；
        // 否则（原行为·锁定 goal）保持当前 goal / 注入不变，只把任务换成 objectiveB。
        if (STAGE_B_EVOLVE_GOAL) {
            const wp = arcActiveWaypoint(cur);
            const beat = buildCompiledBeat(cur, wp, result.parsed, { now: chatMsgCount(), variant: (resolved && resolved.variant) || 0 });
            setArc(arcCommitStageBEvolve(cur, beat));
            applyPlanInjection(); clearArcRetry(); setArcBusyUI(false); renderPlanBar();
            addSystemNote(`换个方向再推近一步：${arcVisibleObjective(beat) || beat.goal}`);
            return;
        }
        setArc(arcCommitStageB(cur, result.parsed.objective));
        applyPlanInjection(); clearArcRetry(); setArcBusyUI(false); renderPlanBar();
        addSystemNote(`这一步好像还没完全落地，再往前推一下：${result.parsed.objective || '（继续推进）'}`);
        return;
    }
    // reveal-advance / quiet-advance：用模型编的下一拍推进；揭晓仅在 yes 时由【代码】触发（绝不假阳性）。
    const confident = decision === 'reveal-advance';
    // living-skeleton：若编译器判定剧情显著偏离骨架而重拟了待办尾段（盲盒、贯穿线神圣），先把尾段换掉、再朝
    // 【重拟后】的新尾段头推进。盲盒下骨架本就对用户隐藏，故静默重构、不出系统提示（设计 §8）。空尾段 = 不动。
    let working = cur, advanceTo = nextWp;
    if (Array.isArray(result.revisedTail) && result.revisedTail.length) {
        working = arcReviseTail(cur, result.revisedTail);
        advanceTo = arcPeekNext(working) || nextWp;
        console.debug('[Story Oracle] arc tail revised on drift →', result.revisedTail);
    }
    const beat = buildCompiledBeat(working, advanceTo, result.parsed, { now: chatMsgCount() });
    setArc(arcCommitAdvance(working, beat, confident ? 'achieved' : 'advanced'));
    applyPlanInjection();
    if (confident) arcReveal(resolved);
    clearArcRetry(); setArcBusyUI(false); renderPlanBar();
    addSystemNote(`下一拍的任务：${arcVisibleObjective(beat) || beat.goal}`);
}

// 弧线身份指纹（并发守卫：切聊天 / 改弧线后丢弃在途结果）。
function arcStamp(arc) {
    return arc ? `${arc.adoptedAt}|${arc.cursor}|${arc.throughline}` : '';
}

/* ---- toastr 助手（ST 全局 toastr）---- */
function arcToast(msg) {
    try { return (window.toastr && window.toastr.info) ? window.toastr.info(msg, '', { timeOut: 0, extendedTimeOut: 0 }) : null; }
    catch (e) { return null; }
}
function arcClearToast(t) { try { if (window.toastr) window.toastr.clear(t || undefined); } catch (e) { /* ignore */ } }
function arcToastErr(msg) {
    try { if (window.toastr && window.toastr.error) { window.toastr.error(msg); return; } } catch (e) { /* fall through */ }
    addSystemNote(msg);
}

/* ---- 弧线 LLM 调用的【超时 + 可取消】护栏 ---- */
// 弧线调用此前传 undefined signal = 无超时：请求挂死（发出去但服务端不回）时 await 永不返回，
// setArcBusyUI(false) 永远到不了，进度计时器 / 罗盘就会【一直转下去】。这里给每次调用包一个 AbortController：
// 到点（arcCallTimeoutMs）自动 abort 兜底，用户也可点「取消」立即 abort。abort → fetch 抛 AbortError →
// 重试循环识别为中断、不再硬重试 → 上层走失败分支 → 清 busy（停表 + 停转）+ 留「重试」。
const arcCallTimeoutMs = 180000;   // 3 分钟安全超时：CoT 编一拍正常数十秒，给足余量；真卡死才到点。取消按钮让此值只作兜底。
let arcAbortCtl = null;             // 当前在途弧线调用的中断器（超时 / 取消共用）
function arcBeginCall(ms) {
    let ctl = null;
    try { ctl = new AbortController(); } catch (e) { return { signal: undefined, end() {} }; }
    arcAbortCtl = ctl;
    let timer = null;
    try { timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, ms); } catch (e) { /* 无 timers 环境 */ }
    return { signal: ctl.signal, end() { if (timer) clearTimeout(timer); if (arcAbortCtl === ctl) arcAbortCtl = null; } };
}
function arcCancelInflight() { try { if (arcAbortCtl) arcAbortCtl.abort(); } catch (e) { /* ignore */ } }
function arcAborted(e) { return !!e && (e.name === 'AbortError' || e.name === 'TimeoutError'); }

/* ---- 实时输出缓冲 + 「📡 实时输出」查看器（诊断「在动 vs 卡死」）---- */
// 每次弧线调用把流式 content / reasoning 累计在这里；用户开一个独立浮窗看它实时增长，一眼分辨
// 「真在流（只是慢，等就行）」还是「一直空着（八成卡死，点取消）」。renderArcLive 在查看器关着时是空操作 = 零开销。
let arcLiveText = '';        // 累计 content
let arcLiveReasoning = '';   // 累计 reasoning_content（reasoning 模型）
let arcLiveActive = false;   // 是否有调用在途
let arcLiveStreamed = false; // 本次是否走了流式（s.stream 关 → false → 查看器解释「未开流式」）
let arcLiveStartedAt = 0;
function arcLiveBegin(streamed) { arcLiveText = ''; arcLiveReasoning = ''; arcLiveActive = true; arcLiveStreamed = !!streamed; arcLiveStartedAt = Date.now(); renderArcLive(); }
function arcLiveDelta(o) { if (o) { if (typeof o.content === 'string') arcLiveText = o.content; if (typeof o.reasoning === 'string') arcLiveReasoning = o.reasoning; } renderArcLive(); }
function arcLiveDone() { arcLiveActive = false; renderArcLive(); }

// 一次弧线 LLM 调用：超时/取消护栏 + 实时缓冲 + 流式分发（尊重 s.stream；关流式则退回非流式，查看器会说明）。
// 4 个调用助手（编译 / 达成 / 核验 / 起草）统一走这里——返回完整文本，与原非流式行为一致。
async function arcCall(messages, maxTokens) {
    const s = getSettings();
    const guard = arcBeginCall(arcCallTimeoutMs);
    arcLiveBegin(!!s.stream);
    try {
        if (s.mode === 'direct') {
            const url = normalizeUrl(s.endpoint);
            const body = { model: s.model, messages, max_tokens: maxTokens };
            if (s.sendTemperature) body.temperature = s.temperature;
            if (s.stream) return await streamDirectArc(url, s.apiKey, body, guard.signal, arcLiveDelta);
            return await callDirect(url, s.apiKey, body, guard.signal);
        }
        const override = s.sendTemperature ? { temperature: s.temperature } : {};
        if (s.stream) return await callProfileStream(s.profileId, messages, maxTokens, override, guard.signal, (full) => arcLiveDelta({ content: full }));
        return await callProfile(s.profileId, messages, maxTokens, override, guard.signal);
    } finally { guard.end(); arcLiveDone(); }
}

// 编译中：禁用游玩按钮 + 进度行跑一个【动画 + 已用时（+ 流式时的已接收字数）】计时器 + 旋转罗盘图标。
// CoT 编一拍可能数十秒，只给一个静态 toast「开始了」却没有「在动」的反馈；墙钟计时 + CSS 旋转给出活着的进度感，
// 对所有模型 / 连接都稳。开了流式时，arcLive* 还累计实时字数（含 reasoning_content，故 reasoning 模型也不会卡在 0），
// 「📡 实时输出」浮窗可看逐字流（确认在流 vs 卡死）。单点放在 setArcBusyUI 里 → 覆盖所有出拍路径。完成后由 renderPlanBar 复原。
let arcBusyTimer = null;
let arcBusyStart = 0;
function arcBusyLabel() {
    const secs = Math.max(0, Math.round((Date.now() - arcBusyStart) / 1000));
    const dots = '.'.repeat(1 + (Math.floor(Date.now() / 400) % 3));   // 动起来的省略号
    const n = arcLiveText.length + arcLiveReasoning.length;            // 流式时的实时字数（含 reasoning）
    const recv = n > 0 ? ` · 已接收 ${n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n} 字` : '';
    return `正在推演这一拍${dots}（已 ${secs}s${recv} · CoT 思考中，请稍候）`;
}
function startArcBusyTicker() {
    arcBusyStart = Date.now();
    const tick = () => {
        if (!planBarEl) return;
        const p = planBarEl.querySelector('#so-plan-progress');
        if (p) { p.style.display = ''; p.textContent = arcBusyLabel(); }
    };
    tick();
    arcBusyTimer = setInterval(tick, 400);
}
function stopArcBusyTicker() {
    if (arcBusyTimer) { clearInterval(arcBusyTimer); arcBusyTimer = null; }
}
function setArcBusyUI(busy) {
    if (busy && !arcBusyTimer) startArcBusyTicker();
    if (!busy) stopArcBusyTicker();
    // 旋转一切罗盘图标（窗口内方案条 / 浮窗头 / 折叠态那枚）——窗口关着甚至折叠成指南针时也看得到「在忙」。
    if (planBarEl) planBarEl.classList.toggle('so-arc-busy', busy);
    if (planFloat) planFloat.classList.toggle('so-arc-busy', busy);
    if (!planBarEl) return;
    for (const sel of ['#so-arc-complete', '#so-arc-reroll', '#so-arc-achieved',
        '#so-arc-failed', '#so-arc-reject', '#so-arc-exit', '#so-arc-retry']) {
        const el = planBarEl.querySelector(sel);
        if (el) el.disabled = busy;
    }
    // 「取消」+「实时输出」只在忙时露出（且都不禁用——卡死时的逃生口 / 诊断口）。
    const stop = planBarEl.querySelector('#so-arc-stop');
    if (stop) { stop.style.display = busy ? '' : 'none'; stop.disabled = false; }
    const live = planBarEl.querySelector('#so-arc-live');
    if (live) { live.style.display = busy ? '' : 'none'; live.disabled = false; }
    if (busy) {
        const p = planBarEl.querySelector('#so-plan-progress');
        if (p) { p.style.display = ''; p.textContent = arcBusyLabel(); }
    }
}
function setArcRetry(o) { arcRetryPending = o; }
function clearArcRetry() { arcRetryPending = null; }

// 一次过渡的编排：toast → 编译（带重试）→ 成功才提交（且仅当弧线身份未变）→ 注入 + 渲染；
// 失败 / 出错：保留当前注入不动 + 留「重试」。供 adoptArc / arcComplete / arcRerollBeat 共用。
async function runCompileTransition(o) {
    if (arcCompiling) return;
    arcCompiling = true;
    clearArcRetry();
    setArcBusyUI(true);
    const stamp = arcStamp(o.arc);
    const tt = arcToast(o.toast || '正在编译…');
    let beat = null;
    try {
        beat = await compileBeatWithRetry(o.arc, o.waypoint, {
            variant: o.variant || 0, now: chatMsgCount(),
            reroll: o.kind === 'reroll', failed: !!o.failed, stageB: o.kind === 'stageB',
        });
    } catch (e) {
        console.warn('[Story Oracle] compile transition error:', e);
    }
    arcClearToast(tt);
    arcCompiling = false;
    // 并发守卫：编译期间用户可能切了聊天 / 改了弧线 —— 只有在身份完全一致时才提交结果。
    const cur = getArc();
    if (!cur || arcStamp(cur) !== stamp) { setArcBusyUI(false); renderPlanBar(); return; }
    if (!beat) {
        setArcBusyUI(false);
        setArcRetry(o);                 // 暂存供方案条「重试」
        renderPlanBar();
        const why = arcCompileError || '失败 / 超时 / 已取消';
        // toast 会自动消失，只给一句简短提示；具体原因 + 操作建议落进【可选中复制、不随 toast 消失】的系统记录，
        // 方便远程用户把它转贴给作者定位（不再是黑箱「失败 / 超时 / 已取消」）。
        arcToastErr('编译没成功：' + (why.length > 60 ? why.slice(0, 60) + '…（详情见侧栏记录）' : why));
        addSystemNote('⚠ 弧线编译失败：' + why + '\n（当前这一拍与引导保持不变，可点方案条上的「重试」再试。把这条原因转给作者可帮助定位问题。）');
        return;
    }
    setArc(o.onBeat(cur, beat));
    applyPlanInjection();
    setArcBusyUI(false);
    renderPlanBar();
    if (o.onSuccess) o.onSuccess(cur, beat);
    if (o.okNote) addSystemNote(o.okNote(beat));
}

/* ------------------------------------------------------------------ *
 * MVU（MagVarUpdate）集成 —— 诊断模式用。
 * ------------------------------------------------------------------ */
async function getMvu() {
    if (mvuApi) return mvuApi;
    if (window.Mvu) { mvuApi = window.Mvu; return mvuApi; }
    const th = window.TavernHelper;
    if (th && typeof th.waitGlobalInitialized === 'function') {
        try {
            mvuApi = await Promise.race([
                th.waitGlobalInitialized('Mvu'),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
            ]);
            if (mvuApi) return mvuApi;
        } catch (e) { /* fall through */ }
    }
    return window.Mvu || null;
}

async function getMvuStatData() {
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.getMvuData !== 'function') return null;
    try {
        const data = Mvu.getMvuData({ type: 'message', message_id: 'latest' });
        return (data && data.stat_data) ? data.stat_data : (data ?? null);
    } catch (e) {
        console.warn('[Story Oracle] getMvuData failed:', e);
        return null;
    }
}

// 返回最近一条 AI 回复的 { idx, text }。idx 用于把推导出的更新块写回该消息（自动诊断衍生情形）。
function getLatestAiMessage() {
    const chat = getCtx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) return { idx: i, text: m.mes };
    }
    return { idx: -1, text: '' };
}
function getLatestAiMessageText() {
    return getLatestAiMessage().text;
}

// 纯函数：给定 chat 与【触发本轮自动处理的消息 id】，返回应处理的目标 { idx, text }。【钉住触发消息】而非
// 重扫「最近一条 AI 回复」——修 auto 校正 / 诊断偶发「改到上一条而非最新一条」：编排（maybePostReply）在延时 +
// 一次 LLM 往返之后才选目标，其间队尾可能变（触发消息此刻尚空 / 已被下一条顶掉 / 楼层被删），getLatestAiMessage
// 便回退到更早的一条。这里要求目标【仍是一条非空 AI 回复】：id 为空 / 越界 / 用户 / 系统 / 空白 → 视为已失效，
// 返回 { idx:-1, text:'' } 让调用方干净跳过（绝不误伤更早的回复）。nullish 安全。单测 fix-auto-target.test.mjs。
function resolveAutoTargetMessage(chat, messageId) {
    const list = Array.isArray(chat) ? chat : [];
    if (messageId == null) return { idx: -1, text: '' };                       // null / undefined → 已失效
    const idx = Number(messageId);
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return { idx: -1, text: '' };
    const m = list[idx];
    if (!m || m.is_user || m.is_system || typeof m.mes !== 'string' || !m.mes.trim()) return { idx: -1, text: '' };
    return { idx, text: m.mes };
}

// 纯函数（数据变更）：把 text 作为【新 swipe】追加到消息 m 上并切到它——非破坏性，原 m.mes 留在
// swipe 0。若消息还没有 swipes 数组，先用当前 m.mes 播种 swipe 0。info（swipe 元数据）由调用方传入，
// 便于纯函数确定性单测。返回新的 swipe_id；m 无效返回 -1。可单测。
function addSwipeToMessage(m, text, info) {
    if (!m || typeof m !== 'object') return -1;
    if (!Array.isArray(m.swipes) || m.swipes.length === 0) {
        m.swipes = [typeof m.mes === 'string' ? m.mes : ''];
        m.swipe_info = [Array.isArray(m.swipe_info) && m.swipe_info[0] ? m.swipe_info[0] : {}];
        m.swipe_id = 0;
    }
    if (!Array.isArray(m.swipe_info)) m.swipe_info = m.swipes.map(() => ({}));
    m.swipes.push(String(text == null ? '' : text));
    m.swipe_info.push(info || {});
    m.swipe_id = m.swipes.length - 1;
    m.mes = m.swipes[m.swipe_id];
    // Bug 3：换到新 swipe 后，作废渲染器写在 extra.display_text 上的【旧回复渲染缓存】。ST 的 updateMessageBlock
    // 渲染的是 extra.display_text ?? mes——小白X（LittleWhiteBox，本卡正用它）/ 翻译扩展会把渲染稿写进
    // display_text，不清掉它屏幕就停在旧回复，要用户点一下/划一下才切到校正稿（用户反馈：「自动修正后要调出界面
    // 才切到修正后的回复」）。对齐 ST 原生 swipe 的 loadFromSwipeId → clearMessageData（同样 delete display_text）。
    if (m.extra && typeof m.extra === 'object') delete m.extra.display_text;
    return m.swipe_id;
}

function extractUpdateBlock(text) {
    const m = (text || '').match(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i);
    return m ? m[0] : '';
}

// 纯函数：把"排除标签"输入解析成标签名数组。每行 / 逗号分隔一项；项可写成开标签 <konatan_planning~> 或裸名 konatan_planning。
function parseExcludeTagNames(str) {
    return String(str || '').split(/[,\n]+/)
        .map((s) => { const m = s.trim().replace(/^<\/?/, '').match(/^[A-Za-z0-9_一-龥-]+/); return m ? m[0] : ''; })
        .filter(Boolean);
}

// 纯函数（fix-exclude-nested-bracket.test.mjs）：把「排除区」输入解析成 [{name, bracket}]。每行 / 逗号一项。
// <tag> / </tag> / 裸名 tag → 尖括号块（bracket:false）；[tag] / [/tag] → 方括号块（bracket:true，如图生指令 [IMG_GEN]…[/IMG_GEN]）。
// 名字按标签名字符集（含中文、下划线、连字符）提取，容错前缀 < / </ / [ / [/。空 / 杂项 → 丢弃。
function parseExcludeTags(str) {
    return String(str || '').split(/[,\n]+/).map((s) => {
        const t = s.trim();
        if (!t) return null;
        const bracket = t.charAt(0) === '[';
        const m = t.replace(/^[<[]\/?/, '').match(/^[A-Za-z0-9_一-龥-]+/);
        return m ? { name: m[0], bracket } : null;
    }).filter(Boolean);
}

// 排除·保留区占位标记：keep 块从 prose 里抠走时，原位留下 ⟦SO_KEEP_n⟧ 作锚点（n = 该块在 keepBlocks 里的下标），
// 让 composeFixedReply 能把原块还原【回原位】，而不是一律接到末尾（用户报的「保留块被挪到故事结尾」bug）。⟦⟧ 是罕见
// 数学括号，正文几乎不可能自然出现；模型被 buildFixPrompt 提示原样保留，万一弄丢由 composeFixedReply 兜底接回（不丢内容）。
const FIX_KEEP_MARK = '⟦SO_KEEP_';
function fixKeepPlaceholder(i) { return FIX_KEEP_MARK + i + '⟧'; }
function stripFixKeepMarks(t) { return String(t == null ? '' : t).replace(new RegExp(FIX_KEEP_MARK + '\\d+⟧', 'g'), ''); }

// 纯函数：从 reply 里抠出用户指定的"排除区"。keep 标签的整块（含截断未闭合）抠出后【原位留下占位标记 ⟦SO_KEEP_n⟧】
// 并把原块收进 keepBlocks（composeFixedReply 据标记还原回原位）；drop 标签的块抠出后直接丢弃（无标记）。两者都从 prose
// （送去校正的正文）里移除。返回 { prose, keep, keepBlocks }。可单测（fix-exclude*.test.mjs）。
// 【深度配平】（1.17.9）：按开 / 闭标签计数找【配平】的整块——嵌套同名标签（<div> 套 <div>）抠的是【最外层】整块，
// 而非旧非贪婪正则「外开配第一个内闭」把结构切碎（用户报的「<div> 放进保留区也没用、整段被肘碎」根因）。
// 【方括号块】（1.17.9）：[IMG_GEN]…[/IMG_GEN] 这类方括号分隔块同样支持（图生卡常用；parseExcludeTags 的 bracket）。
// 孤立闭合标签（深度 0、无配对开标签）留在 prose；开了没闭（截断）→ 取到结尾。各标签按列表顺序逐一抠（与旧版同）。
function extractExcludedSections(reply, keepStr, dropStr) {
    let prose = String(reply || '');
    const keepBlocks = [];
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';   // 标签名后不得再跟名字字符（避免 <plan> 误匹配 <planning> / [IMG] 误匹配 [IMGX]；兼容中文标签）
    const pull = (spec, collect) => {
        const n = esc(spec.name);
        // 按尖 / 方括号给出开、闭标记的正则源（方括号块允许 [name attrs] 形态，闭标记 [/name]）。
        const openSrc = spec.bracket ? ('\\[' + n + nb + '[^\\]]*\\]') : ('<' + n + nb + '[^>]*>');
        const closeSrc = spec.bracket ? ('\\[\\/' + n + nb + '[^\\]]*\\]') : ('<\\/' + n + nb + '[^>]*>');
        const tokRe = new RegExp('(' + openSrc + ')|(' + closeSrc + ')', 'gi');
        const spans = [];
        let depth = 0, spanStart = -1, m;
        while ((m = tokRe.exec(prose)) !== null) {
            if (m[1] != null) {                                  // 开标签：深度 0→1 记起点，向上计数
                if (depth === 0) spanStart = m.index;
                depth += 1;
            } else if (depth > 0) {                              // 闭标签：向下计数，回到 0 即一整块配平
                depth -= 1;
                if (depth === 0) spans.push([spanStart, m.index + m[0].length]);
            }                                                    // 深度 0 的孤立闭合标签：忽略（留在 prose）
        }
        if (depth > 0 && spanStart >= 0) spans.push([spanStart, prose.length]);   // 截断：开了没闭 → 取到结尾
        if (!spans.length) return;
        let out = '', last = 0;
        for (const [a, b] of spans) {                            // 文档顺序遍历 → keepBlocks 文档顺序、占位标记落原位
            out += prose.slice(last, a);
            if (collect) { out += fixKeepPlaceholder(keepBlocks.length); keepBlocks.push(prose.slice(a, b)); }
            // drop：什么都不接（块被丢弃）
            last = b;
        }
        prose = out + prose.slice(last);
    };
    for (const spec of parseExcludeTags(keepStr)) pull(spec, true);
    for (const spec of parseExcludeTags(dropStr)) pull(spec, false);
    prose = prose.replace(/\n{3,}/g, '\n\n').trim();
    return { prose, keep: keepBlocks.join('\n\n'), keepBlocks };
}

// ✨ 校正「只校正 <content> 内」作用域（纯函数，单测钉 fix-content-scope.test.mjs）。
// splitContentScope —— 把回复按【正文标签】拆成「信封 + 内层正文」：prefix + <tag…> + inner + </tag> + suffix。
//   只有 inner 会送去校正，其余作为信封【逐字保留、原位回插】——绝不抽出重排，所以正文【外】的状态栏 / 选项 /
//   世界书 / htmlcontent 地图 / UpdateVariable / 占位符 全都原地不动（这正是「排除区逐个枚举又对嵌套同名标签失效」
//   的根治：反过来只圈定要改的正文，其余一律不动）。tag 为空 / 回复里找不到该标签 → {active:false}，调用方回退到
//   「校正整条回复」的旧行为（简单卡不受影响）。截断（只有 <tag> 没 </tag>）→ inner 取到结尾、close/suffix 空。
//   只作用域【第一处】<tag>…</tag>，其余留在 suffix（不丢、不改）。tag 名经 parseExcludeTagNames 容错
//   （content / <content> / </content> 等价）。<content> 不会误命中 <contentX>（nb 名字边界）。
function splitContentScope(reply, tagName) {
    const name = parseExcludeTagNames(tagName)[0] || '';
    if (!name) return { active: false };
    const text = String(reply == null ? '' : reply);
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
    const mo = text.match(new RegExp('<' + esc + nb + '[^>]*>', 'i'));
    if (!mo) return { active: false };
    const prefix = text.slice(0, mo.index);
    const open = mo[0];
    const rest = text.slice(mo.index + open.length);
    const mc = rest.match(new RegExp('<\\/' + esc + nb + '[^>]*>', 'i'));
    if (!mc) return { active: true, prefix, open, inner: rest, close: '', suffix: '' };   // 截断：内层取到结尾
    return { active: true, prefix, open, inner: rest.slice(0, mc.index), close: mc[0], suffix: rest.slice(mc.index + mc[0].length) };
}

// 把校正后的内层正文回插信封原位：prefix + <tag…> + innerFixed + </tag> + suffix。inactive → 直接返回 inner（无操作）。
function wrapContentScope(scope, innerFixed) {
    const inner = String(innerFixed == null ? '' : innerFixed);
    if (!scope || !scope.active) return inner;
    return scope.prefix + scope.open + inner + scope.close + scope.suffix;
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式「自动配置」Phase 1 —— 纯检测 + 判定层（无 DOM / 无副作用 / 确定；无时钟无随机）。
 * 后续 UI / 守卫阶段消费这些函数：自动嗅探卡片把正文包在哪个标签里（作用域标签），让用户不必手配。
 * 这里只建【纯函数】——扫描顶层配平块、算「正文字数」、给作用域判定。复用 extractExcludedSections 的
 * 深度配平 + nb 名字边界（<plan>≠<planning>、[IMG]≠[IMGX]）、splitContentScope 的拆分、parseExcludeTags
 * 的标签解析、tokenizeForDiff 的 CJK 分类【思路】，不另起炉灶。
 * ------------------------------------------------------------------ */

// 「正文字数」判定码点：CJK 表意文字 + ASCII 字母。数字 / 标点 / 全角符号【不算】——它们是结构化数据信号，
// 不是正文（镜像 tokenizeForDiff 的 isCJK/isWord，但只认表意文字与字母，故 HP:80 这类数值面板几乎为 0 分）。
function proseCharCount(text) {
    const s = String(text == null ? '' : text);
    let n = 0;
    for (let i = 0; i < s.length;) {
        const cp = s.codePointAt(i);
        i += cp > 0xffff ? 2 : 1;
        if ((cp >= 0x4e00 && cp <= 0x9fff) ||     // CJK 统一表意（一-鿿）
            (cp >= 0x3400 && cp <= 0x4dbf) ||     // CJK 扩展 A
            (cp >= 0xf900 && cp <= 0xfaff) ||     // CJK 兼容表意
            (cp >= 0x41 && cp <= 0x5a) ||         // A-Z
            (cp >= 0x61 && cp <= 0x7a)) n += 1;   // a-z
    }
    return n;
}

// 去掉嵌套标记（<…> / […] / {…}）后再数正文字数——让「几乎全是 HTML / JSON 的块」得低分、「叙事块」得高分
// （detectScopeTag 据此排名找正文包裹标签）。只剥标记【本身】，标记之间的文字保留。
function strippedProseChars(inner) {
    const stripped = String(inner == null ? '' : inner)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\{[^}]*\}/g, ' ');
    return proseCharCount(stripped);
}

// 纯函数：扫描 text 里【顶层】（深度 0）的配平块——尖括号 <name…>…</name> 与方括号 [NAME…]…[/NAME] 都认。
// 用一个栈：见开标签压栈（栈空时该块是一个顶层块的起点）；见闭标签，若栈中有同名（同分隔符）则一路出栈到它
// （自动闭合中间未闭的空元素，如 <br>），出栈到空 = 一个顶层块结束；栈里没有 = 孤立闭合，忽略。自闭合
// <name/> / [NAME/] 记为零内容顶层标记（selfClose，仅栈空时）。开了没闭（截断）→ 尖括号块取到结尾
// （方括号不做截断兜底——裸 [foo] 更可能是正文而非被截断的块）。名字边界用 nb（<plan>≠<planning>）。
// 返回 [{name,bracket,inner,selfClose,start,end}]，按文档顺序（start 升序），仅顶层。
function scanTopLevelBlocks(text) {
    const s = String(text == null ? '' : text);
    const nameCh = '[A-Za-z0-9_\\u4e00-\\u9fa5-]+';
    const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
    const re = new RegExp(
        '<\\/(' + nameCh + ')' + nb + '[^>]*>' +               // 1: 尖闭
        '|<(' + nameCh + ')' + nb + '([^>]*?)(\\/?)>' +        // 2 名 / 3 属性 / 4 斜杠：尖开
        '|\\[\\/(' + nameCh + ')' + nb + '[^\\]]*\\]' +        // 5: 方闭
        '|\\[(' + nameCh + ')' + nb + '([^\\]]*?)(\\/?)\\]',   // 6 名 / 7 属性 / 8 斜杠：方开
        'g');
    const blocks = [];
    const stack = [];   // { name, lower, bracket, openStart, innerStart }
    let m;
    while ((m = re.exec(s)) !== null) {
        const angleClose = m[1] != null;
        const angleOpen = m[2] != null;
        const bracketClose = m[5] != null;
        if (angleClose || bracketClose) {                       // —— 闭标签 ——
            const name = angleClose ? m[1] : m[5];
            const bracket = bracketClose;
            const lower = name.toLowerCase();
            let k = -1;
            for (let d = stack.length - 1; d >= 0; d -= 1) {
                if (stack[d].lower === lower && stack[d].bracket === bracket) { k = d; break; }
            }
            if (k === -1) continue;                             // 孤立闭合：忽略（留在正文）
            const opened = stack[k];
            stack.length = k;                                   // 出栈到 k（含）——自动闭合中间未闭的空元素
            if (stack.length === 0) {
                blocks.push({ name: opened.name, bracket: opened.bracket, inner: s.slice(opened.innerStart, m.index), selfClose: false, start: opened.openStart, end: m.index + m[0].length });
            }
        } else {                                                // —— 开标签 ——
            const name = angleOpen ? m[2] : m[6];
            const slash = angleOpen ? m[4] : m[8];
            const bracket = !angleOpen;
            if (slash === '/') {                                // 自闭合：仅栈空时记为顶层零内容标记
                if (stack.length === 0) blocks.push({ name, bracket, inner: '', selfClose: true, start: m.index, end: m.index + m[0].length });
                continue;
            }
            stack.push({ name, lower: name.toLowerCase(), bracket, openStart: m.index, innerStart: m.index + m[0].length });
        }
    }
    if (stack.length > 0 && !stack[0].bracket) {                // 截断：栈底【尖括号】块开了没闭 → 取到结尾
        const b = stack[0];
        blocks.push({ name: b.name, bracket: b.bracket, inner: s.slice(b.innerStart), selfClose: false, start: b.openStart, end: s.length });
    }
    blocks.sort((a, b) => a.start - b.start);
    return blocks;
}

// 纯函数：text 里【顶层】标签名数组（尖 + 方 + 自闭合），文档顺序，含重复（N 个块 = N 项）。
// fixScopeVerdict 用它列「正文外原样保留的块」；嵌套标签不计入。
function listTopLevelTagNames(text) {
    return scanTopLevelBlocks(text).map((b) => b.name);
}

// 已知【正文包裹】标签名（大小写不敏感）——命中即高置信（名字本身就是强信号）。小写常量以避开元测试「ALL_CAPS 须引用≥2次」规则。
const scopeKnownNames = new Set(['content', 'gametxt', '正文', 'story', 'text', 'narration', 'main', 'reply', 'msg']);
// 作用域【内层】里算【结构块】（保留区候选）的已知标签名（大小写不敏感，故存小写）。
const innerStructuralNames = new Set(['status', 'status_profile', 'item_info', 'char_info', 'options', 'branches', 'details', 'htmlcontent', 'updatevariable', 'img_gen', 'roll', 'bginfor', 'style', 'cestuff']);
// 「有意义的正文」阈值（字）——低于它视作结构化 / 空块（noWrapper 据此判定）。
const scopeProseMin = 20;

// 纯函数：给最近 ~5 条 AI 回复，嗅探卡片把正文包在哪个【作用域标签】里。
// 每条回复找顶层配平块，算其【剥除嵌套标记后】的正文字数；跨回复按标签名累加（共识——一次性块被稀释）。
// 排名：已知名优先，再按正文字数降序。置信：已知 / 单一正文块 / 主块≥2×次块 → high；1.2–2× → med；近似并列或 3+ 相近 → low；
// 全无【有意义正文】→ none + noWrapper（卡片只包结构化数据、正文是裸的）。nullish/空 → none + noWrapper + candidates 空。
// 返回 { tag, bracket, confidence, candidates:[{tag,proseChars,known,bracket}], noWrapper }。
function detectScopeTag(replies) {
    const list = Array.isArray(replies) ? replies : (replies == null || replies === '' ? [] : [replies]);
    if (!list.length) return { tag: '', bracket: false, confidence: 'none', candidates: [], noWrapper: true };
    const agg = new Map();   // lower → { tag, proseChars, known, bracket }
    for (const reply of list) {
        for (const b of scanTopLevelBlocks(reply)) {
            if (b.selfClose) continue;                          // 自闭合标记无正文，不作包裹候选
            const lower = b.name.toLowerCase();
            const prose = strippedProseChars(b.inner);
            const cur = agg.get(lower);
            if (cur) cur.proseChars += prose;
            else agg.set(lower, { tag: b.name, proseChars: prose, known: scopeKnownNames.has(lower), bracket: b.bracket });
        }
    }
    const candidates = [...agg.values()].sort((x, y) => {
        if (x.known !== y.known) return x.known ? -1 : 1;       // 已知名优先
        return y.proseChars - x.proseChars;                    // 再按正文字数降序
    });
    if (!candidates.length) return { tag: '', bracket: false, confidence: 'none', candidates: [], noWrapper: true };
    const prose = candidates.filter((c) => c.proseChars >= scopeProseMin).sort((x, y) => y.proseChars - x.proseChars);
    if (!prose.length) return { tag: '', bracket: false, confidence: 'none', candidates, noWrapper: true };   // 有块但全无有意义正文 → 结构化-only
    const top = candidates[0];
    let confidence;
    if (top.known) confidence = 'high';                         // 已知包裹名 = 强信号
    else if (prose.length <= 1) confidence = 'high';            // 独一份正文块
    else {
        const ratio = prose[0].proseChars / prose[1].proseChars;
        if (ratio >= 2) confidence = 'high';                    // 主块碾压次块
        else if (ratio < 1.2 || prose.length >= 3) confidence = 'low';   // 近似并列 / 多块混杂 → 说不准
        else confidence = 'med';                                // 有赢家但不算压倒
    }
    return { tag: top.tag, bracket: top.bracket, confidence, candidates, noWrapper: false };
}

// 标记密集：块内含 HTML 标签 / style= / { / [，且正文占比 < 0.5（叙事块几乎全是文字 → 占比高，不算结构）。
function isMarkupHeavy(text) {
    const s = String(text == null ? '' : text);
    if (!s) return false;
    const hasMarkup = /<[^>]+>/.test(s) || /style\s*=/.test(s) || s.indexOf('{') >= 0 || s.indexOf('[') >= 0;
    if (!hasMarkup) return false;
    // 正文占比以【剥除标记后】的正文字数为分子——HTML 标签名（div/style…）不是正文，不该计入。
    return strippedProseChars(s) / Math.max(1, s.length) < 0.5;
}

// 纯函数：作用域【内层】里的顶层块，返回其中的【结构块】[{name,bracket}]（保留区候选）。
// 结构块 = 名字在 innerStructuralNames，或【标记密集】（含 HTML / style= / { / [ 且正文占比低）。叙事块不返回。nullish → []。
function detectInnerBlocks(scopeInner) {
    if (scopeInner == null || String(scopeInner) === '') return [];
    const out = [];
    for (const b of scanTopLevelBlocks(scopeInner)) {
        const lower = b.name.toLowerCase();
        if (innerStructuralNames.has(lower)) { out.push({ name: b.name, bracket: b.bracket }); continue; }
        if (b.selfClose) continue;                              // 非已知的自闭合标记：跳过（无内容可判）
        if (isMarkupHeavy(b.inner)) out.push({ name: b.name, bracket: b.bracket });
        // 否则叙事块，跳过
    }
    return out;
}

// 纯函数：某标签是否作为【开标签】出现在 text 里（nb 名字边界；尖 / 方按 spec.bracket）。
function tagPresentIn(text, spec) {
    const esc = spec.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
    return new RegExp((spec.bracket ? '\\[' : '<') + esc + nb, 'i').test(String(text == null ? '' : text));
}

// 纯函数：作用域校正【判定】——tag 命中则只校正正文（绿），否则会校正整条（红，danger）。
//   命中：fixChars = 内层正文字数；preservedTags = 正文【外】(prefix+suffix) 的顶层标签；
//         keepBlockCount = keepTags 里有几个真出现在内层（用户排除区命中数）。
//   未命中 / 空 tag：danger=true，fixChars=0，preservedTags = 整条回复的顶层标签（提示这些都会被送进模型），keepBlockCount=0。
function fixScopeVerdict(reply, tag, keepTags) {
    const tagName = parseExcludeTagNames(tag)[0] || '';
    const scope = splitContentScope(reply, tag);
    if (!tagName || !scope || !scope.active) {
        const message = tagName
            ? '⚠ 未找到 <' + tagName + '> → 会校正【整条】回复（含状态栏/选项/世界书）。请检查作用域标签。'
            : '⚠ 未设作用域 → 会校正【整条】回复（含状态栏/选项/世界书）。请检查作用域标签。';
        return { active: false, danger: true, fixChars: 0, preservedTags: listTopLevelTagNames(reply), keepBlockCount: 0, message };
    }
    let keepBlockCount = 0;
    for (const spec of parseExcludeTags(keepTags)) if (tagPresentIn(scope.inner, spec)) keepBlockCount += 1;
    const fixChars = proseCharCount(scope.inner);
    const preservedTags = listTopLevelTagNames(scope.prefix + '\n' + scope.suffix);   // \n 分隔，避免前后缀边界处 token 误粘
    const message = '作用域 <' + tagName + '> ✓ 命中 → 只校正正文 ' + fixChars + ' 字，正文外 ' + preservedTags.length + ' 块原样保留';
    return { active: true, danger: false, fixChars, preservedTags, keepBlockCount, message };
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式「自动配置」Phase 2 —— 配置健全性 PURE 层（无 DOM / 无副作用 / 确定；无时钟无随机）。
 * 给「作用域标签 / 保留区 / 丢弃区 / 校正目标 / 成本门字符数 / 套餐快照」几类常见误配置做纯函数体检。
 * 能自动纠正的就纠正（normalizeScopeInput 清洗单标签输入、clampFixAutoMinChars 钳制范围、
 * filterBundleCfg 剔除不该进套餐快照的键）；纠正不了的用 fixConfigWarnings 给出「码 + 人话 +
 * 定位字段」，delimiterMismatch 额外附 suggest（供后续 UI 阶段一键采纳）。复用 Phase 1 的
 * scanTopLevelBlocks（顶层配平块扫描，含尖 / 方括号）+ 既有 parseExcludeTags（保留/丢弃区解析）
 * + parseExcludeTagNames（标签名清洗字符集），不另起炉灶。这一层只报警，不写入任何设置——
 * 后续 UI / 守卫阶段消费这里的输出。
 * ------------------------------------------------------------------ */

// 纯函数：把「作用域标签」输入框的原始文本归一成【单个】干净标签名。容错：多词（逗号 / 换行 / 空白
// 分隔）只取第一个；剥掉两端的 < [ / > ] 包装；再按标签名字符集（同 parseExcludeTagNames，含中文）
// 截取。没有可用内容 → ''。fixConfigWarnings 用它判「保留/丢弃区误填了正文标签」；也供后续阶段给
// 作用域标签输入框失焦即清洗用。
function normalizeScopeInput(str) {
    const first = String(str == null ? '' : str).split(/[,\n\s]+/).filter(Boolean)[0] || '';
    const bare = first.replace(/^[<[/]+/, '').replace(/[/>\]]+$/, '');
    const m = bare.match(/^[A-Za-z0-9_一-龥-]+/);
    return m ? m[0] : '';
}

// 纯函数：把「成本门字符数」fixAutoMinChars 钳到 [50, 2000] 合理区间（四舍五入取整）。
// 解析不出有限数字（null / undefined / 空串 / 纯空白 / 非数字字符串 / NaN / Infinity）→ 回退
// 字段默认值 200——而不是钳到下限 50。「解析不出数字」= 没配置 / 输入垃圾，该当默认值；跟「用户
// 明明白白填了个 0 或负数」（钳到地板 50）是两回事，不能混为一谈。
function clampFixAutoMinChars(value) {
    if (value === null || value === undefined) return 200;
    if (typeof value === 'string' && value.trim() === '') return 200;
    const n = Number(value);
    if (!Number.isFinite(n)) return 200;
    return Math.min(2000, Math.max(50, Math.round(n)));
}

// 纯函数：套餐（bundle）快照前过滤 cfg——剔除 fixA_scopeTag（作用域标签是【卡片专属】，换一张
// 卡片套用别人的套餐不该带着别人的标签一起来）、fixA_scopeManual（Phase 5：这个标签是不是当前卡片
// 手填过，同样是【卡片专属】的来源痕迹，换卡也不该带过去——否则新卡会被误当成「用户手填过」，
// 缓存未命中时 resolveFixScope 就只会 suggest 不会自我纠正）与 autoFixEnabled（是否自动校正是
// 【模式开关】，套餐不该替用户悄悄打开后台自动改写）。浅拷贝出新对象，不改 cfg 本身；nullish / 非对象 → {}。
function filterBundleCfg(cfg) {
    const out = {};
    if (!cfg || typeof cfg !== 'object') return out;
    for (const k of Object.keys(cfg)) {
        if (k === 'fixA_scopeTag' || k === 'fixA_scopeManual' || k === 'autoFixEnabled') continue;
        out[k] = cfg[k];
    }
    return out;
}

// 纯函数：✨ 校正「自动模式」配置健全性检查——扫一遍常见误配置，给「码 + 人话 + 定位字段」，
// delimiterMismatch 额外带 suggest（纠正后的分隔符形式，供后续 UI 阶段一键采纳）。cfg = 原始
// fixA_* 形状（未经 resolveFixModeCfg 归一）；reply 可空——给了才跑「跨度占比」「分隔符是否真的
// 出现」这两类需要正文的检查，名字撞作用域标签那条不需要 reply。scanTopLevelBlocks(reply) 只扫一次，
// 同喂两类检查。只报警，不写任何东西。
//   scopeInKeep —— 保留 / 丢弃区某项名字 === 归一后的作用域标签（大小写不敏感），或者（给了 reply
//     时）它本身是回复里一个顶层配平块、且跨度 ≥ wrapperRatioMin（回复的大半个身子）——多半是正文
//     外壳本身被错填进了保留 / 丢弃区，而不是真正想排除的一小块。
//   zeroTargetAuto —— 自动校正开着，但 5 个校正目标 + 角色知识边界 / 剧情护栏两条约束全空，跑了
//     也是空转。field 固定为哨兵 'targets'（UI 据此整体置灰运行按钮，不是指某一个目标勾选框）。
//   delimiterMismatch —— 保留 / 丢弃区某项按它填的分隔符（尖 / 方括号）在回复顶层找不到同名块，
//     换个分隔符却有——多半是尖括号方括号打错了，suggest 给纠正后的形式。
function fixConfigWarnings(cfg, reply) {
    const c = cfg || {};
    const warnings = [];
    const wrapperRatioMin = 0.6;   // 顶层块跨度 / 回复总长 ≥ 此值 → 判定为「正文外壳」而非真正的排除小块
    const targetKeys = ['fixA_targetSlop', 'fixA_targetDialogue', 'fixA_targetPrecision', 'fixA_targetMagic', 'fixA_targetPacing'];

    const hasReply = reply != null && reply !== '';
    const replyLen = hasReply ? String(reply).length : 0;
    const scopeName = normalizeScopeInput(c.fixA_scopeTag).toLowerCase();
    // 外壳占比检查看【整条回复】的顶层块（rawBlocks，需原始偏移量算跨度）。分隔符检查看的块集合 keepBlocks =
    // 顶层同级块 + 作用域命中时的内层直接子块——后者与运行时 extractExcludedSections 跑在 fixScope.inner 上一致，
    // 故能看见埋在 <gametxt> 里的 [IMG_GEN] 等；前者兼顾正文外壳之外的同级块。只做「名+分隔符」存在性判断，重复无害。
    const rawBlocks = hasReply ? scanTopLevelBlocks(reply) : [];
    const scope = (hasReply && scopeName) ? splitContentScope(reply, scopeName) : null;
    const keepBlocks = (scope && scope.active) ? rawBlocks.concat(scanTopLevelBlocks(scope.inner)) : rawBlocks;

    for (const field of ['fixA_keepTags', 'fixA_dropTags']) {
        for (const spec of parseExcludeTags(c[field])) {
            const lower = spec.name.toLowerCase();

            const nameHitsScope = !!scopeName && lower === scopeName;
            const isWrapperBlock = hasReply && rawBlocks.some((b) =>
                b.bracket === spec.bracket && b.name.toLowerCase() === lower && (b.end - b.start) / replyLen >= wrapperRatioMin);
            if (nameHitsScope || isWrapperBlock) {
                warnings.push({ code: 'scopeInKeep', field, message: '这个是正文标签，应填到上面『只校正此标签内』，不是保留区' });
                continue;   // 已经因为这条目报过警，不必再查它的分隔符
            }

            if (hasReply) {
                const sameBracketHit = keepBlocks.some((b) => b.bracket === spec.bracket && b.name.toLowerCase() === lower);
                if (!sameBracketHit) {
                    const oppo = keepBlocks.find((b) => b.bracket !== spec.bracket && b.name.toLowerCase() === lower);
                    if (oppo) {
                        const typedForm = spec.bracket ? ('[' + spec.name + ']') : ('<' + spec.name + '>');
                        const actualForm = oppo.bracket ? ('[' + oppo.name + ']') : ('<' + oppo.name + '>');
                        warnings.push({
                            code: 'delimiterMismatch', field,
                            message: '你填的是 ' + typedForm + '，但回复里实际出现的是 ' + actualForm + '——分隔符不匹配，这条保留/丢弃不会生效',
                            suggest: actualForm,
                        });
                    }
                }
            }
        }
    }

    if (c.autoFixEnabled) {
        const noTargets = targetKeys.every((k) => !c[k]);
        const noConstraints = !String(c.fixA_knowledgeBoundary || '').trim() && !String(c.fixA_guardrails || '').trim();
        if (noTargets && noConstraints) {
            warnings.push({ code: 'zeroTargetAuto', field: 'targets', message: '没勾任何校正目标，自动校正不会做事' });
        }
    }

    return warnings;
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式 Phase 4 —— 「看改动」卡片背后的前后差异引擎。
 * 纯函数，无时钟、无 DOM、确定。replies 很短，O(n·m) DP 足矣。
 * ------------------------------------------------------------------ */

// 纯函数：把文本切成适合做差异的 token。目标：一句中文逐字 diff，但拉丁词整块不被拆成单字母。
// 规则：① CJK 单字（含常见 CJK 标点 / 全角区）各自成一个 token；② ASCII/拉丁【字母+数字】连续串
// 合成一个 token；③ 每段空白（含全角空格交给 CJK 规则）合成一个 token；④ 其余任意单字符（标点 /
// 符号）各自成一个 token。把返回的 token 顺序拼接必须【逐字还原】原文。nullish 安全。
function tokenizeForDiff(text) {
    const s = String(text == null ? '' : text);
    const tokens = [];
    // CJK：统一表意文字 + 扩展 A + 兼容表意 + CJK 符号标点(　-〿) + 全角 / 半角形式(＀-￯)。
    // 单字成 token = 逐字 diff 的关键。
    const isCJK = (cp) =>
        (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs（一-鿿）
        (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Ext-A
        (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compatibility Ideographs
        (cp >= 0x3000 && cp <= 0x303f) ||   // CJK Symbols & Punctuation（　-〿，含。、「」等）
        (cp >= 0xff00 && cp <= 0xffef);     // Halfwidth & Fullwidth Forms（＀-￯，含全角！？，等）
    // 拉丁词字符：ASCII 字母 + 数字（连成一个整词，不逐字母 diff）。
    const isWord = (cp) =>
        (cp >= 0x30 && cp <= 0x39) ||       // 0-9
        (cp >= 0x41 && cp <= 0x5a) ||       // A-Z
        (cp >= 0x61 && cp <= 0x7a);         // a-z
    const isSpace = (ch) => /\s/.test(ch);

    let i = 0;
    while (i < s.length) {
        const cp = s.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        const step = ch.length;             // 代理对占 2 个 UTF-16 单元
        if (isCJK(cp)) {                     // ① CJK 单字成 token
            tokens.push(ch);
            i += step;
        } else if (isWord(cp)) {             // ② 拉丁字母 / 数字串整块
            let j = i;
            while (j < s.length && isWord(s.codePointAt(j))) j += 1;
            tokens.push(s.slice(i, j));
            i = j;
        } else if (isSpace(ch)) {            // ③ 空白串整块
            let j = i;
            while (j < s.length) {
                const c = String.fromCodePoint(s.codePointAt(j));
                if (!isSpace(c)) break;
                j += c.length;
            }
            tokens.push(s.slice(i, j));
            i = j;
        } else {                             // ④ 其余单字符（标点 / 符号 / 非 CJK 表意外字）各自成 token
            tokens.push(ch);
            i += step;
        }
    }
    return tokens;
}

// 纯函数：算出 before→after 的差异段。先各自分词，对两串 token 做最长公共子序列（O(n·m) DP），
// 回溯成 equal/del/ins 段，相邻同型合并，每段把 token 拼回成 text。确定、可复现。
// 一个被替换的跨度【先发 del（before 的 token）后发 ins（after 的 token）】。nullish → 同空串处理。
function diffSegments(before, after) {
    const a = tokenizeForDiff(before);   // before tokens（del 的来源）
    const b = tokenizeForDiff(after);    // after tokens（ins 的来源）
    const n = a.length;
    const m = b.length;

    // LCS DP 表：dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度（从尾部建表，便于正向回溯）。
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            dp[i][j] = a[i] === b[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    // 正向回溯成原始（未合并）操作序列。平手时优先「向下」(del) 再「向右」(ins)，
    // 保证被替换跨度里 del 整体排在 ins 之前。
    const raw = [];   // { type, text }，每个 text 是单个 token
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            raw.push({ type: 'equal', text: a[i] });
            i += 1;
            j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            raw.push({ type: 'del', text: a[i] });
            i += 1;
        } else {
            raw.push({ type: 'ins', text: b[j] });
            j += 1;
        }
    }
    while (i < n) { raw.push({ type: 'del', text: a[i] }); i += 1; }   // before 尾巴 → 全删
    while (j < m) { raw.push({ type: 'ins', text: b[j] }); j += 1; }   // after 尾巴 → 全增

    // 合并相邻同型段，把每段的 token 拼回 text。
    const segments = [];
    for (const op of raw) {
        const last = segments[segments.length - 1];
        if (last && last.type === op.type) last.text += op.text;
        else segments.push({ type: op.type, text: op.text });
    }
    return segments;
}

// 把 diffSegments(before, after) 渲染成一张内联差异卡（<div.so-diff-card>）：equal 段普通文字、del 段
// 划掉红、ins 段绿。文本一律走 textContent（差异文本不可信，绝不 innerHTML）。返回未挂载的元素，由调用方插入。
function renderDiffCard(before, after) {
    const card = document.createElement('div');
    card.className = 'so-diff-card';
    for (const seg of diffSegments(String(before == null ? '' : before), String(after == null ? '' : after))) {
        const span = document.createElement('span');
        if (seg.type === 'del') span.className = 'so-diff-del';
        else if (seg.type === 'ins') span.className = 'so-diff-ins';
        span.textContent = seg.text;
        card.appendChild(span);
    }
    return card;
}

// 纯函数：把原回复里的机制块（<UpdateVariable> + 状态栏占位符）原样接回校正稿，让校正后的 swipe
// 仍携带 MVU 更新 + 触发状态栏。CoT 不接回——那是原回复的推理，与校正无关。幂等。可单测。
// keepBlocks（用户「排除·保留」区抠出的块）：数组形态按 ⟦SO_KEEP_n⟧ 标记还原到【原位】（模型弄丢则兜底接到
// 末尾，不丢内容）；字符串形态（旧调用）整体接到末尾。两者都先于机制块。
function composeFixedReply(fixedProse, originalReply, keepBlocks) {
    let out = String(fixedProse || '').trim();
    const orig = String(originalReply || '');
    // 第三参可为【数组】(新：按占位标记 ⟦SO_KEEP_n⟧ 把保留块还原到【原位】) 或【字符串】(旧调用：整体接到末尾，向后兼容)。
    const blocks = Array.isArray(keepBlocks)
        ? keepBlocks
        : (String(keepBlocks || '').trim() ? [String(keepBlocks).trim()] : []);
    const tail = [];
    blocks.forEach((blk, i) => {
        const b = String(blk == null ? '' : blk);
        const ph = fixKeepPlaceholder(i);
        if (out.includes(ph)) out = out.replace(ph, () => b);     // 还原到占位标记的原始位置（只换第一个；重复标记交给下面的扫除）
        else if (b && !out.includes(b)) tail.push(b);             // 标记被模型弄丢 → 兜底接到末尾（不丢内容）
    });
    out = stripFixKeepMarks(out);                                 // 清掉残留 / 重复 / 臆造的孤儿占位标记，绝不让标记漏进正文
    if (tail.length) out = out.trimEnd() + '\n\n' + tail.join('\n\n');
    const block = extractUpdateBlock(orig);
    if (block && !out.includes(block)) out = out.trimEnd() + '\n\n' + block;
    if (orig.includes(STATUS_PLACEHOLDER) && !out.includes(STATUS_PLACEHOLDER)) out = out.trimEnd() + '\n\n' + STATUS_PLACEHOLDER;
    return out;
}

// Apply a corrective <UpdateVariable> block through MVU's own pipeline.
// Returns a snapshot of the pre-apply data (for undo), or null on failure.
async function applyFix(patchBlock, statusEl) {
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.parseMessage !== 'function') {
        statusEl.textContent = '未检测到 MVU —— 无法自动应用。';
        statusEl.classList.add('so-hint-error');
        return null;
    }
    const opts = { type: 'message', message_id: 'latest' };
    const oldData = Mvu.getMvuData(opts);
    const snapshot = JSON.parse(JSON.stringify(oldData));
    const newData = await Mvu.parseMessage(patchBlock, oldData);
    if (!newData) {
        statusEl.textContent = '补丁未解析出任何改动 —— 请检查指令。';
        statusEl.classList.add('so-hint-error');
        return null;
    }
    await Mvu.replaceMvuData(newData, opts);
    refreshLatestMvuBar();   // 应用后刷新楼层状态栏（replaceMvuData 不发刷新事件，否则要手动重载——用户反馈）
    return snapshot;
}

async function undoFix(snapshot) {
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.replaceMvuData !== 'function') throw new Error('MVU not available');
    await Mvu.replaceMvuData(snapshot, { type: 'message', message_id: 'latest' });
    refreshLatestMvuBar();   // 撤销后同样刷新，免得状态栏停在已应用值
}

/* ------------------------------------------------------------------ *
 * 用户功能请求：自动诊断 + ✨ 校正模式 Phase 3 —— 统一的「回复后编排」。
 * 每收到一条新的主聊天 AI 回复，就在【单一共享锁】下按固定顺序跑：先自动校正（润色 / 换 swipe），
 * 后自动诊断（确有错误时经 MVU 自动应用修复）。诊断【在后】是刻意的：它读到的是已校正后的正文（§5.10）。
 * 两者各自全程无界面：自建提示词（不碰窗口共享状态）、非流式调用，仅在确有改动时落地。
 * ⚠ 诊断与 MVU「额外模型解析」不兼容（那时更新由另一模型异步解析、不在正文里）——开启时已警告。
 * ------------------------------------------------------------------ */
let postReplyBusy = false;         // 单一共享锁：自动校正与自动诊断不得并发抢占同一条回复
let autoDiagErrorToasted = false;  // 诊断错误 toast 每会话只弹一次，免得每条回复都打扰
let postReplyAbortCtl = null;      // 当前在途的「回复后」自动调用（自动校正 / 自动诊断）的中断器（120s 超时 + 用户中断共用）
let postReplyCancelled = false;    // 用户点了「正在自动…」提示里的中断 → 跳过本轮剩余步骤（如自动校正被中断后不再接着自动诊断）

// 仿 arcBeginCall：把在途调用的中断器挂到模块级，让「正在自动校正 / 诊断…」提示可点一下中断它（ms = 超时兜底）。
function beginPostReplyCall(ms) {
    let ctl = null;
    try { ctl = new AbortController(); } catch (e) { return { signal: undefined, end() {} }; }
    postReplyAbortCtl = ctl;
    let timer = null;
    try { timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, ms); } catch (e) { /* 无 timers 环境 */ }
    return { signal: ctl.signal, end() { if (timer) clearTimeout(timer); if (postReplyAbortCtl === ctl) postReplyAbortCtl = null; } };
}
// 用户点提示「中断」：作废本轮（让 maybePostReply 跳过剩余步骤）+ 中断在途调用。自动校正与自动诊断共用同一个。
function cancelPostReply() {
    postReplyCancelled = true;
    try { if (postReplyAbortCtl) postReplyAbortCtl.abort(); } catch (e) { /* ignore */ }
}

// 纯决策核（零回归证据核，单测在 fix-orchestrator.test.mjs）：给定两个杀死开关 flags={fix,diag}
// 与设置 s，返回按执行顺序排好的处理器名数组。'fix' 在前、'diag' 在后；某项要跑当且仅当
// 「杀死开关开 且 对应设置开」。【false 开关压过 true 设置】。nullish 安全（flags / s 缺省即按未开处理）。
// 诊断单开（autoFixEnabled:false）时计划恒为 ['diag']，与旧 maybeAutoDiagnose 的门控严格等价。
function postReplyPlan(flags, s) {
    const plan = [];
    if (flags && flags.fix && s && s.autoFixEnabled) plan.push('fix');
    if (flags && flags.diag && s && s.autoDiagnoseEnabled) plan.push('diag');
    return plan;
}

// message_received 监听的落点：在共享锁下，对一条 AI 回复按 postReplyPlan 顺序跑校正 / 诊断。
async function maybePostReply(messageId) {
    const ctx = getCtx(); if (!ctx) return;
    const s = getSettings();
    // 编排门控：autoFixEnabled 走【本聊天】生效配置（Phase 4 per-chat 迁移）；autoDiagnoseEnabled
    // 不迁移、仍读全局 s。postReplyPlan 保持纯函数——这里把两者拼成它要读的 {autoFixEnabled, autoDiagnoseEnabled}。
    const cfg = getEffectiveFixCfg(s, getFixCfg());
    const gate = { autoFixEnabled: cfg.autoFixEnabled, autoDiagnoseEnabled: s.autoDiagnoseEnabled };
    const plan = postReplyPlan({ fix: ENABLE_REPLY_FIX, diag: ENABLE_AUTO_DIAGNOSE }, gate);
    if (!plan.length) return;                               // 两个杀死开关 / 两个设置都没开 → 不做事、不动模型
    if (postReplyBusy || isGenerating) return;              // 共享锁 + 不在主聊天生成中途插手
    const idx = Number(messageId); const m = (ctx.chat || [])[idx];
    if (!m || m.is_user || m.is_system) return;             // 只处理 AI 回复（排除用户 / 系统消息）
    postReplyBusy = true;
    postReplyCancelled = false;                                 // 每轮开始清零；用户点提示「中断」会把它置真
    try {
        // 给 MVU 先消化这条回复的更新，再读取权威状态（诊断的额外模型解析模式本就不支持）。
        // 校正与诊断共用这一次 settle（不另加延时），复用诊断既有的 autoDiagnoseDelayMs。
        await new Promise((r) => setTimeout(r, Math.max(0, (s.autoDiagnoseDelayMs | 0) || 1200)));
        for (const step of plan) {
            if (postReplyCancelled) break;                      // 用户已中断 → 跳过剩余步骤（如校正被中断后不再自动诊断）
            try {
                if (step === 'fix') await runAutoFix(ctx, s, idx);
                else await runAutoDiagnose(ctx, s, idx);
            } catch (e) {
                if (postReplyCancelled) break;                  // 用户点「中断」导致的 abort → 静默收尾，不当报错
                console.warn(`[Story Oracle] 自动${step === 'fix' ? '校正' : '诊断'}失败：`, e);
                // 沿用诊断的「每会话一次」错误 toast（校正的失败已在其侧聊记录里反映，不再额外打扰）。
                if (step === 'diag' && !autoDiagErrorToasted) {
                    autoDiagErrorToasted = true;
                    try { window.toastr && window.toastr.warning && window.toastr.warning('故事神谕：自动诊断这一轮没跑成（详见控制台）。后续回复会继续尝试。', '自动诊断'); } catch (e2) { /* ignore */ }
                }
            }
        }
    } finally {
        // 用户中断：给一句确认（abort 发生在写入之前，故这条回复未被改动）。
        if (postReplyCancelled) { try { window.toastr && window.toastr.info && window.toastr.info('已中断本轮自动处理（未改动这条回复）。', '故事神谕'); } catch (e) { /* ignore */ } }
        postReplyCancelled = false;
        postReplyBusy = false;
    }
}

// 后台诊断主体：自建诊断提示词 → 调模型 → 解析出修正区块 → 仅在确有改动时经 MVU 应用。
async function runAutoDiagnose(ctx, s, targetId) {
    const Mvu = await getMvu();
    if (!Mvu) return;                                       // 没有 MVU 就没什么可诊断
    // 连接没配好就静默退出——别让每条回复都报错（开自动模式的人一般已配好直连 / 配置文件）。
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) return;
    if (s.mode === 'profile' && !s.profileId) return;

    // 自建诊断上下文（不碰窗口共享的 worldInfoBlock / diagStatData / diagLatestUpdate）。
    let wiBlock;
    if (diagPickerActive()) {
        // 精选模式（用户功能请求）：只喂本聊天挑选的条目（无视启用 / 禁用；L2 混合并入当前命中绿灯），不自动补规则。
        wiBlock = (await buildDiagSelectedWi()).block;
    } else {
        wiBlock = await buildWorldInfo(wiContextMode(s));
        const mvuRules = await collectMvuUpdateRules(wiBlock);
        if (mvuRules.length) wiBlock = [wiBlock, ...mvuRules].filter(Boolean).join('\n\n');
    }
    const stat = await getMvuStatData();
    const statStr = stat ? JSON.stringify(stat, null, 2) : '';
    // 钉住触发本轮的消息（maybePostReply 传入 targetId）：避免延时 + 调用窗口内队尾变化时诊断落到上一条；
    // 无 id（不应发生，防御性）→ 回退最近一条，保持旧行为。
    const { idx: aiIdx, text: latestReply } = (targetId != null)
        ? resolveAutoTargetMessage(ctx.chat, targetId)
        : getLatestAiMessage();
    if (!latestReply.trim()) return;                        // 没有可分析的 AI 回复（或触发消息已失效 → 干净跳过）
    const latestBlock = extractUpdateBlock(latestReply);
    // 关键：正文里没有内联 <UpdateVariable> 也【不退出】——此时自动诊断改为据回复正文【推导】本回合
    // 的更新，充当 MVU「额外模型解析」的替代（用户要的正是这个：不开额外模型解析，靠自动诊断补出更新）。
    const systemPrompt = buildDiagnosePromptFrom(ctx, s, { wiBlock, statStr, latestBlock, latestReply, auto: true });
    const userMsg = latestBlock
        ? '【自动诊断】最新一条 AI 回复里带有 <UpdateVariable> 更新。请按本卡 MVU 规则与当前状态核验它：有错就只输出一个修正后的 <UpdateVariable> 区块（仅含需改正的字段）；完全正确则在 <JSONPatch> 里输出空数组（[]）。'
        : '【自动诊断】最新一条 AI 回复的正文里【没有】变量更新区块。请充当变量更新引擎：通读这条回复，依本卡 MVU 规则与当前状态，推导出本回合应当发生的全部变量更新，输出一个 <UpdateVariable> 区块把状态更新到位；若这条回复确实不涉及任何变量变化，则在 <JSONPatch> 里输出空数组（[]）。';
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
    ];

    const effMaxTokens = Math.max(s.maxTokens, 4096);
    const ctl = beginPostReplyCall(120000);      // 模块级中断器：120s 超时兜底 + 让「正在自动诊断…」提示可点一下中断
    const genToast = showAutoDiagGenerating();   // 「正在分析…（点此中断）」——点一下即 cancelPostReply
    let finalText = '';
    try {
        if (s.mode === 'direct') {
            const body = { model: s.model, messages, max_tokens: effMaxTokens };
            if (s.sendTemperature) body.temperature = s.temperature;
            finalText = await callDirect(normalizeUrl(s.endpoint), s.apiKey, body, ctl.signal);
        } else {
            const override = s.sendTemperature ? { temperature: s.temperature } : {};
            finalText = await callProfile(s.profileId, messages, effMaxTokens, override, ctl.signal);
        }
    } finally {
        ctl.end();
        dismissToast(genToast);   // 无论成功 / 失败 / 抛错，都收掉「正在诊断」提示
    }

    // 用户功能请求：每跑完一轮都留一条记录（含「无需改动」）。改动 → 带补丁 + 撤销按钮；无改动 / 失败 → 一句话。
    const patchBlock = extractUpdateBlock(finalText);
    const result = patchBlock ? await autoApplyFix(Mvu, patchBlock) : { status: 'nochange' };
    // 确有改动 → 把结果反映到消息 / 状态栏（auto 诊断走 replaceMvuData，不发刷新事件，状态栏不会自己更新）：
    //   衍生（乙，原回复无块）：写回推导块 + saveChat + 重渲染（与官方 MVU 更新一致）；
    //   核验（甲，原回复已有块）：只重渲染刷新状态栏，不碰消息正文（避免出现两个更新块）。
    if (AUTO_DIAGNOSE_WRITE_BACK && result.status === 'applied' && aiIdx >= 0) {
        if (!latestBlock) await writeUpdateBlockToMessage(aiIdx, patchBlock);
        else refreshMessageBar(aiIdx);
    }
    notifyAutoDiagnose(result, patchBlock);
}

// 自动应用修复：解析补丁。回 {status:'applied', snapshot}（确有改动、已写入）/ {status:'nochange'}
// （解析成功但与现状无差，no-op）/ {status:'failed'}（无 MVU 或没解析出数据）。
async function autoApplyFix(Mvu, patchBlock) {
    if (!Mvu || typeof Mvu.parseMessage !== 'function') return { status: 'failed' };
    const opts = { type: 'message', message_id: 'latest' };
    const oldData = Mvu.getMvuData(opts);
    const snapshot = JSON.parse(JSON.stringify(oldData));
    const newData = await Mvu.parseMessage(patchBlock, oldData);
    if (!newData) return { status: 'failed' };
    if (JSON.stringify(newData) === JSON.stringify(oldData)) return { status: 'nochange' };   // no-op
    await Mvu.replaceMvuData(newData, opts);
    return { status: 'applied', snapshot };
}

// 重渲染该 AI 消息，让前端状态栏反映这次自动诊断的写入。auto 诊断经 Mvu.replaceMvuData 写库，而它【不发】
// VARIABLE_UPDATE_ENDED（官方更新走 MVU 更新引擎才发），状态栏不会自己刷新；重渲染（ctx.updateMessageBlock →
// 重跑 messageFormatting / 卡片 <StatusPlaceHolderImpl/> 状态栏正则）令其读取刚写入的 display_data 而刷新。
// MVU 只在 MESSAGE_RECEIVED/SENT 解析更新块，重渲染不触发其重解析，故不二次写库。衍生与核验两情形共用；
// 卡片侧状态栏实现各异，视觉刷新仍需真卡验证。
function refreshMessageBar(idx) {
    const ctx = getCtx();
    const m = (ctx.chat || [])[idx];
    if (!m) return;
    try { if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(idx, m); }
    catch (e) { console.warn('[Story Oracle] 自动诊断后重渲染消息失败：', e); }
    // updateMessageBlock 只把 .mes_text 重渲染成状态栏 HTML 代码块；【酒馆助手】要收到 MESSAGE_UPDATED 才会把那段
    // HTML 真正渲染成 iframe（运行其 <script>）——其消息 iframe 渲染器（JS-Slash-Runner store/iframe_runtimes/
    // message.ts）正监听 CHARACTER/USER_MESSAGE_RENDERED / MESSAGE_UPDATED / MESSAGE_SWIPED。不补发它，状态栏就停在
    //「原始 HTML 代码」（用户手动编辑→保存能修，正因为保存会发 MESSAGE_UPDATED）。故重渲染后补发。MVU 只听
    // MESSAGE_RECEIVED/SENT，不会被它二次触发（不会重解析 / 二次写库）。
    try {
        const et = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && typeof ctx.eventSource.emit === 'function') {
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_UPDATED || 'message_updated', idx)).catch(() => {});
        }
    } catch (e) { console.warn('[Story Oracle] 自动诊断后发 MESSAGE_UPDATED 失败：', e); }
}

// 手动诊断「应用 / 撤销」后刷新楼层状态栏。手动 applyFix / undoFix 也走 Mvu.replaceMvuData 写库，它同样【不发】
// VARIABLE_UPDATE_ENDED，状态栏（卡片 <StatusPlaceHolderImpl/> iframe）不会自己更新 —— 用户得手动点「重新读取
// 初始变量」才看到新数据（用户反馈：茶茶）。自动诊断早有 refreshMessageBar 兜底，手动这条路一直没接上（pre-1.17.0
// 备份里也没有，是历史欠账，非校正改动所致）。这里对最新一条 AI 消息（= MVU 'latest' 指向的那条）复用同一刷新
// （重渲染 + 补发 MESSAGE_UPDATED，让酒馆助手重建状态栏 iframe）。尽力而为：拿不到目标 / 重渲染失败都不影响数据已写入。
function refreshLatestMvuBar() {
    try {
        const { idx } = getLatestAiMessage();
        if (idx >= 0) refreshMessageBar(idx);
    } catch (e) { console.warn('[Story Oracle] 诊断应用 / 撤销后刷新状态栏失败：', e); }
}

// 纯函数：把 block（+ 可选状态栏占位符 placeholder）幂等追加到 m.mes，并【镜像到当前 swipe 槽】。
// 为什么要镜像：校正模式把校正稿换成了新 swipe（addSwipeToMessage），此时 m.mes 与 m.swipes[swipe_id]
// 指向同一文本；若只改 m.mes 不改槽，下一次 swipe 重渲染会从 m.swipes[swipe_id] 取回旧文本 → 追加的更新块
// 被丢弃。故：追加完 m.mes 后，若有 swipes 数组且当前槽是字符串，把当前槽对齐成 m.mes。
// 幂等（!includes 守卫）；无 swipes 时退化为「只动 m.mes」（与改写前的写回逐字节相同）。返回新的 m.mes。
function applyBlockToCurrentSwipe(m, block, placeholder) {
    if (!m || typeof m.mes !== 'string') return m ? m.mes : '';
    if (block && !m.mes.includes(block)) {                   // 幂等：已写过就不重复追加
        m.mes = m.mes.trimEnd() + '\n\n' + block;
    }
    // 再补上 MVU 状态栏占位符（衍生情形 MVU 没跑、不会自己加它）——否则有更新块也不出状态栏（见 STATUS_PLACEHOLDER）。
    if (placeholder && !m.mes.includes(placeholder)) {
        m.mes = m.mes.trimEnd() + '\n\n' + placeholder;
    }
    // 镜像到当前 swipe 槽（仅当存在 swipes 数组且当前槽本就是字符串）——非 swipe 消息上此步为 no-op。
    if (Array.isArray(m.swipes) && typeof m.swipes[m.swipe_id] === 'string') {
        m.swipes[m.swipe_id] = m.mes;
    }
    return m.mes;
}

// 衍生（乙）情形专用：把推导出的 <UpdateVariable> 块 + MVU 状态栏占位符写回这条 AI 消息（让消息像官方 MVU
// 更新那样【携带】更新记录 + 触发状态栏；块默认被卡片「去除变量更新」正则在显示 / 提示词里隐藏，占位符由卡片
// 显示正则渲染成状态栏，二者都跨重载存活，故 saveChat），再调 refreshMessageBar 重渲染。核验（甲）情形不走这里
// （消息里已有块 + 占位符，再追加会重复），只 refreshMessageBar。写回经 applyBlockToCurrentSwipe → 同时落在
// m.mes 与【当前 swipe 槽】（校正换 swipe 后不丢块；非 swipe 消息上镜像是 no-op，行为与旧实现逐字节相同）。
async function writeUpdateBlockToMessage(idx, block) {
    const ctx = getCtx();
    const m = (ctx.chat || [])[idx];
    if (!m || typeof m.mes !== 'string' || !block) return;
    const before = m.mes;
    applyBlockToCurrentSwipe(m, block, STATUS_PLACEHOLDER);
    if (m.mes !== before) {                                  // 确有追加才存盘
        try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
        catch (e) { console.warn('[Story Oracle] 自动诊断写回消息后保存失败：', e); }
    }
    refreshMessageBar(idx);
}

// 把校正稿作为【新 swipe】写入第 idx 条消息（非破坏性，原文留在 swipe 0），保存、重渲染、补发
// MESSAGE_SWIPED/UPDATED（让酒馆助手重建状态栏 iframe，与 refreshMessageBar 同理）。返回 true=成功。
// 2026-06-26 两个真机 bug 的修复（手动与自动校正共用本函数，一处修两处都好）：
//  · Bug 1（计数停在 1/1、滑不回原文，得重载才变 2/2）：updateMessageBlock 只重渲染 .mes_text，不碰 ST
//    的 .swipes-counter / 左右箭头；补发 MESSAGE_SWIPED 也不刷新计数。故加一刀 ctx.swipe.refresh(true)
//    （= refreshSwipeButtons(updateCounters=true)）——更新「X/Y」文字、并在 swipes.length>1 时点亮左箭头
//    （swipes_visible），于是无需重载即可滑回原文。
//  · Bug 2（机制块随校正稿带过来了，但 stats 没应用）：MVU 只在 MESSAGE_RECEIVED/SENT 解析更新块，新 swipe
//    是代码造的，MVU 不会给它建变量快照 → 状态栏读不到原回复那次更新。修法：把【原回复已生效】的 MVU 整盘
//    状态【拷贝】到新 swipe（换前 getMvuData 抓快照、换后 replaceMvuData 写回 latest）。是【拷贝】不是
//    【重解析】——绝不会把「好感度 += 5」这类相对更新二次累加；最坏情形（被某 MVU 监听覆盖）也只是没刷新 =
//    与修复前一致，绝不会改坏存档。真实卡片上的状态栏【数值】仍需肉眼复核（MVU 的 swipe 语义此处测不到）。
async function applyFixAsSwipe(idx, finalText) {
    const ctx = getCtx();
    const m = (ctx.chat || [])[idx];
    if (!m || typeof m.mes !== 'string') return false;

    // Bug 2 ①：换 swipe 前，抓住当前（= 被校正那条 swipe 已生效）的 MVU 整盘状态，待会儿原样拷给新 swipe。
    let mvuSnapshot = null;
    try {
        const Mvu = await getMvu();
        if (Mvu && typeof Mvu.getMvuData === 'function') {
            const cur = Mvu.getMvuData({ type: 'message', message_id: 'latest' });
            if (cur) mvuSnapshot = JSON.parse(JSON.stringify(cur));
        }
    } catch (e) { console.warn('[Story Oracle] 校正前读取 MVU 状态失败：', e); }

    const now = new Date();
    const info = { send_date: now.toISOString(), gen_started: null, gen_finished: now.toISOString(), extra: { story_oracle_fix: true } };
    addSwipeToMessage(m, finalText, info);
    try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
    catch (e) { console.warn('[Story Oracle] 校正写入 swipe 后保存失败：', e); return false; }

    // Bug 2 ②：把抓到的状态【拷贝】到新 swipe（它现在已是 latest）。replaceMvuData 同时写 stat_data +
    // display_data，下面 updateMessageBlock 重渲染时状态栏即读到正确值。放在补发事件【之前】，尽量先于
    // MVU 可能的 swipe 监听落定。
    if (mvuSnapshot) {
        try {
            const Mvu = await getMvu();
            if (Mvu && typeof Mvu.replaceMvuData === 'function') {
                await Mvu.replaceMvuData(mvuSnapshot, { type: 'message', message_id: 'latest' });
            }
        } catch (e) { console.warn('[Story Oracle] 校正后写回 MVU 状态失败：', e); }
    }

    try { if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(idx, m); }
    catch (e) { console.warn('[Story Oracle] 校正后重渲染失败：', e); }

    // Bug 1：刷新 ST 的 swipe 计数 + 左右箭头（updateMessageBlock 不管这块）。ctx.swipe.refresh 即
    // refreshSwipeButtons；传 true 连「X/Y」文字一起更新。带回退以防个别 ST 构建把它摆在别处。
    try {
        const swipeRefresh = (ctx.swipe && ctx.swipe.refresh) || ctx.refreshSwipeButtons;
        if (typeof swipeRefresh === 'function') swipeRefresh(true);
    } catch (e) { console.warn('[Story Oracle] 校正后刷新 swipe 计数失败：', e); }

    try {
        const et = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && typeof ctx.eventSource.emit === 'function') {
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_SWIPED || 'message_swiped', idx)).catch(() => {});
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_UPDATED || 'message_updated', idx)).catch(() => {});
        }
    } catch (e) { console.warn('[Story Oracle] 校正后发事件失败：', e); }
    return true;
}

// 非破坏性地把某条消息切到一个【已存在的】swipe（不新增、不删除——只换 swipe_id + mes）。Task 3 的
// 「用原文」会用它切回原文 swipe；现在仅作为已挂载的 async 函数存在。swipeId 越界 / 不是字符串 → 返回
// false（不动）。命中后复用 applyFixAsSwipe 的保存 / 重渲染 / 发事件尾巴（saveChat → updateMessageBlock →
// emit MESSAGE_SWIPED + MESSAGE_UPDATED），让状态栏 iframe 随之刷新。
async function selectSwipe(idx, swipeId) {
    const ctx = getCtx();
    const m = (ctx.chat || [])[idx];
    if (!m || !Array.isArray(m.swipes) || typeof m.swipes[swipeId] !== 'string') return false;
    m.swipe_id = swipeId;
    m.mes = m.swipes[swipeId];
    // Bug 3（同 addSwipeToMessage）：切到另一条已存在 swipe（用原文 / 用校正稿）也要作废 extra.display_text 的旧
    // 渲染缓存，否则 updateMessageBlock 会渲染旧 display_text 而不是切过去的 mes。对齐 ST 原生 swipe。
    if (m.extra && typeof m.extra === 'object') delete m.extra.display_text;
    try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
    catch (e) { console.warn('[Story Oracle] 校正写入 swipe 后保存失败：', e); return false; }
    try { if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(idx, m); }
    catch (e) { console.warn('[Story Oracle] 校正后重渲染失败：', e); }
    try {
        const et = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && typeof ctx.eventSource.emit === 'function') {
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_SWIPED || 'message_swiped', idx)).catch(() => {});
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_UPDATED || 'message_updated', idx)).catch(() => {});
        }
    } catch (e) { console.warn('[Story Oracle] 校正后发事件失败：', e); }
    return true;
}

// 纯函数：拼一条自动诊断侧聊记录的正文。status: applied（带补丁）/ nochange（无需改动）/ failed
// （没解析出可应用的更新）。stamp 由调用方传入（纯函数不读时钟，便于单测）。可单测。
function autoDiagNoteContent({ status, patch, stamp }) {
    const t = stamp ? ' · ' + stamp : '';
    if (status === 'applied') {
        const body = (patch && patch.trim()) ? `\n${patch.trim()}` : '';
        return `🔧 自动诊断${t} —— 已自动修复本回合的 MVU 状态（在下方点「撤销」可还原）。${body}`;
    }
    if (status === 'failed') {
        return `⚠️ 自动诊断${t} —— 跑完了，但这条更新没能解析 / 应用（已跳过，未改动状态）。`;
    }
    return `🩺 自动诊断${t} —— 已检查最新回复，本回合无需改动。`;   // nochange
}

// 纯函数：拼一条自动【校正】侧聊记录的正文（仿 autoDiagNoteContent）。status: fixed（已校正、已作为新
// swipe 应用）/ nochange（成本门 / 无操作，未改动）/ failed（没解析出 <FixedReply>，未改动）。fixed 提示
// 向左划可看原文（原文留在 swipe 0，本扩展不破坏它），并附上「发现并修正」摘要（problems，可空）。
// stamp 由调用方传入（纯函数不读时钟，便于单测）。可单测。
function autoFixNoteContent({ status, problems, stamp }) {
    const t = stamp ? ' · ' + stamp : '';
    if (status === 'fixed') {
        const body = (problems && String(problems).trim()) ? `\n发现并修正：\n${String(problems).trim()}` : '';
        return `✨ 自动校正${t} —— 已校正最新回复，并作为新 swipe 应用。原文还在——向左划看原文，或点下方「看改动」对比。${body}`;
    }
    if (status === 'failed') {
        return `⚠️ 自动校正${t} —— 跑完了，但没能从模型回复里解析出校正稿（已跳过，未改动回复）。`;
    }
    // Phase 4：P-TRUNC 截断 —— 模型回复被中转 / max_tokens 砍成半句，未应用（半句稿会腰斩回复）。
    if (status === 'truncated') {
        return `⚠️ 自动校正${t} —— 模型回复像是被截断了（没写完就断了），未应用（把「最大 token 数」调大些再试）。`;
    }
    // Phase 4：P-CORRUPT 陈旧 —— LLM 返回后聊天 / 目标已变，跳过写入。reason 经 problems 槽传入、映射成人话。
    if (status === 'stale') {
        const why = {
            chatSwitched: '聊天已切换（避免写到别的对话）',
            contentChanged: '这条回复已发生变化（避免覆盖新内容）',
            swipeChanged: '这条回复已切到别的 swipe',
            gone: '目标回复已不在了',
        }[problems] || '目标已失效';
        return `⏭️ 自动校正${t} —— 已跳过：${why}，未改动这条回复。`;
    }
    // ✨ Phase 5 D+E：作用域懒检测 / 记忆 / 静默兜底——problems 槽这次装的是 resolveFixScope 的 note 描述符
    // （{code,cachedTag,detectedTag} 对象，不是字符串），交给 fixScopeNoteText 转成人话；emoji 由它给，不用前缀的✨。
    if (status === 'scope') {
        const e = fixScopeNoteText(problems);
        return `${e.emoji} 自动校正${t} —— ${e.body}`;
    }
    return `✨ 自动校正${t} —— 已检查最新回复，无需校正（未改动）。`;   // nochange
}

// 自动诊断跑完一轮后的提示。用户功能请求：每轮都在侧聊里留一条【持久】记录（含「无需改动」）；改动
// 的那条还带一个【撤销按钮】（与手动诊断同款，经 applyFix/undoFix），撤销不再走 toast。toast 只作信息
// 提示。注意：撤销按钮只在【刚跑完的本会话】可用——重载后记录变只读（重放旧补丁不安全，与手动诊断回复
// 重载后失去按钮一致）。
function notifyAutoDiagnose(result, patch) {
    const status = (result && result.status) || 'failed';
    const snapshot = status === 'applied' ? result.snapshot : null;

    // 信息 toast（不再承担撤销动作——撤销在记录的按钮上）
    try {
        if (status === 'applied') {
            window.toastr && window.toastr.success && window.toastr.success(
                '已自动修复最新回复的 MVU 状态。可在神谕侧聊里点「撤销」还原。', '故事神谕 · 自动诊断', { timeOut: 7000 });
        } else if (status === 'nochange') {
            window.toastr && window.toastr.info && window.toastr.info(
                '已检查最新回复，本回合无需改动。', '故事神谕 · 自动诊断', { timeOut: 4000 });
        } else {
            window.toastr && window.toastr.warning && window.toastr.warning(
                '自动诊断跑完了，但这条更新没能解析 / 应用（已跳过）。', '故事神谕 · 自动诊断', { timeOut: 5000 });
        }
    } catch (e) { /* toastr 不在就算了 */ }

    // 持久侧聊记录（每轮都写）。窗口关着也留得下（DOM 在 init 就建好）；随 per-chat 持久化、跨重载存活。
    // 它是 note 条目，不是问答轮，绝不回灌给模型（见 convoForPrompt）。
    try {
        const stamp = (() => { try { return new Date().toLocaleTimeString(); } catch (e) { return ''; } })();
        const entry = { id: ++cidSeq, role: 'note', content: autoDiagNoteContent({ status, patch, stamp }) };
        convo.push(entry);
        persistConvo();
        // 改动型记录在本会话挂可用的撤销按钮；其余（无改动 / 失败 / 重载后）是只读记录。
        const undoable = (snapshot && patch) ? { snapshot, patch } : null;
        if (messagesEl) entry._el = addNoteMessage(entry, undoable);
    } catch (e) { console.warn('[Story Oracle] 自动诊断记录写入侧聊失败：', e); }
}

// 「正在自动诊断…」提示。返回一个句柄交给 dismissToast 收掉（toastr 不在则回 null）。timeOut:0 = 不
// 自动消失，由我们在生成结束后手动 clear。
function showAutoDiagGenerating() {
    try {
        if (window.toastr && window.toastr.info) {
            return window.toastr.info('正在分析最新回复、生成诊断报告…（点此中断）', '故事神谕 · 自动诊断', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, onclick: () => cancelPostReply() });
        }
    } catch (e) { /* ignore */ }
    return null;
}
function dismissToast(handle) {
    try { if (handle && window.toastr && window.toastr.clear) window.toastr.clear(handle); } catch (e) { /* ignore */ }
}

// 自动诊断记录上的「撤销 / 重新应用」按钮条（与 addApplyControls 同款，复用 applyFix/undoFix）。
// 记录创建时修复【已自动应用】，故按钮初始就是「撤销」态。
function addNoteUndoControls(wrap, initialSnapshot, patch) {
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar so-note-undo';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
    btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 撤销此次修复';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
    bar.appendChild(btn);
    bar.appendChild(status);
    wrap.appendChild(bar);

    let snapshot = initialSnapshot;   // 非空 = 当前处于「已应用」
    btn.addEventListener('click', async () => {
        status.classList.remove('so-hint-error');
        btn.disabled = true;
        if (snapshot) {
            status.textContent = '正在还原…';
            try {
                await undoFix(snapshot);
                snapshot = null;
                btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 重新应用';
                status.textContent = '已还原到修复前的状态。';
            } catch (e) {
                status.textContent = '还原失败：' + (e?.message || e);
                status.classList.add('so-hint-error');
            }
        } else {
            status.textContent = '正在重新应用…';
            try {
                snapshot = await applyFix(patch, status);
                if (snapshot) {
                    btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 撤销此次修复';
                    status.textContent = '已重新应用。';
                }
            } catch (e) {
                status.textContent = '重新应用失败：' + (e?.message || e);
                status.classList.add('so-hint-error');
            }
        }
        btn.disabled = false;
    });
}

// ✨ 校正 Phase 4：自动校正【已应用】记录上的「用原文 / 看改动」按钮条（仿 addNoteUndoControls 的结构）。
// info = { idx, before, after, fixSwipeId }。自动校正在创建记录时已把校正稿作为新 swipe 应用，原文留在
// swipe 0。两个按钮：
//   · 用原文：切回 swipe 0（selectSwipe(idx,0)），成功后改标签为「用校正稿」并把动作翻到切回 fixSwipeId——
//     原文 ↔ 校正稿 的二态开关（本会话内）。selectSwipe 返回 false（swipe 已不在，例如用户重 roll 了）→
//     状态写「无法切换」并禁用按钮。
//   · 看改动：懒构建一次 renderDiffCard(before, after) 接到 wrap 上，之后切 hidden 复用（与手动卡同款）。
function addAutoFixControls(wrap, info) {
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar so-note-undo';
    const swapBtn = document.createElement('button');
    swapBtn.className = 'so-apply-btn';
    swapBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 用原文';
    const diffBtn = document.createElement('button');
    diffBtn.className = 'so-apply-btn';
    diffBtn.innerHTML = '<i class="fa-solid fa-eye"></i> 看改动';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
    bar.appendChild(swapBtn);
    bar.appendChild(diffBtn);
    bar.appendChild(status);
    wrap.appendChild(bar);

    // 原文 ↔ 校正稿 二态开关。showingOriginal=false = 当前显示校正稿（记录创建时即此态）。
    let showingOriginal = false;
    swapBtn.addEventListener('click', async () => {
        status.classList.remove('so-hint-error');
        swapBtn.disabled = true;
        const targetSwipe = showingOriginal ? info.fixSwipeId : 0;
        const ok = await selectSwipe(info.idx, targetSwipe);
        if (!ok) {
            // swipe 不在了（用户重 roll / 删了）——这条记录的切换不再可靠，停用。
            status.textContent = '无法切换（原 swipe 已不在）。';
            status.classList.add('so-hint-error');
            return;   // 留 disabled
        }
        showingOriginal = !showingOriginal;
        if (showingOriginal) {
            swapBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 用校正稿';
            status.textContent = '已切回原文。';
        } else {
            swapBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 用原文';
            status.textContent = '已切回校正稿。';
        }
        swapBtn.disabled = false;
    });

    let diffCard = null;
    diffBtn.addEventListener('click', () => {
        if (!diffCard) {
            diffCard = renderDiffCard(stripFixKeepMarks(info.before), stripFixKeepMarks(info.after));   // 别把 ⟦SO_KEEP_n⟧ 锚点露进「看改动」
            wrap.appendChild(diffCard);
        } else {
            diffCard.hidden = !diffCard.hidden;
        }
        scrollToBottom();
    });
}

function injectWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('so-wand-button')) return;

    const item = document.createElement('div');
    item.id = 'so-wand-button';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<i class="fa-solid fa-moon"></i><span>故事神谕</span>`;
    item.addEventListener('click', () => {
        // Just open our window. SillyTavern's own outside-click handler closes
        // the wand menu (our item isn't a no-close target). Do NOT touch
        // #extensionsMenu here: adding .displayNone (display:none !important)
        // permanently breaks ST's fadeIn and the menu never reopens.
        toggleWindow(true);
    });
    menu.appendChild(item);

    // 手机专属救援入口：紧随其后放一个「窗口归位（居中）」项。手机用户把窗口拖丢 / 拖到屏外时，这是【永远够得到】
    // 的复位入口——它在 ST 常驻的魔棒菜单里、不在那个可能已不可见的窗口里。桌面用 CSS @media 隐藏（见 style.css）。
    const rc = document.createElement('div');
    rc.id = 'so-wand-recenter';
    rc.className = 'list-group-item flex-container flexGap5 interactable';
    rc.tabIndex = 0;
    rc.innerHTML = `<i class="fa-solid fa-arrows-to-dot"></i><span>神谕窗口归位（居中）</span>`;
    rc.addEventListener('click', () => recenterWindow());
    menu.appendChild(rc);
}

// 手机「窗口归位」：把窗口复位到【居中 + 默认尺寸 380×540（夹进可见视口）】并存档。经魔棒菜单常驻项触发，故窗口
// 即便被拖到屏外也救得回来（写绝对居中坐标、与当前位置无关；reset 用默认尺寸而非当前可能已拖坏的尺寸）。桌面项被
// CSS 隐藏、不会触发。
function recenterWindow() {
    toggleWindow(true);                       // 关着 / 在屏外都先确保开着
    if (!win) return;
    const vv = window.visualViewport;
    const c = centeredWindowBox({
        w: (vv && vv.width) || window.innerWidth,
        h: (vv && vv.height) || window.innerHeight,
        offX: (vv && vv.offsetLeft) || 0,
        offY: (vv && vv.offsetTop) || 0,
    });                                       // 无 opts → 默认 380×540（reset 语义：撤销被拖坏的尺寸）
    win.style.left = `${c.left}px`;
    win.style.top = `${c.top}px`;
    win.style.width = `${c.width}px`;
    win.style.height = `${c.height}px`;
    win.style.right = 'auto';
    const s = getSettings();                  // 存档：复位持久化（后续开窗不再回到坏位置 / 坏尺寸）
    s.winLeft = c.left; s.winTop = c.top; s.winWidth = c.width; s.winHeight = c.height;
    save();
}

// 用户功能请求：在 ST 聊天输入栏（#leftSendForm，紧挨 ☰ 菜单键）放一个一键开 / 关神谕侧窗的小按钮（🌙）。
// 默认关——仅当神谕设置里勾了「聊天栏快捷按钮」(showChatBarButton) 才出现；与魔棒入口并存、互不影响。
// 复用 ST 自带的 .interactable / fa- 图标样式，故外观与 ☰ 等原生按钮一致（着色见 style.css）。
function injectChatBarButton() {
    const bar = document.getElementById('leftSendForm');
    if (!bar || document.getElementById('so-chatbar-button')) return;
    const btn = document.createElement('div');
    btn.id = 'so-chatbar-button';
    btn.className = 'fa-solid fa-moon interactable';
    btn.title = '故事神谕 —— 点击开 / 关侧窗';
    btn.tabIndex = 0;
    btn.addEventListener('click', () => toggleWindow());   // 无参 = 切换开 / 关
    bar.appendChild(btn);
}

function removeChatBarButton() {
    const btn = document.getElementById('so-chatbar-button');
    if (btn) btn.remove();
}

// 按设置同步聊天栏按钮的有无（init 时 + 设置里勾选 / 取消时调用）。
function syncChatBarButton() {
    if (getSettings().showChatBarButton) injectChatBarButton();
    else removeChatBarButton();
}

/* ------------------------------------------------------------------ *
 * The floating window
 * ------------------------------------------------------------------ */
let win, messagesEl, inputEl, sendBtn, modeBadge;

function buildWindow() {
    if (document.getElementById('so-window')) return;
    const s = getSettings();

    win = document.createElement('div');
    win.id = 'so-window';
    win.style.display = 'none';
    applyInitialGeometry(s);
    // 视口变化时把窗口重新夹回可见区——旋屏 / 手机软键盘弹收 / 浏览器地址栏伸缩都会改变【可见】视口，
    // 否则 position:fixed 的窗口标题栏（唯一带 ✕ 关闭 + 拖动把手的地方）可能被挤出屏外、再也够不到
    //（手机「常驻、无法关闭」bug）。ensureWindowInView 只贴合显示、不 save，键盘收起后会自己长回原尺寸。
    window.addEventListener('resize', scheduleEnsureInView);
    window.addEventListener('orientationchange', scheduleEnsureInView);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleEnsureInView);

    win.innerHTML = `
        <div id="so-header">
            <div id="so-title"><i class="fa-solid fa-moon"></i> 故事神谕 <span id="so-mode-badge"></span><span id="so-diag-pill">诊断</span><span id="so-lb-pill">世界书</span><span id="so-adv-pill">参谋</span></div>
            <div id="so-header-btns">
                <div class="so-iconbtn" id="so-advisor-btn" title="剧情参谋 —— 构思新剧情走向，并引导主线靠近它"><i class="fa-solid fa-compass"></i></div>
                <div class="so-iconbtn" id="so-lorebook-btn" title="世界书模式 —— 聊聊或修改世界书"><i class="fa-solid fa-book"></i></div>
                <div class="so-iconbtn" id="so-diagnose-btn" title="诊断模式 —— 修复 MVU 状态变量（再点一次开启自动模式）"><i class="fa-solid fa-stethoscope"></i><span class="so-auto-tag">AUTO</span></div>
                <div class="so-iconbtn" id="so-fix-btn" title="校正模式 —— 修一修最新这条回复（AI 味 / 对话 / 设定 / 详略…），应用后原文仍在"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
                <span class="so-hdr-div" aria-hidden="true"></span>
                <div class="so-tools-wrap">
                    <div class="so-iconbtn" id="so-tools-btn" aria-haspopup="true" aria-expanded="false" title="更多 —— 剧情概要 / 调试提示词 / 设置"><i class="fa-solid fa-ellipsis"></i></div>
                    <div id="so-tools-menu" aria-label="更多工具">
                        <div class="so-iconbtn so-tools-item" id="so-normalchat-btn" title="回到普通聊天（自动诊断如已开启会继续在后台运行）"><i class="fa-solid fa-comment"></i><span>普通聊天</span></div>
                        <div class="so-iconbtn so-tools-item" id="so-summary-btn" title="剧情概要 —— 粘贴你的运行总结 / 前情提要，神谕会在最近对话前读到它"><i class="fa-solid fa-scroll"></i><span>剧情概要</span></div>
                        <div class="so-iconbtn so-tools-item" id="so-debug-btn" title="查看上一次发送的提示词"><i class="fa-solid fa-bug"></i><span>调试提示词</span></div>
                        <div class="so-iconbtn so-tools-item" id="so-settings-btn" title="设置"><i class="fa-solid fa-gear"></i><span>设置</span></div>
                    </div>
                </div>
                <span class="so-hdr-div" aria-hidden="true"></span>
                <div class="so-iconbtn" id="so-clear-btn" title="清空对话"><i class="fa-solid fa-trash-can"></i></div>
                <div class="so-iconbtn" id="so-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>
        </div>

        <div id="so-settings">
            <details class="so-set-group" open>
                <summary>连接</summary>
                <div class="so-set-body">
                    <label class="so-row"><span>连接模式</span>
                        <select id="so-mode">
                            <option value="direct">直连（自定义 URL）</option>
                            <option value="profile">连接配置文件</option>
                        </select>
                    </label>

                    <div id="so-direct-fields">
                        <label class="so-field"><span>端点 URL</span>
                            <input id="so-endpoint" type="text" placeholder="https://your-proxy.com/v1">
                        </label>
                        <label class="so-field"><span>API 密钥</span>
                            <input id="so-apikey" type="password" placeholder="sk-...">
                        </label>
                        <label class="so-field"><span>模型</span>
                            <div class="so-model-row">
                                <input id="so-model" type="text" placeholder="gpt-4o-mini">
                                <div class="so-iconbtn" id="so-model-fetch" title="从服务商获取可用模型列表"><i class="fa-solid fa-cloud-arrow-down"></i></div>
                            </div>
                            <select id="so-model-list" style="display:none"></select>
                            <div class="so-hint" id="so-model-hint"></div>
                        </label>
                        <div class="so-hint">如果请求因 CORS / 网络错误失败，请切换到“连接配置文件”模式（通过 ST 服务器转发）。</div>
                    </div>

                    <div id="so-profile-fields">
                        <label class="so-field"><span>配置文件</span>
                            <div class="so-profile-row">
                                <select id="so-profile"></select>
                                <div class="so-iconbtn" id="so-profile-refresh" title="刷新配置文件列表"><i class="fa-solid fa-rotate-right"></i></div>
                            </div>
                        </label>
                        <div class="so-hint" id="so-profile-hint">使用已保存的连接配置文件，通过 ST 服务器转发（无 CORS 问题）。</div>
                    </div>
                </div>
            </details>

            <details class="so-set-group">
                <summary>生成参数</summary>
                <div class="so-set-body">
                    <div class="so-grid2">
                        <label class="so-field"><span>温度</span>
                            <input id="so-temp" type="number" step="0.05" min="0" max="2">
                        </label>
                        <label class="so-field"><span>最大 token 数</span>
                            <input id="so-maxtok" type="number" step="50" min="1">
                        </label>
                    </div>
                    <label class="so-check"><input id="so-stream" type="checkbox"><span>流式输出</span></label>
                    <label class="so-check"><input id="so-sendtemp" type="checkbox"><span>发送温度参数（部分拒收该参数的模型请关闭）</span></label>
                </div>
            </details>

            <details class="so-set-group">
                <summary>上下文与世界书</summary>
                <div class="so-set-body">
                    <label class="so-field"><span>上下文深度（消息条数，-1 = 全部，0 = 不带）</span>
                        <input id="so-depth" type="number" step="1" min="-1">
                    </label>
                    <label class="so-field"><span>剧情引导注入深度（参谋模式：方案指令插入主聊天的深度）</span>
                        <input id="so-adv-depth" type="number" step="1" min="0">
                    </label>
                    <label class="so-check"><input id="so-card" type="checkbox"><span>包含角色卡（描述 / 性格 / 场景）</span></label>
                    <label class="so-check"><input id="so-stat" type="checkbox"><span>附带变量状态（MVU stat_data，普通模式）—— 数值问题的权威来源；关掉则如实拒答数值</span></label>
                    <label class="so-check"><input id="so-world" type="checkbox"><span>附带「世界引擎」后台世界状态（普通 / 参谋模式）—— 目前仅适配世界引擎（World Engine，含本机改版）的当前版本；其它世界状态类扩展需日后单独适配。喂完整数据较吃 token，未识别到相关扩展时无开销</span></label>
                    <label class="so-check"><input id="so-hidden" type="checkbox"><span>读取隐藏楼层（被 /hide 隐藏的消息）—— 默认关；开启后神谕读对话时也会看到隐藏楼层（不影响世界书关键词扫描与弧线节奏）</span></label>
                    <label class="so-check"><input id="so-regex" type="checkbox"><span>应用剧情正则（剥离思维链 / 状态栏、使用总结）—— 与主聊天保持一致</span></label>

                    <label class="so-row"><span>世界书 / 知识库</span>
                        <select id="so-wi">
                            <option value="off">关闭</option>
                            <option value="st">常驻 + 关键词匹配（ST 默认行为）</option>
                            <option value="char">仅角色相关世界书（排除全局）</option>
                            <option value="all">全部条目（规划用 —— 忽略关键词）</option>
                        </select>
                    </label>
                    <div class="so-hint" id="so-wi-hint"></div>
                </div>
            </details>

            <details class="so-set-group">
                <summary>人格与提示词</summary>
                <div class="so-set-body">
                    <label class="so-row"><span>说话人格</span>
                        <select id="so-persona"></select>
                    </label>
                    <div class="so-hint">给神谕套一层“说话腔调”，只改变语气与文采，不改变其分析职责。选「普通」即关闭人格（默认）。使用预设时，人格默认关闭、以免与预设自带的角色声线冲突；若选择某个人格，它会叠加在预设之上。参谋 / 世界书模式下同样叠加（人格只改语气，方案与条目正文的格式不受影响）。诊断模式下不生效。</div>

                    <label class="so-row"><span>系统提示词（选择要查看 / 修改的模式）</span>
                        <select id="so-sysprompt-which"></select>
                    </label>

                    <div id="so-sysprompt-preset-wrap">
                    <label class="so-row"><span>系统提示词来源（补全预设）</span>
                        <div class="so-profile-row">
                            <select id="so-sysprompt-preset"></select>
                            <div class="so-iconbtn" id="so-sysprompt-preset-recurate" title="重新挑选要保留的块"><i class="fa-solid fa-list-check"></i></div>
                            <div class="so-iconbtn" id="so-sysprompt-preset-refresh" title="刷新预设列表"><i class="fa-solid fa-rotate-right"></i></div>
                        </div>
                    </label>
                    <div class="so-hint" id="so-sysprompt-preset-hint"></div>
                    </div>

                    <div class="so-field">
                        <div class="so-sysprompt-head">
                            <span>系统提示词</span>
                            <button type="button" id="so-sysprompt-reset" title="恢复为内置默认提示词">↺ 重置为默认</button>
                        </div>
                        <textarea id="so-sysprompt" rows="5"></textarea>
                    </div>
                    <div class="so-hint" id="so-sysprompt-which-hint"></div>
                </div>
            </details>

            <details class="so-set-group">
                <summary>界面</summary>
                <div class="so-set-body">
                    <label class="so-check"><input id="so-chatbar-toggle" type="checkbox"><span>在聊天输入栏显示快捷按钮（🌙 一键开 / 关神谕）</span></label>
                </div>
            </details>
        </div>

        <div id="so-diag-bar">
            <details class="so-mode-collapse" id="so-diag-collapse" open>
                <summary class="so-mode-collapse-sum"><i class="fa-solid fa-stethoscope"></i><span>诊断设置</span></summary>
                <div class="so-mode-collapse-body">
            <label class="so-check so-lb-check"><input id="so-diag-usesel" type="checkbox"><span>诊断使用精选世界书条目（关闭则用默认扫描）</span></label>
            <div class="so-hint">开启后可【按本聊天】挑选要喂给诊断的世界书条目，无视其在 ST 里的启用 / 禁用状态——解决「禁用了变量规则条目后诊断就看不到」与「全量太吵」的两难。首次开启会按当前激活情况预选一份，之后随你增删、按聊天记忆。</div>
            <div id="so-diag-picker">
                <label class="so-check so-lb-check"><input id="so-diag-hybrid" type="checkbox"><span>混合模式：精选条目 + 主聊天当前触发的绿灯条目</span></label>
                <div class="so-lb-row">
                    <i class="fa-solid fa-book so-lb-icon"></i>
                    <select id="so-diag-book" title="选择要从哪本世界书里挑条目"></select>
                    <div class="so-iconbtn" id="so-diag-refresh" title="刷新世界书列表"><i class="fa-solid fa-rotate-right"></i></div>
                </div>
                <div id="so-diag-entries" class="so-lb-entries">
                    <div class="so-lb-entries-head">
                        <span id="so-diag-entries-summary">条目：全部</span>
                        <div class="so-iconbtn so-lb-ent-toggle" id="so-diag-entries-toggle" title="展开 / 折叠条目列表"><i class="fa-solid fa-chevron-down"></i></div>
                    </div>
                    <div class="so-lb-entries-tools">
                        <button type="button" class="so-lb-mini" id="so-diag-all">全选</button>
                        <button type="button" class="so-lb-mini" id="so-diag-none">全不选</button>
                        <button type="button" class="so-lb-mini" id="so-diag-filtered" disabled title="只选中当前筛选 / 搜索结果里的条目（先在下方筛选框输入关键词）">全选筛选</button>
                        <button type="button" class="so-lb-mini so-lb-mini-blue" id="so-diag-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button>
                        <button type="button" class="so-lb-mini so-lb-mini-green" id="so-diag-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button>
                        <button type="button" class="so-lb-mini so-lb-mini-off" id="so-diag-disabled" title="只选已禁用条目">仅禁用</button>
                    </div>
                    <input type="text" id="so-diag-entries-filter" class="so-lb-entries-filter" placeholder="筛选条目（标题 / 关键词 / uid）…">
                    <div id="so-diag-entries-list" class="so-lb-entries-list"></div>
                </div>
                <div class="so-hint" id="so-diag-hint"></div>
            </div>
                </div>
            </details>
        </div>

        <div id="so-fix-bar">
            <details class="so-mode-collapse" id="so-fix-collapse" open>
                <summary class="so-mode-collapse-sum"><i class="fa-solid fa-wand-magic-sparkles"></i><span>校正设置</span></summary>
                <div class="so-mode-collapse-body">
                    <label class="so-check so-lb-check"><span>校正模式</span>&nbsp;<select id="so-fix-mode-select" title="手动 = 在输入框直接说要改什么（单稿、快）；自动 = 按目标 / 每条新回复后台校正（双稿收紧）"><option value="manual">手动（说要改哪里）</option><option value="auto">自动（按目标 / 每条新回复）</option></select></label>
                    <div class="so-hint">⚠ 「经自定义补全预设发送（破限 / 越狱用）」：仅在你的模型 / 中转会【拒绝】校正请求、需要破限 / 越狱时才开。需先在【设置】里选好并「精选」一个补全预设。手动与自动【各自独立】开关（见下方各模式设置）；开启的那一套会套上该预设的文本块与角色（跳过角色卡 / 世界书等 RP 内容标记），可能更慢 / 更贵。不需要破限就别开。</div>

                    <!-- 手动模式：在下方输入框直接说要改什么。默认带上丰富上下文（一次性精修、质量优先）。单稿、无目标。 -->
                    <div id="so-fix-manual">
                        <label class="so-check so-lb-check"><input id="so-fixm-preset" type="checkbox"><span>经自定义补全预设发送（破限 / 越狱用）</span></label>
                        <label class="so-check so-lb-check"><span>加载前文条数（-1 = 全部）</span>&nbsp;<input id="so-fixm-depth" type="number" min="-1" max="100" style="width:64px;"></label>
                        <label class="so-check so-lb-check"><input id="so-fixm-card" type="checkbox"><span>带上角色卡（描述 / 性格 / 场景）</span></label>
                        <label class="so-check so-lb-check"><input id="so-fixm-world" type="checkbox"><span>带上当前激活世界书</span></label>
                        <label class="so-check so-lb-check"><input id="so-fixm-summary" type="checkbox"><span>带上 📜剧情概要</span></label>
                        <div class="so-hint">手动：在下方输入框直接说要改哪里（如「换种写法重写这段」「她这里不该笑」），只改最新这一条回复，单稿、更快。</div>
                    </div>

                    <!-- 自动模式：按目标校正按钮（手动跑一次）+ 每条新回复自动校正。双稿收紧、目标驱动、默认精简省钱。 -->
                    <div id="so-fix-auto-wrap">
                        <button type="button" id="so-fix-run" class="so-fix-run-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> 按目标校正最新回复</button>
                        <label class="so-check so-lb-check"><input id="so-fix-auto" type="checkbox"><span>自动校正每条新回复（实验）</span></label>
                        <label class="so-check so-lb-check"><input id="so-fixa-preset" type="checkbox"><span>经自定义补全预设发送（破限 / 越狱用）</span></label>
                        <label class="so-check so-lb-check"><span>只校正此标签内的正文</span>&nbsp;<input id="so-fix-scope" type="text" placeholder="content" style="width:110px;"></label>
                        <div class="so-hint">填卡片包裹【正文】的标签名（默认 <code>content</code>）：只校正 &lt;content&gt;…&lt;/content&gt; 之间的正文，正文【外】的所有块（状态栏 / 选项 / 世界书 / htmlcontent 地图 / 变量更新 / 占位符…）原样保留、<strong>原位不动</strong>。回复里没有该标签则自动校正整条（简单卡不受影响）。<strong>留空</strong> = 校正整条回复。卡片若用别的标签包正文，就改成那个标签名（如 &lt;正文&gt; 就填 <code>正文</code>）。</div>
                        <div id="so-fix-verdict" class="so-fix-verdict" hidden></div>
                        <button type="button" id="so-fix-scan" class="so-fix-run-btn"><i class="fa-solid fa-magnifying-glass"></i> 扫描本卡正文标签（自动填好）</button>
                        <div id="so-fix-scan-panel" class="so-fix-scan-panel" hidden></div>
                        <div class="so-fix-targets-head">校正目标</div>
                        <label class="so-check so-lb-check"><input id="so-fix-tgt-slop" type="checkbox"><span>AI 八股 / 套话</span></label>
                        <label class="so-check so-lb-check"><input id="so-fix-tgt-dialogue" type="checkbox"><span>对话机械 / 不自然</span></label>
                        <label class="so-check so-lb-check"><input id="so-fix-tgt-precision" type="checkbox"><span>过度精确（数学论文腔）</span></label>
                        <label class="so-check so-lb-check"><input id="so-fix-tgt-magic" type="checkbox"><span>魔法被写成理科（仅奇幻设定）</span></label>
                        <label class="so-check so-lb-check"><input id="so-fix-tgt-pacing" type="checkbox"><span>描写拖沓 / 流水账</span></label>
                        <div class="so-fix-targets-head">排除区（这些标签的整段不送去校正，省时间）。每行写一个【起始】标记即可，如 &lt;thinking&gt;——不用写结束的 &lt;/thinking&gt;。<br>支持<strong>嵌套同名标签</strong>（如 &lt;div&gt; 套 &lt;div&gt; 会整块保留最外层）和<strong>方括号块</strong>（图生卡的 <code>[IMG_GEN]</code> 这类，直接写 <code>[IMG_GEN]</code>）。若整篇正文都包在一个标签里，优先用上面的「只校正此标签内的正文」，比在这里逐个枚举更省心。</div>
                        <textarea id="so-fix-keep" rows="2" placeholder="保留区标签（每行一个，如 <status>）：不改，原样留在回复里"></textarea>
                        <textarea id="so-fix-drop" rows="2" placeholder="丢弃区标签（每行一个，如 <thinking>）：不改，也不放回（思考块这类）"></textarea>
                        <textarea id="so-fix-know" rows="2" placeholder="角色知识边界（可空）：例如「主角不知道自己的真实身世」"></textarea>
                        <textarea id="so-fix-guard" rows="2" placeholder="剧情护栏 / 自定义（可空）：例如「保持慢热，不要时间跳跃」"></textarea>
                        <label class="so-check so-lb-check"><input id="so-fix-tighten" type="checkbox"><span>✂️ 收紧（默认开）：校正后再精修一遍（删冗词废话 / 过度描写，读感更紧）。</span></label>
                        <label class="so-check so-lb-check"><span>校正提示词</span>&nbsp;<select id="so-fix-prompt-version" title="轻校＝现行提示词（较克制）；精校＝更彻底的三道工序校正"><option value="light">轻校（现行 · 默认）</option><option value="thorough">精校（三道工序）</option></select></label>
                        <label class="so-check so-lb-check" id="so-fix-prompt-flavor-row"><span>精校侧重</span>&nbsp;<select id="so-fix-prompt-flavor" title="按你用的模型选侧重：DeepSeek / 国产模型选 DeepSeek 类；Claude / Opus 选 Opus 类"><option value="deepseek">DeepSeek 类（默认）</option><option value="opus">Opus 类</option></select></label>
                        <div class="so-hint">轻校＝现行提示词（较克制）。精校＝更彻底的三道工序校正（<strong>已含收紧</strong>）；按你用的模型选侧重：DeepSeek / 国产模型选「DeepSeek 类」，Claude / Opus 选「Opus 类」。默认轻校，不选精校则行为不变。</div>
                        <details class="so-mode-collapse" id="so-fix-ctx-adv">
                            <summary class="so-fix-targets-head" style="cursor:pointer;">上下文（默认关，点开）</summary>
                            <div class="so-hint">⚠ 默认关闭以省时间。仅当你的「知识边界 / 剧情护栏」需要参考前文 / 角色卡 / 世界书才能判断时，才勾选。</div>
                            <label class="so-check so-lb-check"><input id="so-fix-card" type="checkbox"><span>带上角色卡（描述 / 性格 / 场景）</span></label>
                            <label class="so-check so-lb-check"><input id="so-fix-ctx" type="checkbox"><span>带上前文上下文（最近若干条主聊天）</span></label>
                            <label class="so-check so-lb-check" style="margin-left:18px;"><span>条数（-1=全部）</span>&nbsp;<input id="so-fix-ctx-depth" type="number" min="-1" max="100" style="width:64px;"></label>
                            <label class="so-check so-lb-check"><input id="so-fix-world" type="checkbox"><span>带上激活世界书（蓝灯 + 本条命中的绿灯）</span></label>
                            <label class="so-check so-lb-check"><input id="so-fixa-summary" type="checkbox"><span>带上 📜剧情概要</span></label>
                        </details>
                        <div class="so-fix-bundle-row">
                            <select id="so-fix-bundle" title="已存的校正套餐（全局，跨聊天可用）"></select>
                            <button type="button" id="so-fix-bundle-load" class="so-fix-run-btn">加载</button>
                            <button type="button" id="so-fix-bundle-save" class="so-fix-run-btn">保存为…</button>
                            <button type="button" id="so-fix-bundle-del" class="so-fix-run-btn">删除</button>
                        </div>
                        <div class="so-hint">套餐＝把当前这套自动校正配置（目标 / 约束 / 上下文 / 收紧）存成一个名字（如「硬核西幻」），换聊天后一键加载回来。</div>
                        <button type="button" id="so-fix-reset" class="so-fix-run-btn"><i class="fa-solid fa-rotate-left"></i> 恢复推荐设置</button>
                        <div class="so-hint">把本聊天的自动校正设置一键还原成推荐值：作用域 = <code>content</code>、默认校正目标、排除区清空、收紧开、自动关。</div>
                    </div>
                </div>
            </details>
        </div>

        <div id="so-lb-bar">
            <details class="so-mode-collapse" id="so-lb-collapse" open>
                <summary class="so-mode-collapse-sum"><i class="fa-solid fa-book"></i><span>世界书设置</span></summary>
                <div class="so-mode-collapse-body">
            <div class="so-lb-row">
                <i class="fa-solid fa-book so-lb-icon"></i>
                <details id="so-lb-bookpick" class="so-lb-bookpick">
                    <summary id="so-lb-bookpick-sum" title="选择要聊 / 编辑的世界书（可多选；不选＝当前激活的全部）">全部激活的世界书</summary>
                    <div class="so-lb-bookpick-tools">
                        <button type="button" class="so-lb-mini" id="so-lb-book-all">全选</button>
                        <button type="button" class="so-lb-mini" id="so-lb-book-none">全不选（＝全部激活）</button>
                    </div>
                    <div id="so-lb-book-list" class="so-lb-book-list"></div>
                </details>
                <div class="so-iconbtn" id="so-lb-refresh" title="刷新世界书列表"><i class="fa-solid fa-rotate-right"></i></div>
            </div>
            <label class="so-check so-lb-check"><input id="so-lb-story" type="checkbox"><span>同时带上最近剧情对话</span></label>
            <label class="so-check so-lb-check"><input id="so-lb-preset" type="checkbox"><span>套用我的补全预设（指令叠加其上）</span></label>
            <div class="so-hint so-lb-preset-warn">⚠ 勾选后，世界书管家指令会叠加在你选定的补全预设之上（用于越狱）。预设内容会分散模型注意力、可能影响编辑精度——仅在确实需要越狱时才勾选。</div>
            <div id="so-lb-entries" class="so-lb-entries">
                <div class="so-lb-entries-head">
                    <span id="so-lb-entries-summary">条目：全部</span>
                    <div class="so-iconbtn so-lb-ent-toggle" id="so-lb-entries-toggle" title="展开 / 折叠条目列表"><i class="fa-solid fa-chevron-down"></i></div>
                </div>
                <div class="so-lb-entries-tools">
                    <button type="button" class="so-lb-mini" id="so-lb-all">全选</button>
                    <button type="button" class="so-lb-mini" id="so-lb-none">全不选</button>
                    <button type="button" class="so-lb-mini" id="so-lb-filtered" disabled title="只选中当前筛选 / 搜索结果里的条目（先在下方筛选框输入关键词）">全选筛选</button>
                    <button type="button" class="so-lb-mini so-lb-mini-blue" id="so-lb-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button>
                    <button type="button" class="so-lb-mini so-lb-mini-green" id="so-lb-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button>
                    <button type="button" class="so-lb-mini so-lb-mini-off" id="so-lb-disabled" title="只选已禁用条目">仅禁用</button>
                    <button type="button" class="so-lb-mini so-lb-mini-eye" id="so-lb-preview-toggle" title="显示 / 隐藏每条条目的内容预览">👁 内容预览</button>
                </div>
                <input type="text" id="so-lb-entries-filter" class="so-lb-entries-filter" placeholder="筛选条目（标题 / 关键词 / uid）…">
                <div id="so-lb-entries-list" class="so-lb-entries-list"></div>
            </div>
            <div class="so-hint" id="so-lb-hint"></div>
                </div>
            </details>
        </div>

        <div id="so-adv-bar">
            <label class="so-check so-adv-check"><input id="so-adv-preset" type="checkbox"><span>套用我的补全预设（参谋指令叠加其上）</span></label>
            <div class="so-hint so-adv-preset-warn">⚠ 仅在确实需要预设里的越狱时才勾选：预设的额外内容会分散模型注意力。未整理过预设时勾它不报错，会自动退回内置参谋提示词。</div>
            <button type="button" class="so-plan-mini" id="so-arc-new" title="实验性功能：把整条剧情弧线交给神谕做长程引导（仍在打磨）" style="display:none"><i class="fa-solid fa-route"></i> 新建弧线（手动·实验性）</button>
            <div id="so-arc-form" style="display:none">
                <div class="so-hint so-arc-exp-warn">⚠ 弧线系统是实验性功能：长程引导（多拍 / 盲盒 / 自动起草骨架）仍在打磨，行为可能随版本调整。上面的单拍「开始引导」已稳定，不受影响。</div>
                <label class="so-field"><span>引导方式</span>
                    <select id="so-arc-mode">
                        <option value="transparent" selected>全透明 —— 我看得到每拍指令，逐拍选强度</option>
                        <option value="blind">盲盒 —— 我只看任务，幕后指令保密（可揭开偷看）</option>
                    </select>
                </label>
                <label class="so-field"><span>贯穿线（一句话脊柱）</span><input id="so-arc-throughline" type="text" placeholder="例如：青璃与旧门派的恩怨了结"></label>
                <label class="so-field"><span id="so-arc-waypoints-label">路标（每行一个，意图级——透明弧你看得到每一拍，需自己填写）</span><textarea id="so-arc-waypoints" rows="4" placeholder="师父的背叛浮出水面&#10;幸存者开始跟踪青璃&#10;最终对峙"></textarea></label>
                <label class="so-field"><span>篇幅感（路标起草软范围）</span>
                    <select id="so-arc-span">
                        <option value="short">短篇（3-5 拍）</option>
                        <option value="medium" selected>中篇（5-9 拍）</option>
                        <option value="long">长篇（8-15 拍）</option>
                    </select>
                </label>
                <!-- 盲盒专属（mode=blind 时显示）：难度=赌注货币、红线=唯一安全护栏、风格 / 方向。 -->
                <div id="so-arc-blind-fields" style="display:none">
                    <label class="so-field"><span>难度 / 赌注层级</span>
                        <select id="so-arc-difficulty"></select>
                    </label>
                    <label class="so-field"><span>红线（每行一条，编译器绝不触碰；凛冽强烈建议至少一条）</span><textarea id="so-arc-redlines" rows="2" placeholder="导师不可死&#10;不可背叛挚友"></textarea></label>
                    <label class="so-field"><span>风格偏好（可选）</span><input id="so-arc-style" type="text" placeholder="悬疑 / 治愈 / 西幻…"></label>
                    <label class="so-field"><span>大致方向（关于什么，而非发生什么；可选）</span><input id="so-arc-direction" type="text" placeholder="例如：关于背叛与原谅"></label>
                </div>
                <div class="so-arc-form-actions">
                    <button type="button" class="so-plan-mini" id="so-arc-cancel">取消</button>
                    <button type="button" class="so-plan-mini so-plan-done" id="so-arc-create">创建透明弧</button>
                </div>
            </div>
        </div>

        <div id="so-plan-bar">
            <div class="so-plan-head">
                <i class="fa-solid fa-compass so-plan-icon"></i>
                <span class="so-plan-label" id="so-plan-label">引导中</span>
                <span class="so-arc-diff-badge" id="so-arc-diff-badge" style="display:none"></span>
                <span id="so-plan-goal"></span>
            </div>
            <div class="so-hint" id="so-plan-progress" style="display:none"></div>
            <div class="so-plan-intensity" id="so-plan-intensity"></div>
            <div class="so-hint" id="so-plan-caption"></div>
            <div class="so-arc-shaping-row" id="so-arc-shaping" style="display:none">
                <span class="so-arc-shaping-label">弧线节奏</span>
                <div class="so-plan-intensity" id="so-arc-shaping-seg"></div>
            </div>
            <div class="so-plan-actions">
                <button type="button" class="so-plan-mini" id="so-plan-show">▸ 查看注入内容</button>
                <span class="so-plan-spacer"></span>
                <button type="button" class="so-plan-mini so-plan-done" id="so-plan-done" title="目标已达成，停止引导">完成</button>
                <button type="button" class="so-plan-mini so-plan-drop" id="so-plan-drop" title="不再需要，停止引导">放弃</button>
                <button type="button" class="so-plan-mini so-plan-done" id="so-arc-complete" title="这一拍落地了，进入下一拍" style="display:none">完成</button>
                <button type="button" class="so-plan-mini" id="so-arc-reroll" title="同一路标换条路线" style="display:none">换个思路</button>
                <button type="button" class="so-plan-mini so-plan-done" id="so-arc-achieved" title="这一拍的任务达成了——揭晓幕后并进入下一拍" style="display:none">✓ 达成</button>
                <button type="button" class="so-plan-mini" id="so-arc-failed" title="任务没做到——把失败当素材，进入下一拍" style="display:none">✗ 失败</button>
                <button type="button" class="so-plan-mini" id="so-arc-reject" title="不喜欢这个任务，换一个（同一路标，不推进）" style="display:none">🚫 换个目标</button>
                <button type="button" class="so-plan-mini so-plan-drop" id="so-arc-exit" title="退出整条弧线（清除引导）" style="display:none">退出</button>
                <button type="button" class="so-plan-mini" id="so-arc-retry" title="重新编译这一拍" style="display:none">↻ 重试</button>
                <button type="button" class="so-plan-mini so-plan-drop" id="so-arc-stop" title="中断这次生成（卡住 / 等太久时用）" style="display:none">取消</button>
                <button type="button" class="so-plan-mini" id="so-arc-live" title="开一个浮窗看模型的实时输出——确认是在流式生成、还是真卡住了" style="display:none">📡 实时输出</button>
            </div>
            <pre id="so-plan-directive"></pre>
        </div>

        <div id="so-messages"></div>

        <div id="so-footer">
            <textarea id="so-input" rows="2" placeholder="就当前剧情提问…（Enter 发送，Shift+Enter 换行）"></textarea>
            <div class="so-iconbtn" id="so-send" title="发送"><i class="fa-solid fa-paper-plane"></i></div>
        </div>

        <div id="so-debug">
            <div id="so-debug-head">
                <span><i class="fa-solid fa-bug"></i> 上一次发送的提示词 <span id="so-debug-meta"></span></span>
                <div style="display:flex;gap:2px;">
                    <div class="so-iconbtn" id="so-debug-copy" title="复制完整提示词"><i class="fa-solid fa-copy"></i></div>
                    <div class="so-iconbtn" id="so-debug-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <pre id="so-debug-body"></pre>
        </div>

        <div id="so-summary">
            <div id="so-summary-head">
                <span><i class="fa-solid fa-scroll"></i> 剧情概要（本聊天）</span>
                <div style="display:flex;gap:2px;">
                    <div class="so-iconbtn" id="so-summary-clear" title="清空概要"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="so-iconbtn" id="so-summary-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <div id="so-summary-sub">粘贴你的运行总结 / 前情提要（比如存在补全预设或别处、神谕本来读不到的剧情梗概）。它随【本聊天】保存，并在【普通聊天】与【剧情参谋】模式下插入到最近对话记录的正前方。留空即不启用。</div>
            <textarea id="so-summary-text" placeholder="在此粘贴剧情概要 / 前情提要…"></textarea>
            <div id="so-summary-foot"><span id="so-summary-count"></span></div>
        </div>

        <div id="so-autowarn">
            <div id="so-autowarn-card">
                <div id="so-autowarn-head"><i class="fa-solid fa-triangle-exclamation"></i> 开启自动诊断模式？</div>
                <div id="so-autowarn-body">
                    <p>开启后，每当主聊天收到一条新的 AI 回复，故事神谕都会在后台自动处理它的 MVU 变量，并<strong>自动应用</strong>（无需点击确认，每次都会弹出可撤销提示；窗口关着也照常工作）：</p>
                    <p>· 回复里<strong>带有</strong> &lt;UpdateVariable&gt; 更新 → 核验并修正它；<br>· 回复里<strong>没有</strong>更新区块 → 直接据剧情<strong>推导</strong>出本回合应有的变量更新并补上。</p>
                    <p>因此它也能<strong>替代</strong> MVU 的「额外模型解析」：不必再开额外模型解析，改由自动诊断补出每回合的更新。</p>
                    <p class="so-autowarn-danger">⚠ 但切勿与「额外模型解析」<strong>同时</strong>开启：两者会抢着解析同一条回复、重复或冲突写入，产生错误数据。二者只用其一。</p>
                    <p class="so-autowarn-note">自动模式每条回复都会多发一次模型请求，会额外消耗 token。</p>
                </div>
                <label class="so-autowarn-check"><input type="checkbox" id="so-autowarn-never"><span>不再提示</span></label>
                <div id="so-autowarn-btns">
                    <button type="button" id="so-autowarn-cancel">取消</button>
                    <button type="button" id="so-autowarn-ok">开启自动模式</button>
                </div>
            </div>
        </div>

        <div id="so-fixwarn">
            <div id="so-fixwarn-card">
                <div id="so-fixwarn-head"><i class="fa-solid fa-circle-info"></i> 自动校正：只改你的故事正文</div>
                <div id="so-fixwarn-body">
                    <p><strong>自动校正</strong>会把你的<strong>故事正文</strong>交给模型重写一遍（去掉 AI 腔 / 套话、收紧读感），并作为<strong>新的一条 swipe</strong> 应用——原回复留在左滑，随时能滑回去，<strong>不破坏存档</strong>。</p>
                    <p><strong>校正只做</strong>：去 AI 腔、收紧读感。<strong>不</strong>翻译、<strong>不</strong>改设定、<strong>不</strong>算数值、<strong>不</strong>修卡片本身的问题——那些不归校正管。</p>
                    <p class="so-autowarn-danger">默认它<strong>只改 &lt;content&gt; 标签里的正文</strong>。你卡片正文<strong>之外</strong>的一切——状态栏、选项菜单、世界书、图片、变量面板——都会<strong>原样保留、原位不动</strong>，你不用做任何设置。</p>
                    <p><strong>唯一要确认的一点：</strong>如果你的卡片不是用 &lt;content&gt; 包正文，而是别的标签（例如 &lt;gametxt&gt;），把下面「<strong>只校正此标签内的正文</strong>」那一栏改成你卡片用的标签名就行。（留空 = 校正整条回复。）</p>
                    <p class="so-autowarn-note">进阶（多数卡用不到）：如果正文<strong>里面</strong>还夹着你想原样保住的小块（某个面板 / 折叠块 / 图片指令），把它的<strong>起始标记</strong>加进「排除区 · 保留」（也可以用上面的「扫描本卡正文标签」一键勾选加入）。正文<strong>外</strong>的东西不用管。</p>
                    <p class="so-autowarn-note">成本：自动模式<strong>每条新回复都会多发一次模型请求</strong>，会慢一点、多费点 token；很短 / 很干净的回复会自动跳过、不发请求。</p>
                </div>
                <label class="so-autowarn-check"><input type="checkbox" id="so-fixwarn-never"><span>不再提示</span></label>
                <div id="so-fixwarn-btns">
                    <button type="button" id="so-fixwarn-ok">知道了</button>
                </div>
            </div>
        </div>
        <div id="so-resize-grip" title="拖动调整大小" aria-label="调整窗口大小"></div>
    `;
    document.body.appendChild(win);

    messagesEl = win.querySelector('#so-messages');
    inputEl = win.querySelector('#so-input');
    sendBtn = win.querySelector('#so-send');
    modeBadge = win.querySelector('#so-mode-badge');

    bindControls();
    enhanceIconButtonA11y();
    loadSettingsIntoForm();
    planBarEl = win.querySelector('#so-plan-bar');
    // 手机：整条标题栏（含 8 个按钮）都能起拖——按钮太多、留给拖动的空隙太少（用户反馈「手机拖不动」）。
    // 复用折叠药丸那套（1.17.5）：dragFromButtons 放行「在按钮上起拖」，再用 6px 位移阈值区分轻点/拖动，
    // suppressNextClick 吞掉拖完补发的一下 click，所以轻点按钮照常触发、拖动才移动窗口。桌面（≥600）不传、行为不变。
    makeDraggable(win, win.querySelector('#so-header'), { left: 'winLeft', top: 'winTop' },
        { dragFromButtons: () => window.innerWidth < 600 });
    makeResizable(win, win.querySelector('#so-resize-grip'));
    renderEmptyState();
    renderPlanBar();
}

// 无障碍：图标按钮本是 <div>（为了样式自由），这里补上原生 <button> 该有的语义与键盘操作——
// role=button + 可聚焦（tabindex）+ Enter/空格触发，并把每个按钮已有的 title 复用为屏幕阅读器
// 的可读名（aria-label）。这样整套图标工具栏对键盘 / 读屏用户也完全可用，且无需改动任何模板标记。
function enhanceIconButtonA11y() {
    win.querySelectorAll('.so-iconbtn').forEach((b) => {
        b.setAttribute('role', 'button');
        if (!b.hasAttribute('tabindex')) b.setAttribute('tabindex', '0');
        if (!b.getAttribute('aria-label') && b.title) b.setAttribute('aria-label', b.title);
    });
    // 委托键盘事件：聚焦某个图标按钮时按 Enter / 空格即等同点击（原生 <button> 的默认行为）。
    // 输入框 / 文本域里的按键不会命中（closest 找不到 .so-iconbtn），故不影响打字与「Enter 发送」。
    win.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const btn = e.target.closest && e.target.closest('.so-iconbtn');
        if (!btn || !win.contains(btn)) return;
        e.preventDefault();
        btn.click();
    });
}

function bindControls() {
    const s = getSettings();

    win.querySelector('#so-close-btn').addEventListener('click', () => toggleWindow(false));
    win.querySelector('#so-clear-btn').addEventListener('click', clearConversation);
    win.querySelector('#so-diagnose-btn').addEventListener('click', toggleDiagnose);
    win.querySelector('#so-lorebook-btn').addEventListener('click', toggleLorebook);
    win.querySelector('#so-advisor-btn').addEventListener('click', toggleAdvisor);
    win.querySelector('#so-fix-btn').addEventListener('click', toggleFix);
    win.querySelector('#so-adv-preset').addEventListener('change', (e) => {
        const s2 = getSettings();
        s2.advisorUsePreset = e.target.checked;
        save();
        if (e.target.checked) {
            addSystemNote(presetCurationActive(s2)
                ? '已开启「套用补全预设」：剧情参谋指令会叠加在你的补全预设之上。注意预设可能分散模型注意力——仅在需要越狱时使用。'
                : '已勾选「套用补全预设」，但目前还没有整理好的补全预设。请先到设置（齿轮）里选定并整理一个补全预设；在此之前，参谋模式仍用内置提示词。');
        }
    });
    // Live depth change re-registers the active injection — wired AFTER the
    // generic bind() below so the new value is already persisted when it runs.
    win.querySelector('#so-plan-show').addEventListener('click', () => {
        // Query through planBarEl, not win — the strip may have been reparented
        // into the floating container by the time this fires.
        const pre = planBarEl.querySelector('#so-plan-directive');
        const open = pre.classList.toggle('open');
        planBarEl.querySelector('#so-plan-show').textContent = open ? '▾ 收起注入内容' : '▸ 查看注入内容';
        if (open) pre.textContent = currentInjectionPreview();   // type-aware (arc beat OR single plan)
        else pre.classList.remove('peek');                       // closing a blind spoiler re-masks it next open
    });
    // Blind spoiler: a masked (blurred) directive reveals on one tap (soft secrecy —
    // the goal is intentionally peekable). No-op when not a blind arc (no so-spoiler).
    win.querySelector('#so-plan-directive').addEventListener('click', (e) => {
        const pre = planBarEl.querySelector('#so-plan-directive');
        if (pre.classList.contains('so-spoiler')) { pre.classList.toggle('peek'); e.stopPropagation(); }
    });
    win.querySelector('#so-plan-done').addEventListener('click', () => endPlan(true));
    win.querySelector('#so-plan-drop').addEventListener('click', () => endPlan(false));
    // Arc lifecycle buttons. Hidden unless the matching arc kind is the active construct
    // (renderPlanBar toggles them); handlers are no-ops without one.
    // Transparent arc (layer 2):
    win.querySelector('#so-arc-complete').addEventListener('click', () => arcComplete());
    win.querySelector('#so-arc-reroll').addEventListener('click', () => arcRerollBeat());
    // Blind arc (layer 4): ✓ reveal+advance · ✗ absorb failure+advance · 🚫 swap objective.
    win.querySelector('#so-arc-achieved').addEventListener('click', () => arcMarkAchieved());
    win.querySelector('#so-arc-failed').addEventListener('click', () => arcMarkFailed());
    win.querySelector('#so-arc-reject').addEventListener('click', () => arcRejectObjective());
    // Shared by both arc kinds:
    win.querySelector('#so-arc-exit').addEventListener('click', () => confirmArcExit());
    win.querySelector('#so-arc-retry').addEventListener('click', () => {
        if (!arcRetryPending) return;
        if (arcRetryPending.achieve) arcMarkAchieved();        // 合并「达成」失败的重试：重走 ✓
        else runCompileTransition(arcRetryPending);
    });
    // 中断在途生成（超时护栏之外的手动逃生口）：abort 当前调用 → 重试循环识别中断 → 失败分支清 busy + 留「重试」。
    win.querySelector('#so-arc-stop').addEventListener('click', () => arcCancelInflight());
    // 开 / 关「实时输出」浮窗：看模型流式回传的内容（含 reasoning），确认在流 vs 卡死。
    win.querySelector('#so-arc-live').addEventListener('click', () => toggleArcLiveViewer());
    // Manual arc creation (the "place beats by hand" entry; gated by ENABLE_ARC).
    win.querySelector('#so-arc-new').style.display = ENABLE_ARC ? '' : 'none';
    win.querySelector('#so-arc-new').addEventListener('click', () => {
        const form = win.querySelector('#so-arc-form');
        form.style.display = (form.style.display === 'none') ? 'flex' : 'none';
    });
    win.querySelector('#so-arc-cancel').addEventListener('click', () => {
        win.querySelector('#so-arc-form').style.display = 'none';
    });
    win.querySelector('#so-arc-create').addEventListener('click', onArcCreate);
    // Difficulty options come straight from ADVISOR_DIFFICULTIES (single source of truth).
    const diffSel = win.querySelector('#so-arc-difficulty');
    for (const [key, D] of Object.entries(ADVISOR_DIFFICULTIES)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = `${D.label} —— ${D.caption}`;
        if (key === 'normal') opt.selected = true;
        diffSel.appendChild(opt);
    }
    // Mode toggle: reveal the blind-only consent fields + relabel the create button.
    win.querySelector('#so-arc-mode').addEventListener('change', (e) => {
        const blind = e.target.value === 'blind';
        win.querySelector('#so-arc-blind-fields').style.display = blind ? 'block' : 'none';
        win.querySelector('#so-arc-create').textContent = blind ? '创建盲盒弧' : '创建透明弧';
        // 路标说明随模式变：盲盒可留空（神谕自动起草整条骨架）；透明你看得到每一拍，必须自己填。
        const wpLabel = win.querySelector('#so-arc-waypoints-label');
        if (wpLabel) wpLabel.textContent = blind
            ? '路标（每行一个，意图级——盲盒可留空＝由神谕按篇幅暗中拟定整条骨架）'
            : '路标（每行一个，意图级——透明弧你看得到每一拍，需自己填写）';
    });
    win.querySelector('#so-lb-refresh').addEventListener('click', () => populateLorebookBooks(true));
    win.querySelector('#so-lb-book-list').addEventListener('change', (e) => {
        if (e.target && e.target.matches('input[type="checkbox"]')) onLbBookSelectionChange();
    });
    win.querySelector('#so-lb-book-all').addEventListener('click', () => {
        win.querySelectorAll('#so-lb-book-list input[type="checkbox"]').forEach((b) => { b.checked = true; });
        onLbBookSelectionChange();
    });
    win.querySelector('#so-lb-book-none').addEventListener('click', () => {
        win.querySelectorAll('#so-lb-book-list input[type="checkbox"]').forEach((b) => { b.checked = false; });
        onLbBookSelectionChange();
    });
    win.querySelector('#so-lb-story').addEventListener('change', (e) => {
        getSettings().lorebookIncludeStory = e.target.checked;
        save();
    });
    win.querySelector('#so-lb-preset').addEventListener('change', (e) => {
        const s2 = getSettings();
        s2.lorebookUsePreset = e.target.checked;
        save();
        if (e.target.checked) {
            addSystemNote(presetCurationActive(s2)
                ? '已开启「套用补全预设」：世界书管家指令会叠加在你的补全预设之上。注意预设可能分散模型注意力、影响编辑精度——仅在需要越狱时使用。'
                : '已勾选「套用补全预设」，但目前还没有整理好的补全预设。请先到设置（齿轮）里选定并整理一个补全预设；在此之前，世界书模式仍用内置管家提示词。');
        }
    });
    win.querySelector('#so-lb-entries-toggle').addEventListener('click', () => {
        win.querySelector('#so-lb-entries').classList.toggle('open');
    });
    // 手机上把模式工具栏（诊断 / 世界书的配置栏）默认折叠，先把聊天区露出来；桌面保持展开。用户随后可自行开合。
    if (window.matchMedia && window.matchMedia('(max-width: 600px)').matches) {
        win.querySelectorAll('#so-lb-collapse, #so-diag-collapse, #so-fix-collapse').forEach((d) => { d.open = false; });
    }
    win.querySelector('#so-lb-all').addEventListener('click', () => setAllLbEntries(true));
    win.querySelector('#so-lb-none').addEventListener('click', () => setAllLbEntries(false));
    win.querySelector('#so-lb-filtered').addEventListener('click', () => selectFilteredLbEntries());
    win.querySelector('#so-lb-blue').addEventListener('click', () => setLbEntriesByType('blue'));
    win.querySelector('#so-lb-green').addEventListener('click', () => setLbEntriesByType('green'));
    win.querySelector('#so-lb-disabled').addEventListener('click', () => setLbEntriesByType('off'));
    win.querySelector('#so-lb-preview-toggle').addEventListener('click', () => toggleLbPreview());
    win.querySelector('#so-lb-entries-filter').addEventListener('input', (e) => filterLbEntries(e.target.value));
    // 诊断「精选世界书条目」绑定（用户功能请求；ENABLE_DIAG_WI_PICKER）。关掉时隐藏整条栏、不挂任何处理器。
    if (ENABLE_DIAG_WI_PICKER) {
        win.querySelector('#so-diag-usesel').addEventListener('change', (e) => onDiagUseSelToggle(e.target.checked));
        win.querySelector('#so-diag-hybrid').addEventListener('change', (e) => onDiagHybridToggle(e.target.checked));
        win.querySelector('#so-diag-refresh').addEventListener('click', () => populateDiagWiBooks(true));
        win.querySelector('#so-diag-book').addEventListener('change', (e) => {
            const meta = getDiagWiMeta();
            setDiagWiMeta({ use: meta.use, hybrid: meta.hybrid, target: e.target.value, sel: serializeDiagSel(diagEntrySel) });
            updateDiagHint();
            populateDiagWiEntries();
        });
        win.querySelector('#so-diag-entries-toggle').addEventListener('click', () => {
            win.querySelector('#so-diag-entries').classList.toggle('open');
        });
        win.querySelector('#so-diag-all').addEventListener('click', () => setAllDiagEntries(true));
        win.querySelector('#so-diag-none').addEventListener('click', () => setAllDiagEntries(false));
        win.querySelector('#so-diag-filtered').addEventListener('click', () => selectFilteredDiagEntries());
        win.querySelector('#so-diag-blue').addEventListener('click', () => setDiagEntriesByType('blue'));
        win.querySelector('#so-diag-green').addEventListener('click', () => setDiagEntriesByType('green'));
        win.querySelector('#so-diag-disabled').addEventListener('click', () => setDiagEntriesByType('off'));
        win.querySelector('#so-diag-entries-filter').addEventListener('input', (e) => filterDiagEntries(e.target.value));
    } else {
        const bar = win.querySelector('#so-diag-bar');
        if (bar) bar.style.display = 'none';
    }
    // 标题栏「⋯」工具下拉：把 剧情概要 / 调试 / 设置 三个次级按钮收进一个下拉里。它们的 id 与各自
    // 的点击处理保持不变（只是被挪进菜单内），所以下面 openDebug / 设置开关 / openSummary 的绑定照旧生效。
    const toolsBtn = win.querySelector('#so-tools-btn');
    const toolsMenu = win.querySelector('#so-tools-menu');
    const closeToolsMenu = () => {
        if (!toolsMenu) return;
        toolsMenu.classList.remove('open');
        if (toolsBtn) toolsBtn.setAttribute('aria-expanded', 'false');
    };
    if (toolsBtn && toolsMenu) {
        toolsBtn.addEventListener('click', () => {
            const open = toolsMenu.classList.toggle('open');
            toolsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        // 点菜单里的任意一项后收起（该项自己的处理仍会照常触发，打开对应面板 / 设置）。
        toolsMenu.addEventListener('click', (e) => {
            if (e.target.closest('.so-tools-item')) closeToolsMenu();
        });
        // 点别处或按 Esc 收起。
        document.addEventListener('click', (e) => {
            if (toolsMenu.classList.contains('open') && !e.target.closest('.so-tools-wrap')) closeToolsMenu();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && toolsMenu.classList.contains('open')) closeToolsMenu();
        });
    }
    // 「普通聊天」菜单项：从任何模式一键回普通聊天（仅切换视图——自动诊断如开启会继续在后台跑，
    // 诊断按钮仍红；要停自动诊断请点诊断按钮）。菜单收起由上面的 .so-tools-item 监听统一处理。
    win.querySelector('#so-normalchat-btn')?.addEventListener('click', () => {
        if (currentOracleMode() === 'chat') {
            // 已在普通聊天：自动诊断后台武装时，本项当开关用——再点一次回到诊断视图（否则普通聊天是死胡同）。
            if (diagShouldReveal(diagnoseMode, ENABLE_AUTO_DIAGNOSE && !!getSettings().autoDiagnoseEnabled)) {
                setOracleMode('diagnose');
                if (inputEl) inputEl.focus();
            }
            return;
        }
        priorOracleMode = 'chat';
        setOracleMode('chat');
        modeEntryNote('已返回普通聊天模式。');
    });
    win.querySelector('#so-debug-btn').addEventListener('click', openDebug);
    win.querySelector('#so-debug-close').addEventListener('click', () => win.querySelector('#so-debug').classList.remove('open'));
    win.querySelector('#so-debug-copy').addEventListener('click', async () => {
        const btn = win.querySelector('#so-debug-copy');
        const ok = await copyTextRobust(win.querySelector('#so-debug-body').textContent || '');
        if (ok) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i>';
            setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 1200);
        } else {
            btn.title = '复制失败 —— 请手动选择文本';
        }
    });
    win.querySelector('#so-settings-btn').addEventListener('click', () => {
        const panel = win.querySelector('#so-settings');
        const open = panel.classList.toggle('open');
        win.classList.toggle('so-settings-open', open);   // lets CSS free up space (hide mode toolbar)
        if (open) { refreshProfiles(); populateSysPromptPresets(); }
    });
    // 用户功能请求：剧情概要编辑器（本聊天，自动保存到元数据）。
    win.querySelector('#so-summary-btn').addEventListener('click', openSummary);
    win.querySelector('#so-summary-close').addEventListener('click', () => win.querySelector('#so-summary').classList.remove('open'));
    win.querySelector('#so-summary-text').addEventListener('input', (e) => {
        setSummary(e.target.value);
        updateSummaryIndicator(e.target.value);
    });
    win.querySelector('#so-summary-clear').addEventListener('click', async () => {
        const ta = win.querySelector('#so-summary-text');
        if (ta.value.trim() && !(await uiConfirm('确定清空本聊天的剧情概要吗？'))) return;
        ta.value = '';
        setSummary('');
        updateSummaryIndicator('');
        ta.focus();
    });
    // 用户功能请求：自动诊断首次开启前的一次性警告弹窗。
    const closeAutoWarn = () => win.querySelector('#so-autowarn').classList.remove('open');
    win.querySelector('#so-autowarn-cancel').addEventListener('click', closeAutoWarn);
    win.querySelector('#so-autowarn-ok').addEventListener('click', () => {
        if (win.querySelector('#so-autowarn-never').checked) { getSettings().autoDiagnoseWarned = true; save(); }
        closeAutoWarn();
        applyDiagButtonState('auto');
    });
    // ✨ 校正：切到「自动校正」时的一次性标签块提醒（信息性，无需取消——已经切过去了，只是提醒）。
    const fixWarnOk = win.querySelector('#so-fixwarn-ok');
    if (fixWarnOk) fixWarnOk.addEventListener('click', () => {
        if (win.querySelector('#so-fixwarn-never').checked) { getSettings().autoFixWarned = true; save(); }
        win.querySelector('#so-fixwarn').classList.remove('open');
    });
    win.querySelector('#so-profile-refresh').addEventListener('click', refreshProfiles);

    // settings inputs -> persist
    const bind = (id, key, parse = (v) => v) => {
        const el = win.querySelector(id);
        const evt = (el.type === 'checkbox') ? 'change' : 'input';
        el.addEventListener(evt, () => {
            s[key] = el.type === 'checkbox' ? el.checked : parse(el.value);
            if (key === 'mode') {
                applyModeVisibility();
                if (s.mode === 'profile') refreshProfiles();
            }
            updateBadge();
            save();
        });
    };
    bind('#so-mode', 'mode');
    bind('#so-endpoint', 'endpoint', (v) => v.trim());
    bind('#so-apikey', 'apiKey', (v) => v.trim());
    bind('#so-model', 'model', (v) => v.trim());
    bind('#so-stream', 'stream');
    // 用户功能请求：聊天栏快捷按钮开关——改设置后立刻放 / 撤按钮（不只是存）。
    win.querySelector('#so-chatbar-toggle').addEventListener('change', (e) => {
        getSettings().showChatBarButton = e.target.checked;
        save();
        syncChatBarButton();
    });
    bind('#so-profile', 'profileId');
    bind('#so-temp', 'temperature', (v) => parseFloat(v));
    bind('#so-maxtok', 'maxTokens', (v) => parseInt(v, 10));
    bind('#so-depth', 'contextDepth', (v) => parseInt(v, 10));
    bind('#so-adv-depth', 'advisorDepth', (v) => parseInt(v, 10));
    // After bind() has written the new depth, re-register the active injection —
    // otherwise the setting silently applies only on the next chat switch.
    win.querySelector('#so-adv-depth').addEventListener('input', () => applyPlanInjection());
    bind('#so-card', 'includeCard');
    bind('#so-stat', 'chatIncludeStat');
    bind('#so-world', 'chatIncludeWorld');
    bind('#so-hidden', 'includeHiddenFloors');
    // ✨ 校正模式 Phase 4：校正配置按【当前聊天】持久化（chat A 的目标不渗进 chat B）。专用 bindFix——
    // 写到 setFixCfg（per-chat 元数据）而非 getSettings()；不写全局、不调 save()（setFixCfg 自己触发 saveChatMetadata）。
    const bindFix = (id, key, parse = (v) => v) => {
        const el = win.querySelector(id);
        const evt = (el.type === 'checkbox') ? 'change' : 'input';
        el.addEventListener(evt, () => {
            setFixCfg({ [key]: el.type === 'checkbox' ? el.checked : parse(el.value) });
        });
    };
    // ✨ 校正 手动/自动 分家（2026-06-26）：下拉只切「显示哪套设置」（纯 UI 视图，全局存 fixSettingsView，不进 per-chat）。
    const fixModeSel = win.querySelector('#so-fix-mode-select');
    if (fixModeSel) {
        fixModeSel.addEventListener('change', () => {
            getSettings().fixSettingsView = (fixModeSel.value === 'auto') ? 'auto' : 'manual';
            save();
            applyFixModeView();
            // 首次切到「自动校正」→ 弹一次性标签块提醒（用户功能请求）。仅用户手动 change 触发；
            // applyFixModeView 程序化设 sel.value 不发 change，故载入 / 切聊天不会误弹。
            if (fixModeSel.value === 'auto' && !getSettings().autoFixWarned) openAutoFixWarn();
        });
    }
    // ✨ 经预设发送（破限 / 越狱用）—— 全局开关（不进 per-chat），同 advisorUsePreset 写法（写 getSettings + save）。
    const fixmPresetCb = win.querySelector('#so-fixm-preset');
    if (fixmPresetCb) fixmPresetCb.addEventListener('change', () => { getSettings().fixM_usePreset = fixmPresetCb.checked; save(); applyFixPresetLock(); });
    const fixaPresetCb = win.querySelector('#so-fixa-preset');
    if (fixaPresetCb) fixaPresetCb.addEventListener('change', () => { getSettings().fixA_usePreset = fixaPresetCb.checked; save(); applyFixPresetLock(); });
    // 数字框条数 parse：非数字 / 非正数 → -1（全部），正数原样。手动 / 自动各一份独立存储。
    const depthParse = (v) => { const n = parseInt(v, 10); return (Number.isNaN(n) || n <= 0) ? -1 : n; };
    // 手动模式控件（fixM_*）——上下文条数 / 卡 / 世界书 / 概要。
    bindFix('#so-fixm-depth', 'fixM_contextDepth', depthParse);
    bindFix('#so-fixm-card', 'fixM_includeCard');
    bindFix('#so-fixm-world', 'fixM_includeWorld');
    bindFix('#so-fixm-summary', 'fixM_includeSummary');
    // 自动模式控件（fixA_*）——目标 / 排除区 / 约束 / 收紧 / 折叠上下文 + 运行按钮 + 自动开关。
    bindFix('#so-fix-tgt-slop', 'fixA_targetSlop');
    bindFix('#so-fix-tgt-dialogue', 'fixA_targetDialogue');
    bindFix('#so-fix-tgt-precision', 'fixA_targetPrecision');
    bindFix('#so-fix-tgt-magic', 'fixA_targetMagic');
    bindFix('#so-fix-tgt-pacing', 'fixA_targetPacing');
    // ✨ 作用域标签（per-chat）。Phase 5（D+E）：用户在这里亲手打字 = 明确表达了意图，标记 fixA_scopeManual:true——
    // 之后 resolveFixScope 缓存未命中时永不代替用户改写，只会建议（suggest），不会自作主张 detected 采纳新标签。
    win.querySelector('#so-fix-scope').addEventListener('input', (e) => { setFixCfg({ fixA_scopeTag: e.target.value, fixA_scopeManual: true }); updateFixVerdict(); });
    win.querySelector('#so-fix-keep').addEventListener('input', (e) => { setFixCfg({ fixA_keepTags: e.target.value }); updateFixVerdict(); });
    win.querySelector('#so-fix-drop').addEventListener('input', (e) => { setFixCfg({ fixA_dropTags: e.target.value }); });
    win.querySelector('#so-fix-know').addEventListener('input', (e) => { setFixCfg({ fixA_knowledgeBoundary: e.target.value }); });
    win.querySelector('#so-fix-guard').addEventListener('input', (e) => { setFixCfg({ fixA_guardrails: e.target.value }); });
    bindFix('#so-fix-tighten', 'fixA_tighten');
    // ✨ 校正提示词选择器（轻校 / 精校 + 侧重）：写 per-chat；切版本时即时显隐侧重行。归一在此就地做（只认 thorough / opus）。
    win.querySelector('#so-fix-prompt-version')?.addEventListener('change', (e) => {
        setFixCfg({ fixA_promptVersion: e.target.value === 'thorough' ? 'thorough' : 'light' });
        applyFixFlavorView();
    });
    win.querySelector('#so-fix-prompt-flavor')?.addEventListener('change', (e) => {
        setFixCfg({ fixA_promptFlavor: e.target.value === 'opus' ? 'opus' : 'deepseek' });
    });
    bindFix('#so-fix-card', 'fixA_includeCard');
    bindFix('#so-fix-ctx', 'fixA_includeContext');
    bindFix('#so-fix-ctx-depth', 'fixA_contextDepth', depthParse);
    bindFix('#so-fix-world', 'fixA_includeWorld');
    bindFix('#so-fixa-summary', 'fixA_includeSummary');
    win.querySelector('#so-fix-run').addEventListener('click', () => { runFixByTargets(); });
    win.querySelector('#so-fix-scan')?.addEventListener('click', () => { scanFixScope(); });   // ✨ Phase 6：扫描本卡正文标签
    win.querySelector('#so-fix-reset')?.addEventListener('click', () => { resetFixCfg(); });   // ✨ Phase 7（M4）：恢复推荐设置
    bindFix('#so-fix-auto', 'autoFixEnabled');   // 自动校正每条新回复（message_received 编排读 cfg.autoFixEnabled）
    win.querySelector('#so-fix-auto')?.addEventListener('change', updateFixButtonVisual);   // 改开关 → ✨ 金色指示即时对齐
    // ✨ 校正 Phase 4：全局命名套餐库——加载 / 保存为… / 删除（saveFixBundle / loadFixBundle / deleteFixBundle + populateFixBundles）。
    win.querySelector('#so-fix-bundle-load').addEventListener('click', () => {
        const sel = win.querySelector('#so-fix-bundle');
        const name = sel && sel.value;
        if (!name) { toastr.info('先选一个已存套餐'); return; }
        if (loadFixBundle(name)) toastr.success(`已加载套餐「${name}」到本聊天`);
    });
    win.querySelector('#so-fix-bundle-save').addEventListener('click', async () => {
        const name = await uiPrompt('给这套校正配置起个名字（如「硬核西幻」）：', '');
        const trimmed = (name || '').trim();
        if (!trimmed) return;   // 取消 / 空 = no-op
        if (saveFixBundle(trimmed)) { populateFixBundles(); const sel = win.querySelector('#so-fix-bundle'); if (sel) sel.value = trimmed; toastr.success(`已保存套餐「${trimmed}」`); }
    });
    win.querySelector('#so-fix-bundle-del').addEventListener('click', async () => {
        const sel = win.querySelector('#so-fix-bundle');
        const name = sel && sel.value;
        if (!name) { toastr.info('先选一个要删的套餐'); return; }
        if (!(await uiConfirm(`删除套餐「${name}」？`))) return;
        if (deleteFixBundle(name)) { populateFixBundles(); toastr.success(`已删除套餐「${name}」`); }
    });
    bind('#so-regex', 'applyRegex');
    bind('#so-wi', 'worldInfoMode');
    bind('#so-sendtemp', 'sendTemperature');
    win.querySelector('#so-wi').addEventListener('change', updateWiHint);
    bind('#so-persona', 'personaId');
    win.querySelector('#so-sysprompt-preset').addEventListener('change', (e) => onPresetSelected(e.target.value));
    win.querySelector('#so-sysprompt-preset-refresh').addEventListener('click', populateSysPromptPresets);
    win.querySelector('#so-sysprompt-preset-recurate').addEventListener('click', () => {
        const cur = getSettings().sysPromptPresetName;
        if (cur) openCuration(cur);
    });
    // 系统提示词：上方下拉决定文本框正在编辑哪个模式的提示词；文本框各模式共用，
    // 写入时按当前所选模式写到对应的 key（chat: systemPrompt；diagnose/lorebook: 覆盖）。
    win.querySelector('#so-sysprompt-which').addEventListener('change', (e) => {
        sysPromptEditMode = sysPromptModeDef(e.target.value).id;
        loadSysPromptForMode();
    });
    win.querySelector('#so-sysprompt').addEventListener('input', (e) => {
        getSettings()[sysPromptModeDef(sysPromptEditMode).key] = e.target.value;
        save();
        if (sysPromptEditMode !== 'chat') applySysPromptModeUiState(); // 实时刷新「内置 / 已自定义」提示
    });
    win.querySelector('#so-sysprompt-reset').addEventListener('click', async () => {
        const def = sysPromptModeDef(sysPromptEditMode);
        if (!(await uiConfirm(`确定把「${def.label}」的系统提示词重置为内置默认吗？当前的修改会丢失。`))) return;
        const s2 = getSettings();
        if (def.id === 'chat') s2.systemPrompt = DEFAULT_SYSTEM_PROMPT;  // 恢复随扩展附带的默认
        else s2[def.key] = '';                                          // 清空覆盖 → 退回内置
        save();
        loadSysPromptForMode();
        addSystemNote(`已将「${def.label}」的系统提示词重置为内置默认。`);
    });

    // send
    sendBtn.addEventListener('click', onSend);
    win.querySelector('#so-model-fetch').addEventListener('click', onFetchModels);
    win.querySelector('#so-model-list').addEventListener('change', (e) => {
        const val = e.target.value;
        if (!val) return;
        const input = win.querySelector('#so-model');
        input.value = val;
        s.model = val;
        updateBadge();
        save();
    });
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
        }
    });
    inputEl.addEventListener('input', autoGrowInput);                                                      // #4 输入框随内容自动增高
    messagesEl.addEventListener('scroll', () => { if (!soProgScroll) soFollowStream = nearBottom(); });    // #1 用户滚动更新「是否跟随到底部」

    // 用户功能请求：反映持久化的自动诊断状态（重载后若 AUTO 仍开着，按钮显示红色 + AUTO）。
    updateDiagButtonVisual();
    updateFixButtonVisual();
}

function loadSettingsIntoForm() {
    const s = getSettings();
    win.querySelector('#so-mode').value = s.mode;
    win.querySelector('#so-endpoint').value = s.endpoint;
    win.querySelector('#so-apikey').value = s.apiKey;
    win.querySelector('#so-model').value = s.model;
    win.querySelector('#so-stream').checked = !!s.stream;
    win.querySelector('#so-temp').value = s.temperature;
    win.querySelector('#so-maxtok').value = s.maxTokens;
    win.querySelector('#so-depth').value = s.contextDepth;
    win.querySelector('#so-adv-depth').value = s.advisorDepth;
    win.querySelector('#so-card').checked = !!s.includeCard;
    win.querySelector('#so-stat').checked = !!s.chatIncludeStat;
    win.querySelector('#so-world').checked = !!s.chatIncludeWorld;
    win.querySelector('#so-hidden').checked = !!s.includeHiddenFloors;
    // ✨ 校正模式 Phase 4：校正控件从【本聊天】生效配置读种子（per-chat 覆盖全局）——不直读 s.fix*。
    seedFixControls();
    populateFixBundles();   // ✨ 校正 Phase 4：填充全局命名套餐下拉
    win.querySelector('#so-chatbar-toggle').checked = !!s.showChatBarButton;
    win.querySelector('#so-regex').checked = !!s.applyRegex;
    win.querySelector('#so-wi').value = s.worldInfoMode;
    win.querySelector('#so-sendtemp').checked = !!s.sendTemperature;
    win.querySelector('#so-lb-story').checked = !!s.lorebookIncludeStory;
    win.querySelector('#so-lb-preset').checked = !!s.lorebookUsePreset;
    reflectLbPreview();   // 「👁 内容预览」开关按钮初始高亮跟随保存的设置

    win.querySelector('#so-adv-preset').checked = !!s.advisorUsePreset;
    updateWiHint();
    populatePersonas();
    // 系统提示词模式编辑器：首次用 SYSPROMPT_MODES 填充模式下拉，再把当前所选模式的
    // 提示词载入共用文本框。
    const whichSel = win.querySelector('#so-sysprompt-which');
    if (whichSel && !whichSel.options.length) {
        for (const m of SYSPROMPT_MODES) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label;
            whichSel.appendChild(opt);
        }
    }
    if (whichSel) whichSel.value = sysPromptEditMode;
    populateSysPromptPresets();
    loadSysPromptForMode();
    applyModeVisibility();
    updateBadge();
}

function populatePersonas() {
    const sel = win.querySelector('#so-persona');
    if (!sel) return;
    sel.innerHTML = '';
    for (const p of PERSONAS) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        sel.appendChild(opt);
    }
    const s = getSettings();
    sel.value = PERSONAS.some((p) => p.id === s.personaId) ? s.personaId : 'plain';
}

function applyModeVisibility() {
    const s = getSettings();
    win.querySelector('#so-direct-fields').style.display = s.mode === 'direct' ? '' : 'none';
    win.querySelector('#so-profile-fields').style.display = s.mode === 'profile' ? '' : 'none';
}

function updateWiHint() {
    const hint = win.querySelector('#so-wi-hint');
    if (!hint) return;
    const mode = win.querySelector('#so-wi').value;
    if (mode === 'st') {
        hint.textContent = '像主提示词一样扫描聊天：蓝色（常驻）条目始终注入，绿色（关键词）条目在其关键词匹配时注入。';
    } else if (mode === 'all') {
        hint.textContent = '无视关键词，发送所有已启用的世界书条目。适合做规划，但可能会消耗大量 token。';
    } else if (mode === 'char') {
        hint.textContent = '只扫描角色相关世界书（角色卡内嵌 + 角色绑定 + 本对话绑定），排除全局与人设世界书；蓝灯常驻 + 绿灯关键词匹配照常。';
    } else {
        hint.textContent = '';
    }
}

function updateBadge() {
    const s = getSettings();
    let label = '';
    if (s.mode === 'direct') {
        label = s.model || '未设置模型';
    } else {
        const p = getProfiles().find((x) => x.id === s.profileId);
        label = p ? p.name : '未选择配置文件';
    }
    modeBadge.textContent = label ? `· ${label}` : '';
}

function getProfiles() {
    const ctx = getCtx();
    // Preferred: the service-filtered list (only types we can actually send to).
    try {
        const supported = ctx.ConnectionManagerRequestService?.getSupportedProfiles?.();
        if (Array.isArray(supported) && supported.length) return supported;
    } catch (e) {
        console.warn('[Story Oracle] getSupportedProfiles failed, falling back to raw profiles:', e);
    }
    // Fallback: raw saved profiles. Covers version differences and over-strict filtering.
    const raw = ctx.extensionSettings?.connectionManager?.profiles;
    return Array.isArray(raw) ? raw.filter((p) => p && p.id) : [];
}

function profilesStatus() {
    const ctx = getCtx();
    if (!ctx.ConnectionManagerRequestService) {
        return '当前 ST 版本未找到连接管理器 —— 请改用直连模式。';
    }
    const raw = ctx.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(raw) || raw.length === 0) {
        return '未找到已保存的配置文件。请先在 ST 的“连接配置文件”面板中创建一个（API 设置里的书签图标）。';
    }
    return '存在配置文件，但似乎没有兼容的。请尝试刷新按钮，或改用直连模式。';
}

function refreshProfiles() {
    const s = getSettings();
    const sel = win.querySelector('#so-profile');
    const hint = win.querySelector('#so-profile-hint');
    const profiles = getProfiles();
    sel.innerHTML = '';
    if (!profiles.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '— 无 —';
        sel.appendChild(opt);
        if (hint) hint.textContent = profilesStatus();
        return;
    }
    if (hint) hint.textContent = '通过 ST 服务器转发（无 CORS）。新增配置文件后请点击刷新。';
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || p.id;
        sel.appendChild(opt);
    }
    if (s.profileId && profiles.some((p) => p.id === s.profileId)) {
        sel.value = s.profileId;
    } else {
        s.profileId = sel.value;
        save();
    }
    updateBadge();
}

/* ------------------------------------------------------------------ *
 * Chat Completion presets as system-prompt source
 *
 * A user can pick one of their saved Chat Completion presets; we flatten its
 * written (non-marker) prompt blocks into a single system prompt and use that
 * instead of the textarea. Markers (chat history, char description, world info,
 * etc.) are runtime-injection placeholders, so we skip them. Macros are left
 * intact — buildSystemPrompt() runs the whole thing through substituteParams().
 * ------------------------------------------------------------------ */
function getCompletionPresetManager() {
    const ctx = getCtx();
    try {
        if (typeof ctx.getPresetManager === 'function') {
            return ctx.getPresetManager('openai') || ctx.getPresetManager();
        }
    } catch (e) {
        console.warn('[Story Oracle] getPresetManager failed:', e);
    }
    return null;
}

function getCompletionPresetNames() {
    const pm = getCompletionPresetManager();
    if (!pm || typeof pm.getPresetList !== 'function') return [];
    let list;
    try { list = pm.getPresetList(); } catch (e) { return []; }
    if (!list) return [];
    const names = list.preset_names ?? list.presetNames;
    if (Array.isArray(names)) return names.filter(Boolean);
    if (names && typeof names === 'object') return Object.keys(names);
    if (Array.isArray(list.presets)) return list.presets.map((p) => p && p.name).filter(Boolean);
    return [];
}

function getPresetByName(name) {
    const pm = getCompletionPresetManager();
    if (!pm) return null;
    try {
        if (typeof pm.getCompletionPresetByName === 'function') {
            const p = pm.getCompletionPresetByName(name);
            if (p) return p;
        }
    } catch (e) { /* fall through */ }
    try {
        const list = pm.getPresetList?.();
        if (list && Array.isArray(list.presets)) {
            const nm = list.preset_names ?? list.presetNames;
            if (nm && typeof nm === 'object' && nm[name] != null) return list.presets[nm[name]];
            const hit = list.presets.find((p) => p && p.name === name);
            if (hit) return hit;
        }
    } catch (e) { /* ignore */ }
    return null;
}

// Best-effort name of the Chat Completion preset currently active in MAIN chat,
// for the curation mismatch warning. Returns '' if it can't be determined.
function getActiveMainPresetName() {
    const pm = getCompletionPresetManager();
    if (!pm) return '';
    try { if (typeof pm.getSelectedPresetName === 'function') return pm.getSelectedPresetName() || ''; } catch (e) { /* */ }
    try {
        if (typeof pm.getSelectedPreset === 'function') {
            const v = pm.getSelectedPreset();
            if (typeof v === 'string') return v;
            const list = pm.getPresetList?.();
            const names = list && (list.preset_names ?? list.presetNames);
            if (names && typeof names === 'object' && !Array.isArray(names)) {
                for (const [n, i] of Object.entries(names)) if (i === v) return n;
            }
            if (Array.isArray(names) && typeof v === 'number') return names[v] || '';
        }
    } catch (e) { /* */ }
    return '';
}

// Flatten a Chat Completion preset's enabled, ordered, non-marker prompt blocks.
// SillyTavern's runtime-injection markers. Each is a positional slot that the
// faithful assembly fills with the Oracle's own context, in the preset's order.
const MARKER_IDS = new Set([
    'personaDescription', 'worldInfoBefore', 'charDescription', 'charPersonality',
    'scenario', 'worldInfoAfter', 'dialogueExamples', 'chatHistory',
]);

// Pull a preset's ordered block list. Returns [{ block, enabledInOrder }] in
// sequence (ALL blocks, enabled and disabled — the caller marks the disabled
// ones), or [] if unreadable.
function readPresetOrderedBlocks(preset) {
    if (!preset || !Array.isArray(preset.prompts)) return [];
    const byId = {};
    for (const p of preset.prompts) if (p && p.identifier) byId[p.identifier] = p;

    // The global prompt order. Real presets key it 100001 (older builds 100000);
    // pick whichever exists, else the longest order, else the first entry.
    let entry = null;
    if (Array.isArray(preset.prompt_order) && preset.prompt_order.length) {
        const po = preset.prompt_order;
        entry = po.find((e) => e && e.character_id === 100001)
             || po.find((e) => e && e.character_id === 100000)
             || po.slice().sort((a, b) => (b?.order?.length || 0) - (a?.order?.length || 0))[0]
             || po[0];
    }
    const order = entry && Array.isArray(entry.order) ? entry.order : null;
    if (!order) {
        // No usable order: fall back to prompt array order (treat all as enabled).
        return preset.prompts.filter(Boolean).map((b) => ({ block: b, enabledInOrder: true }));
    }
    const out = [];
    for (const o of order) {
        if (!o) continue;
        const b = byId[o.identifier];
        if (b) out.push({ block: b, enabledInOrder: o.enabled !== false });
    }
    return out;
}

// Strip every {{...}} macro (iteratively, to peel nesting) and trim — what
// remains is the block's visible literal text.
function visibleResidue(content) {
    let s = String(content || '');
    for (let i = 0; i < 6; i++) s = s.replace(/\{\{[^{}]*\}\}/g, '');
    return s.trim();
}

// Heuristic default keep/drop + category for one block. The user is the sole
// curator and reviews every row, so these are only the pre-checked defaults.
const SO_DROP_NAME = /(cot|思维链|思考模式|字数|禁词|禁用词|防打断|抢话|杀八股|杀超雄|超雄|杀比拟|杀揭示|杀说明|杀声述|白描|微观|通感|占有|支配|转折词|模型选择|特化|破限|文风|人称|视角|草稿|prism|core|油腻|谄媚|揣测|语气描写|防情绪|防复述|转述|推剧情|极端|全知|反全知|生动化|加强|复述|抗过拟合|抗绝望|抗抢话)/i;
const SO_KEEP_NAME = /(人格|情感|基调|世界|world|角色|故事|设定|主提示|主提示词|lore|背景|场景|情景)/i;

function classifyBlock(block) {
    if (block.marker || MARKER_IDS.has(block.identifier)) {
        return { keep: true, category: 'marker', note: '上下文插槽' };
    }
    const content = block.content || '';
    const role = block.role || 'system';
    const name = block.name || '';
    const residue = visibleResidue(content);
    const setCount = (content.match(/\{\{(setvar|setglobalvar)::/gi) || []).length;
    const hasSet = setCount > 0;
    const hasGet = /\{\{(getvar|getglobalvar)::/i.test(content);
    const hasLastMsg = /\{\{lastusermessage\}\}/i.test(content);
    const dropName = SO_DROP_NAME.test(name);
    const keepName = SO_KEEP_NAME.test(name);

    // Block that's *primarily* an echo of the RP's last user message — wrong for
    // the Oracle. Only when it's short/echo-dominated; a long structural block
    // that merely contains a {{lastusermessage}} slot is handled below.
    if (hasLastMsg && residue.length <= 60) {
        return { keep: false, category: 'user-echo', note: '回显主聊天输入' };
    }

    // Renders to nothing after macro substitution.
    if (!residue) {
        // The master variable initializer (大清洗 / 初始化变量) sets many keys and
        // is required so the kept blocks' getvars resolve. Detect by structure,
        // not name, and keep it.
        if (hasSet && !hasGet && setCount >= 15) {
            return { keep: true, category: 'machinery', note: '变量初始化（隐形・必留）' };
        }
        // Named output/CoT toggles (also implemented as invisible setvars) — drop
        // by default to match the user's expectation, even though harmless to keep.
        if (dropName) return { keep: false, category: 'output', note: '输出 / 思维链 / 反模式（隐形）' };
        if (keepName) return { keep: true, category: 'story', note: '故事 / 世界 / 人格（隐形）' };
        if (hasSet) return { keep: true, category: 'machinery', note: '变量控制（隐形）' };
        if (hasGet) return { keep: true, category: 'wrapper', note: '结构变量（隐形）' };
        return { keep: false, category: 'inert', note: '注释 / 空块' };
    }
    // Voice prefills carried as assistant/user turns — drop regardless of any
    // stray brackets in their text (checked before the wrapper heuristic).
    if (role === 'assistant' || role === 'user') {
        return { keep: false, category: 'prefill', note: `${role} 起手` };
    }
    // Has visible literal text but it's mostly structural tags/banners (short,
    // bracket-heavy) -> a system wrapper around a marker; keep for faithfulness.
    const looksStructural = residue.length <= 120 && /[<>\[\]]/.test(residue);
    if (looksStructural && !dropName) return { keep: true, category: 'wrapper', note: '包裹标签' };

    if (block.identifier === 'main') return { keep: true, category: 'story', note: '主提示' };
    if (dropName) return { keep: false, category: 'output', note: '输出 / 思维链 / 反模式' };
    if (keepName) return { keep: true, category: 'story', note: '故事 / 世界 / 人格' };
    return { keep: true, category: 'review', note: '未分类 · 请确认' };
}

// Build the curation row model for a preset (live read). Markers included.
// Every block in the preset's prompt order becomes a row so the list mirrors
// ST's prompt manager 1:1 — including blocks that are currently DISABLED in the
// order (shown, marked 停用, and unchecked by default) and ones whose content is
// empty (tagged inert) so nothing silently disappears.
function buildCurationRows(name) {
    const preset = getPresetByName(name);
    const ordered = readPresetOrderedBlocks(preset);
    const rows = [];
    for (const { block, enabledInOrder } of ordered) {
        const isMarker = !!block.marker || MARKER_IDS.has(block.identifier);
        const content = block.content || '';
        const c = classifyBlock(block);
        const disabled = enabledInOrder === false;
        rows.push({
            identifier: block.identifier,
            name: (block.name || block.identifier || '').trim(),
            role: block.role || 'system',
            kind: isMarker ? 'marker' : 'text',
            content,
            chars: content.length,
            // A block the preset author turned off defaults to unchecked; the user
            // can still opt it in. Enabled blocks use the classifier default.
            keep: disabled ? false : c.keep,
            disabled,
            category: c.category,
            note: c.note,
        });
    }
    return rows;
}

// Freeze the user's curated selection (kept rows, in their final order).
function snapshotFromRows(rows) {
    const items = rows.filter((r) => r.keep).map((r) => (
        r.kind === 'marker'
            ? { kind: 'marker', identifier: r.identifier, name: r.name }
            : { kind: 'text', identifier: r.identifier, name: r.name, role: r.role, content: r.content }
    ));
    return { items, curatedAt: Date.now() };
}

function getCuratedSnapshot(s, name) {
    const cp = s.curatedPresets;
    return (cp && typeof cp === 'object' && cp[name]) || null;
}

// Is a curated preset the active system-prompt source right now?
function presetCurationActive(s) {
    if (!ENABLE_SYSPROMPT_PRESET || !s.sysPromptPresetName) return false;
    const snap = getCuratedSnapshot(s, s.sysPromptPresetName);
    return !!(snap && Array.isArray(snap.items) && snap.items.length);
}

// The system prompt for the NON-preset (plain textarea) path.
function resolveSystemPrompt(s) {
    return s.systemPrompt;
}

// Look up a system-prompt mode definition (falls back to chat for unknown ids,
// including 'advisor' — not user-editable yet).
function sysPromptModeDef(id) {
    return SYSPROMPT_MODES.find((m) => m.id === id) || SYSPROMPT_MODES[0];
}

// The effective prompt for a mode: the user's override when non-empty, else the
// built-in default. (chat's key always holds text, so the fallback only matters
// for diagnose / lorebook, whose overrides start empty.)
function resolveModePrompt(s, id) {
    const def = sysPromptModeDef(id);
    const v = s[def.key];
    return (typeof v === 'string' && v.trim() !== '') ? v : def.builtin;
}

function populateSysPromptPresets() {
    const wrap = win.querySelector('#so-sysprompt-preset-wrap');
    if (!ENABLE_SYSPROMPT_PRESET) {
        if (wrap) wrap.style.display = 'none';
        const ta = win.querySelector('#so-sysprompt');
        if (ta) ta.disabled = false;   // never leave the textarea locked while dormant
        return;
    }
    if (wrap) wrap.style.display = '';
    const sel = win.querySelector('#so-sysprompt-preset');
    if (!sel) return;
    const s = getSettings();
    const names = getCompletionPresetNames();
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— 自定义（使用下方文本框）—';
    sel.appendChild(none);
    for (const n of names) {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        sel.appendChild(opt);
    }
    // Restore selection only if the saved preset still exists.
    if (s.sysPromptPresetName && names.includes(s.sysPromptPresetName)) {
        sel.value = s.sysPromptPresetName;
    } else {
        if (s.sysPromptPresetName) { s.sysPromptPresetName = ''; save(); }
        sel.value = '';
    }
    applySysPromptModeUiState();
}

function applySysPromptPresetUiState() {
    const s = getSettings();
    const ta = win.querySelector('#so-sysprompt');
    const hint = win.querySelector('#so-sysprompt-preset-hint');
    const recurate = win.querySelector('#so-sysprompt-preset-recurate');
    const active = !!s.sysPromptPresetName;
    // When a preset is selected, the chat textarea (and the built-in short prompt
    // it holds) is fully disabled — no fallback, per design. The textarea is now
    // shared across edit modes, though, so only disable it while CHAT is the mode
    // being edited (a preset only ever replaces the chat prompt).
    if (ta) ta.disabled = active && sysPromptEditMode === 'chat';
    if (recurate) recurate.style.display = active ? '' : 'none';
    if (!hint) return;
    hint.classList.remove('so-hint-error');
    if (!active) {
        const have = getCompletionPresetNames().length;
        hint.textContent = have
            ? '选择一个补全预设并挑选要保留的块；故事神谕会按预设的原始结构（角色卡 / 世界书 / 上下文插槽 + 各块角色）忠实组装。选「自定义」则使用下方文本框。'
            : '未找到已保存的补全预设。请先在 ST 的“预设”里保存一个，然后点刷新。';
        return;
    }
    const snap = getCuratedSnapshot(s, s.sysPromptPresetName);
    if (snap && Array.isArray(snap.items) && snap.items.length) {
        const texts = snap.items.filter((i) => i.kind === 'text').length;
        const slots = snap.items.filter((i) => i.kind === 'marker').length;
        hint.textContent = `正在按预设「${s.sysPromptPresetName}」的忠实结构组装：保留 ${texts} 个文本块 + ${slots} 个上下文插槽。下方文本框（含内置简短提示词）已停用。点[重新挑选]可修改。`;
    } else {
        hint.textContent = `预设「${s.sysPromptPresetName}」尚未挑选内容。点[重新挑选]开始，或重新从下拉中选择以打开挑选界面。`;
        hint.classList.add('so-hint-error');
    }
}

// Point the shared system-prompt textarea at the currently-selected edit mode
// and refresh the surrounding UI state.
function loadSysPromptForMode() {
    const s = getSettings();
    const ta = win.querySelector('#so-sysprompt');
    if (!ta) return;
    const def = sysPromptModeDef(sysPromptEditMode);
    // chat shows its stored text verbatim (may be blank by the user's choice);
    // diagnose / lorebook show the override, or the built-in when not customized.
    ta.value = (def.id === 'chat') ? s.systemPrompt : resolveModePrompt(s, def.id);
    applySysPromptModeUiState();
}

// Coordinate the system-prompt UI for the selected edit mode. The preset-source
// row only applies to chat (a curated preset replaces the chat textarea); for
// diagnose / lorebook it's hidden, the textarea is always editable, and a hint
// explains the override-vs-built-in state.
function applySysPromptModeUiState() {
    const def = sysPromptModeDef(sysPromptEditMode);
    const presetWrap = win.querySelector('#so-sysprompt-preset-wrap');
    const ta = win.querySelector('#so-sysprompt');
    const hint = win.querySelector('#so-sysprompt-which-hint');
    if (def.id === 'chat') {
        if (presetWrap && ENABLE_SYSPROMPT_PRESET) presetWrap.style.display = '';
        applySysPromptPresetUiState();   // disables the textarea if a preset is active
        if (hint) { hint.textContent = ''; hint.classList.remove('so-hint-error'); }
        return;
    }
    if (presetWrap) presetWrap.style.display = 'none';   // presets don't replace these prompts
    if (ta) ta.disabled = false;
    if (hint) {
        const s = getSettings();
        const customized = typeof s[def.key] === 'string' && s[def.key].trim() !== '';
        hint.classList.remove('so-hint-error');
        hint.textContent = customized
            ? `已自定义「${def.label}」的系统提示词。点 [↺ 重置为默认] 可恢复内置版本。`
            : `这是「${def.label}」的内置系统提示词，可直接修改。未修改时会随扩展更新自动改进；改后点 [↺ 重置为默认] 恢复。`;
    }
}

// Dropdown change: gate curation. Empty -> custom/textarea. Already-curated ->
// use it. New -> open the checklist; commit only when the user saves.
function onPresetSelected(rawName) {
    const s = getSettings();
    const name = rawName || '';
    if (!name) {
        s.sysPromptPresetName = '';
        save();
        applySysPromptPresetUiState();
        updateBadge();
        return;
    }
    if (getCuratedSnapshot(s, name)) {
        s.sysPromptPresetName = name;
        save();
        applySysPromptPresetUiState();
        updateBadge();
        return;
    }
    // Not curated yet — open the checklist. Revert the dropdown to the committed
    // value until the user actually saves a curation.
    const sel = win.querySelector('#so-sysprompt-preset');
    if (sel) sel.value = s.sysPromptPresetName || '';
    openCuration(name);
}

/* ------------------------------------------------------------------ *
 * Curation modal — the user is the sole curator (no LLM step).
 * Lists the preset's enabled blocks + context-slot markers in preset order,
 * pre-checked by a name/role/structure classifier, draggable to reorder.
 * Saving freezes the kept rows (in their final order) into curatedPresets.
 * ------------------------------------------------------------------ */
let curationState = null;

const CUR_TAG_LABEL = {
    marker: '插槽', story: '故事', machinery: '变量机制', wrapper: '包裹',
    output: '输出/COT', prefill: '起手', 'user-echo': '回显输入',
    inert: '注释/空', review: '待确认',
};

function openCuration(name, seedRows) {
    const rows = seedRows || buildCurationRows(name);
    if (!rows.length) {
        addSystemNote(`预设「${name}」没有可挑选的已启用块。请检查它在 ST 里是否配置正确。`);
        return;
    }
    curationState = { name, rows, dragFrom: -1 };

    let modal = win.querySelector('#so-curate');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'so-curate';
        win.appendChild(modal);
    }
    modal.innerHTML = `
        <div id="so-cur-card">
            <div id="so-cur-head">
                <div id="so-cur-title"><i class="fa-solid fa-list-check"></i> 挑选要保留的块</div>
                <div class="so-iconbtn" id="so-cur-x" title="取消"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div id="so-cur-sub"></div>
            <div id="so-cur-list"></div>
            <div id="so-cur-foot">
                <div id="so-cur-count"></div>
                <div id="so-cur-foot-btns">
                    <button class="so-cur-btn" id="so-cur-reset">重置默认</button>
                    <button class="so-cur-btn" id="so-cur-cancel">取消</button>
                    <button class="so-cur-btn so-cur-save" id="so-cur-save">保存并使用</button>
                </div>
            </div>
        </div>`;
    modal.querySelector('#so-cur-sub').textContent =
        `预设「${name}」 — 列出预设里的全部块（含预设已停用的，标「预设已停用」、默认不勾选）。勾选的块会按下方顺序忠实组装；插槽（角色卡 / 世界书 / 用户人设 / 上下文）会就地填入神谕的上下文。拖动可调整顺序。`;

    // One-time heads-up about the output-regex / preset-mismatch caveat.
    maybeShowCurationWarning(modal, name);

    // Critical layout applied inline so the modal is contained, opaque, and
    // scrollable even if the stylesheet is stale/cached (the .so-cur-* theme
    // rules still enhance it once style.css refreshes).
    applyCurationChrome(modal);

    modal.querySelector('#so-cur-x').addEventListener('click', closeCuration);
    modal.querySelector('#so-cur-cancel').addEventListener('click', closeCuration);
    modal.querySelector('#so-cur-reset').addEventListener('click', () => {
        curationState.rows = buildCurationRows(name); // re-seed from classifier
        renderCurationRows();
    });
    modal.querySelector('#so-cur-save').addEventListener('click', saveCuration);

    modal.classList.add('open');
    modal.style.display = 'flex';
    renderCurationRows();
}

// Guarantee the modal's structure inline, independent of the external stylesheet.
function applyCurationChrome(modal) {
    const set = (sel, css) => { const el = modal.querySelector(sel); if (el) el.style.cssText += ';' + css; };
    modal.style.cssText +=
        ';position:absolute;inset:0;top:0;left:0;right:0;bottom:0;z-index:50;' +
        'align-items:center;justify-content:center;padding:12px;box-sizing:border-box;' +
        'background:rgba(8,9,12,0.84);';
    set('#so-cur-card',
        'position:relative;top:auto;left:auto;right:auto;bottom:auto;transform:none;' +
        'display:flex;flex-direction:column;width:100%;max-width:560px;' +
        'height:100%;max-height:100%;min-height:0;box-sizing:border-box;overflow:hidden;' +
        'border-radius:12px;background:#1b1d23;border:1px solid rgba(255,255,255,0.18);' +
        'box-shadow:0 20px 50px -12px rgba(0,0,0,0.7);');
    set('#so-cur-head',
        'flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;' +
        'padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.12);');
    set('#so-cur-sub', 'flex:0 0 auto;padding:10px 14px 4px;font-size:0.8em;opacity:0.65;line-height:1.5;');
    set('#so-cur-list', 'flex:1 1 0;min-height:0;overflow-y:auto;padding:6px;');
    set('#so-cur-foot',
        'flex:0 0 auto;display:flex;align-items:center;gap:10px;' +
        'padding:10px 14px;border-top:1px solid rgba(255,255,255,0.12);');
    set('#so-cur-count', 'flex:1 1 auto;font-size:0.8em;opacity:0.8;');
    set('#so-cur-foot-btns', 'display:flex;gap:6px;flex:0 0 auto;');
}

// One-time warning: the Oracle assembles from (and regex-cleans for) the preset
// curated HERE; if that differs from the main-chat preset the enabled regex is
// tuned to, the cleanup may not match the Oracle's output.
function maybeShowCurationWarning(modal, name) {
    const s = getSettings();
    if (s.curationWarned) return;
    const card = modal.querySelector('#so-cur-card');
    const list = modal.querySelector('#so-cur-list');
    if (!card || !list) return;

    const mainName = getActiveMainPresetName();
    let tail = '';
    if (mainName && mainName === name) tail = '（当前与主聊天预设一致 ✓）';
    else if (mainName) tail = `（主聊天当前预设：「${escapeHtml(mainName)}」，与此不同 —— 正则很可能对不上）`;

    const warn = document.createElement('div');
    warn.id = 'so-cur-warn';
    warn.style.cssText =
        'flex:0 0 auto;margin:8px 14px 2px;padding:9px 11px;border-radius:8px;' +
        'font-size:0.78em;line-height:1.55;color:#f0d28a;' +
        'background:rgba(242,201,76,0.12);border:1px solid rgba(242,201,76,0.35);';
    warn.innerHTML =
        '⚠️ 选用预设时，神谕会用<b>你在这里挑选的这个预设</b>来组装提示词，并用你启用的正则清理它的回复。' +
        '这些正则是按<b>主聊天的输出格式</b>写的——如果这里挑选的预设和主聊天当前启用的预设不一样，' +
        `正则可能匹配不上神谕的输出、清理不会生效。${tail}`;
    card.insertBefore(warn, list);

    s.curationWarned = true;
    save();
}

function closeCuration() {
    const modal = win.querySelector('#so-curate');
    if (modal) { modal.classList.remove('open'); modal.style.display = 'none'; }
    curationState = null;
}

function renderCurationRows() {
    const list = win.querySelector('#so-cur-list');
    if (!list || !curationState) return;
    list.innerHTML = '';
    curationState.rows.forEach((r, idx) => {
        const row = document.createElement('div');
        row.className = 'so-cur-row' + (r.keep ? '' : ' so-cur-off') + (r.kind === 'marker' ? ' so-cur-marker' : '');
        row.draggable = true;
        row.dataset.idx = String(idx);

        const handle = `<span class="so-cur-handle" title="拖动排序"><i class="fa-solid fa-grip-vertical"></i></span>`;
        const cb = `<input type="checkbox" class="so-cur-cb" ${r.keep ? 'checked' : ''}>`;
        const roleBadge = (r.role && r.role !== 'system')
            ? `<span class="so-cur-role">${r.role}</span>` : '';
        const disabledBadge = r.disabled
            ? `<span class="so-cur-disabled" style="flex:0 0 auto;font-size:0.74em;padding:1px 6px;border-radius:6px;background:rgba(224,124,124,0.22);color:#e89a9a;white-space:nowrap;">预设已停用</span>`
            : '';
        const tag = `<span class="so-cur-tag so-cur-tag-${r.category}">${CUR_TAG_LABEL[r.category] || r.category}</span>`;
        const chars = r.kind === 'marker' ? '插槽' : `${r.chars} 字`;
        row.innerHTML =
            `${handle}${cb}<span class="so-cur-name" title="${escapeAttr(r.name)}">${escapeHtml(r.name)}</span>` +
            `${disabledBadge}${roleBadge}${tag}<span class="so-cur-chars">${chars}</span>`;

        // Inline layout so rows stay readable even if the stylesheet is stale.
        row.style.cssText +=
            ';display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;' +
            'border:1px solid transparent;' + (r.keep ? '' : 'opacity:0.5;');
        const nameEl = row.querySelector('.so-cur-name');
        if (nameEl) nameEl.style.cssText += ';flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const charsEl = row.querySelector('.so-cur-chars');
        if (charsEl) charsEl.style.cssText += ';flex:0 0 auto;font-size:0.78em;opacity:0.5;';
        const cbEl0 = row.querySelector('.so-cur-cb');
        if (cbEl0) cbEl0.style.cssText += ';flex:0 0 auto;width:15px;height:15px;cursor:pointer;';
        row.querySelector('.so-cur-cb').addEventListener('change', (e) => {
            curationState.rows[idx].keep = e.target.checked;
            row.classList.toggle('so-cur-off', !e.target.checked);
            row.style.opacity = e.target.checked ? '' : '0.5';
            updateCurationCount();
        });
        row.addEventListener('dragstart', () => { curationState.dragFrom = idx; row.classList.add('so-cur-drag'); });
        row.addEventListener('dragend', () => { row.classList.remove('so-cur-drag'); });
        row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('so-cur-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('so-cur-over'));
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('so-cur-over');
            const from = curationState.dragFrom;
            const to = idx;
            if (from < 0 || from === to) return;
            const arr = curationState.rows;
            const [moved] = arr.splice(from, 1);
            arr.splice(to, 0, moved);
            curationState.dragFrom = -1;
            renderCurationRows();
        });

        list.appendChild(row);
    });
    updateCurationCount();
}

function updateCurationCount() {
    const el = win.querySelector('#so-cur-count');
    if (!el || !curationState) return;
    const kept = curationState.rows.filter((r) => r.keep);
    const texts = kept.filter((r) => r.kind === 'text');
    const slots = kept.filter((r) => r.kind === 'marker');
    const chars = texts.reduce((n, r) => n + (r.chars || 0), 0);
    el.innerHTML = `保留 <b>${texts.length}</b> 块 + <b>${slots.length}</b> 插槽 · 约 <b>${chars.toLocaleString()}</b> 字`;
}

function saveCuration() {
    if (!curationState) return;
    const { name, rows } = curationState;
    const snap = snapshotFromRows(rows);
    if (!snap.items.length) {
        addSystemNote('至少要保留一个块。请勾选后再保存。');
        return;
    }
    const s = getSettings();
    if (!s.curatedPresets || typeof s.curatedPresets !== 'object') s.curatedPresets = {};
    s.curatedPresets[name] = snap;
    s.sysPromptPresetName = name;
    save();
    closeCuration();
    const sel = win.querySelector('#so-sysprompt-preset');
    if (sel) sel.value = name;
    applySysPromptPresetUiState();
    updateBadge();
}

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
}
function escapeAttr(str) { return escapeHtml(str); }

/* ------------------------------------------------------------------ *
 * Show / hide
 * ------------------------------------------------------------------ */
function toggleWindow(show) {
    if (!win) return;
    const visible = win.style.display !== 'none';
    const next = (show === undefined) ? !visible : show;
    win.style.display = next ? 'flex' : 'none';
    if (next) {
        // Re-trigger the open animation each time the window is shown.
        win.classList.remove('so-opening');
        void win.offsetWidth; // force reflow so the animation restarts
        win.classList.add('so-opening');
        ensureWindowInView();   // 每次开窗都把窗口夹回可见区——卡在屏外的窗口下次打开即自愈
        // 手机上别自动聚焦输入框：会弹出软键盘、压缩可见视口，把 position:fixed 的标题栏（含 ✕）挤出屏外。
        // 桌面保留自动聚焦；手机用户自己点输入框时，上面注册的 visualViewport 监听会再夹一次、护住标题栏。
        if (window.innerWidth >= 600) inputEl.focus();
        checkPlanReminder(); // natural opportunity for the 20-message staleness ping
    }
    placePlanBar(); // strip moves home (window) or out (float) with visibility
}

/* ------------------------------------------------------------------ *
 * 模式切换。四种互斥模式：chat / diagnose / lorebook / advisor。
 * setOracleMode 是唯一的写入口（booleans、CSS 类、按钮高亮、输入框占位符
 * 都在这里统一处理）——各 toggle 只负责自己的进入/退出提示。
 * ------------------------------------------------------------------ */
const MODE_PLACEHOLDERS = {
    chat: '就当前剧情提问…（Enter 发送，Shift+Enter 换行）',
    diagnose: '描述哪里看起来不对，或让我检查最新一次更新 / 审计当前状态…',
    lorebook: '问问这本世界书，或让我改写 / 新增 / 删除某个条目…',
    advisor: '聊聊剧情接下来可以怎么走…（出方案后可一键开始引导）',
    fix: '想怎么改最新这条回复都行——重写、删改、换语气、调节奏、改设定…说出来，我来改一版…',
};

// 各模式的空状态：模式图标 + 引导语 +（可选）副标题 + 示例 chip。点一下 chip 把问题填进输入框
// 并聚焦，回车即发，由该模式的发送管线处理。与 MODE_PLACEHOLDERS 并列维护。用户选择方案 A：
// 侧聊为空时它取代进入提示（modeEntryNote 此时跳过那段说明，避免与引导语 + chip 叠加重复）。
const MODE_EMPTY = {
    chat: {
        icon: 'fa-moon',
        lead: '关于当前剧情，尽管问吧。',
        sub: '此窗口与主聊天相互独立。',
        chips: ['接下来可能会发生什么？', '这个角色现在的处境如何？', '帮我理一下当前的剧情线。'],
    },
    diagnose: {
        icon: 'fa-stethoscope',
        lead: '检查并修复 MVU 变量状态。',
        chips: ['检查最新一条回复有没有问题。', '审计一下当前的整个状态。'],
    },
    lorebook: {
        icon: 'fa-book',
        lead: '聊聊或修改这本世界书。',
        chips: ['这本世界书都写了些什么？', '帮我新增一个条目。', '找找条目之间有没有矛盾。'],
    },
    advisor: {
        icon: 'fa-compass',
        lead: '一起构思剧情接下来怎么走。',
        chips: ['接下来剧情可以怎么走？给我几个方向。', '基于现在的局势，提一个值得推进的转折。'],
    },
    // icon 是 Font Awesome 类名（renderEmptyState 拼成 `fa-solid ${icon}`），与上面各模式一致——
    // 用与校正按钮同款的 fa-wand-magic-sparkles（不是 emoji，emoji 拼进 class 会渲染空白）。
    fix: {
        icon: 'fa-wand-magic-sparkles',
        lead: '手动：在下方输入框直接说要改哪里，只改这一条回复（快、单稿）。<br>自动：每条新回复后台自动清 AI 味——「校正设置」切到「自动」、开「自动校正每条新回复」。',
        sub: '校正只去 AI 腔 / 收紧读感——不翻译、不改设定、不算数值、不修卡片本身的问题。',
        chips: ['这个角色不该知道这件事，重写他的对话', '这个事件的日期不对，回看上下文改正', '这个角色的台词太机械，重写得更像真人', '扩写这一段，补充更多剧情细节'],
    },
};

function currentOracleMode() {
    return diagnoseMode ? 'diagnose' : (lorebookMode ? 'lorebook' : (advisorMode ? 'advisor' : (fixMode ? 'fix' : 'chat')));
}

function modeReturnNote(mode) {
    if (mode === 'diagnose') return '已返回诊断模式。';
    if (mode === 'advisor') return '已返回剧情参谋模式。';
    if (mode === 'fix') return '已返回校正模式。';
    if (mode === 'lorebook') return '已返回世界书模式。';
    return '已返回普通聊天模式。';
}

function setOracleMode(target) {
    diagnoseMode = target === 'diagnose';
    lorebookMode = target === 'lorebook';
    advisorMode = target === 'advisor';
    fixMode = target === 'fix';
    win.classList.toggle('so-diag-on', diagnoseMode);
    win.classList.toggle('so-lb-on', lorebookMode);
    win.classList.toggle('so-adv-on', advisorMode);
    win.classList.toggle('so-fix-on', fixMode);
    win.querySelector('#so-diagnose-btn').classList.toggle('so-diag-active', diagnoseMode);
    win.querySelector('#so-lorebook-btn').classList.toggle('so-lb-active', lorebookMode);
    win.querySelector('#so-advisor-btn').classList.toggle('so-adv-active', advisorMode);
    win.querySelector('#so-fix-btn').classList.toggle('so-fix-active', fixMode);
    inputEl.placeholder = MODE_PLACEHOLDERS[target] || MODE_PLACEHOLDERS.chat;
    if (ENABLE_DIAG_WI_PICKER) refreshDiagPickerUI();   // 诊断「精选条目」栏随模式刷新（用户功能请求）
    // 空侧聊时切换模式要刷新空状态（每模式自带一组引导语 + 示例 chip）；有内容则保留现有记录不动。
    if (messagesEl && !convo.length) { messagesEl.innerHTML = ''; renderEmptyState(); }
    updateDiagButtonVisual();   // 诊断按钮（含红色 AUTO）状态随模式切换始终对齐（含从子模式回到诊断时）
    updateFixButtonVisual();    // ✨ 校正按钮：自动校正开启时图标染金（随模式切换对齐）
}

// 用户功能请求：诊断按钮三态循环 —— 关 → 诊断 → 诊断·自动(AUTO) → 关。两个纯函数便于单测：
//   diagButtonState 由当前 (diagnoseMode, autoDiagnoseEnabled) 推出按钮态；nextDiagState 给下一态。
function diagButtonState(diagOn, autoOn) {
    return autoOn ? 'auto' : (diagOn ? 'diagnose' : 'off');
}
function nextDiagState(state) {
    return state === 'off' ? 'diagnose' : (state === 'diagnose' ? 'auto' : 'off');
}
// 纯判定：自动诊断已武装、但当前不在诊断视图（从 ⋯「普通聊天」或子模式过来）时，诊断控件应先【回到
// 诊断视图】（保持自动武装），而不是推进三态循环 → 否则离开诊断视图后再无返回入口（用户报告的死胡同 bug）。
function diagShouldReveal(diagOn, autoOn) {
    return autoOn && !diagOn;
}

// 诊断按钮点击：算出下一态；进入 auto 且还没看过警告时，先弹一次性警告（确认后才真正开启）。
function toggleDiagnose() {
    const s = getSettings();
    // 杀死开关关闭：退回原始两态（关 ↔ 诊断），AUTO 不可达；顺手清掉历史残留的开启态。
    if (!ENABLE_AUTO_DIAGNOSE) {
        const entering = !diagnoseMode;
        if (s.autoDiagnoseEnabled) { s.autoDiagnoseEnabled = false; save(); }
        setOracleMode(entering ? 'diagnose' : 'chat');
        modeEntryNote(entering
            ? '诊断模式已开启。我会把最新一条 AI 回复中的变量更新，对照本角色卡的 MVU 规则与当前状态进行检查，然后给出一份你可以一键应用的纠正补丁。可以让我检查它、指出哪里看起来不对，或者直接说“审计整个状态”。'
            : '已返回普通聊天模式。');
        updateDiagButtonVisual();
        if (inputEl) inputEl.focus();
        return;
    }
    // 修复死胡同：自动诊断武装、但当前不在诊断视图（从 ⋯「普通聊天」或子模式过来）→ 点诊断按钮先回到诊断
    // 视图（保持自动武装），而非按三态循环掉到「关」。再点一次（此时已在诊断视图）才走循环关掉自动。
    if (diagShouldReveal(diagnoseMode, !!s.autoDiagnoseEnabled)) {
        setOracleMode('diagnose');
        if (inputEl) inputEl.focus();
        return;
    }
    const next = nextDiagState(diagButtonState(diagnoseMode, !!s.autoDiagnoseEnabled));
    if (next === 'auto' && !s.autoDiagnoseWarned) { openAutoDiagWarn(); return; }
    applyDiagButtonState(next);
}

// 把按钮态落到：窗口模式 + 持久化的 autoDiagnoseEnabled + 视觉 + 一条说明。
function applyDiagButtonState(state) {
    const s = getSettings();
    if (state === 'off') {
        s.autoDiagnoseEnabled = false; save();
        setOracleMode('chat');
        modeEntryNote('已关闭诊断 / 自动诊断，返回普通聊天模式。');
    } else if (state === 'diagnose') {
        s.autoDiagnoseEnabled = false; save();
        setOracleMode('diagnose');
        modeEntryNote('诊断模式已开启。我会把最新一条 AI 回复中的变量更新，对照本角色卡的 MVU 规则与当前状态进行检查，然后给出一份你可以一键应用的纠正补丁。可以让我检查它、指出哪里看起来不对，或者直接说“审计整个状态”。再点一次诊断按钮即可开启【自动模式】。');
    } else { // auto
        s.autoDiagnoseEnabled = true; save();
        setOracleMode('diagnose');
        modeEntryNote('🔴 自动诊断模式已开启。此后每当主聊天收到新的 AI 回复，我都会在后台自动检查其中的 MVU 变量更新，发现问题就【自动应用修复】（每次都会弹出一个可撤销的提示）。窗口关着也照常工作。再点一次诊断按钮即可关闭。');
    }
    updateDiagButtonVisual();
    if (inputEl) inputEl.focus();
}

// 诊断按钮视觉：自动开启时图标变红 + 显示 AUTO 标签（覆盖普通诊断的蓝色高亮）。init 与每次切换后调用。
function updateDiagButtonVisual() {
    if (!win) return;
    const btn = win.querySelector('#so-diagnose-btn');
    if (!btn) return;
    const auto = ENABLE_AUTO_DIAGNOSE && !!getSettings().autoDiagnoseEnabled;
    btn.classList.toggle('so-diag-auto', auto);
    win.classList.toggle('so-diag-auto-on', auto);
    btn.title = auto
        ? '诊断 · 自动模式开启 —— 每条新回复都会自动检查并修复 MVU（再点一次关闭）'
        : '诊断模式 —— 修复 MVU 状态变量（再点一次开启自动模式）';
}

// 校正按钮视觉（用户功能请求）：自动校正开启时把 ✨ 图标染金，作为「小指示」。读【本聊天生效】的 autoFixEnabled
// （getEffectiveFixCfg，与 maybePostReply 同源），所以指示永远跟「实际会不会自动校正」一致。init / 切模式 / 改开关 /
// 换聊天后调用对齐（与 updateDiagButtonVisual 同款 win 守卫）。
function updateFixButtonVisual() {
    if (!win) return;
    const btn = win.querySelector('#so-fix-btn');
    if (!btn) return;
    const auto = ENABLE_REPLY_FIX && !!getEffectiveFixCfg(getSettings(), getFixCfg()).autoFixEnabled;
    btn.classList.toggle('so-fix-auto', auto);
    btn.title = auto
        ? '校正模式 · 自动校正已开启（金色）—— 每条新回复都会自动校正（在校正模式设置里关闭）'
        : '校正模式 —— 修一修最新这条回复（AI 味 / 对话 / 设定 / 详略…），应用后原文仍在';
}

// 首次开启自动模式前的一次性警告弹窗（含「不再提示」+ 与 MVU「额外模型解析」不兼容的提醒）。
function openAutoDiagWarn() {
    if (!win) return;
    const never = win.querySelector('#so-autowarn-never');
    if (never) never.checked = false;
    const modal = win.querySelector('#so-autowarn');
    if (modal) modal.classList.add('open');
}

// ✨ 校正：首次切到「自动校正」时弹的一次性提醒（标签块 <sceneinfo>/<details> 的留存要靠排除区·保留——写起始标记即可）。
// 与 openAutoDiagWarn 同款：纯展示弹窗，「知道了」关闭、勾「不再提示」则置 autoFixWarned。仅在 !autoFixWarned 时由切到自动的处理器调起。
function openAutoFixWarn() {
    if (!win) return;
    const never = win.querySelector('#so-fixwarn-never');
    if (never) never.checked = false;
    const modal = win.querySelector('#so-fixwarn');
    if (modal) modal.classList.add('open');
}

function toggleLorebook() {
    if (lorebookMode) {
        const back = priorOracleMode || 'chat';
        priorOracleMode = 'chat';
        setOracleMode(back);
        modeEntryNote(modeReturnNote(back));
        inputEl.focus();
        return;
    }
    priorOracleMode = currentOracleMode();
    setOracleMode('lorebook');
    populateLorebookBooks();
    modeEntryNote('世界书模式已开启。我已读取选定世界书的全部条目——你可以问里面写了什么、找矛盾、聊扩写思路；也可以让我改写、新增或删除条目，我会给出一份你能一键应用（并可撤销）的改动。上方可切换要处理哪一本。');
    inputEl.focus();
}

// 校正模式按钮：进入 / 退出（普通两态，无 AUTO）。杀死开关关闭时 no-op（不可进入）。
function toggleFix() {
    if (!ENABLE_REPLY_FIX) return;
    if (fixMode) {
        const back = priorOracleMode || 'chat';
        priorOracleMode = 'chat';
        setOracleMode(back);
        modeEntryNote(modeReturnNote(back));
        if (inputEl) inputEl.focus();
        return;
    }
    priorOracleMode = currentOracleMode();
    setOracleMode('fix');
    modeEntryNote('校正模式已开启。我会读取最新一条 AI 回复，按你说的把它改一版——你想怎么改都行：重写某段、改语气、调节奏、删减、改掉某个设定或不合适的描写……任何要求都可以。直接说你想改什么，我给出一份可一键应用的校正稿（应用后原文仍在，左滑即可看回）。');
    if (inputEl) inputEl.focus();
}

function toggleAdvisor() {
    if (advisorMode) {
        const back = priorOracleMode || 'chat';
        priorOracleMode = 'chat';
        setOracleMode(back);
        modeEntryNote(modeReturnNote(back));
        inputEl.focus();
        return;
    }
    priorOracleMode = currentOracleMode();
    setOracleMode('advisor');
    modeEntryNote('剧情参谋模式已开启。我会通读整段对话，和你一起构思剧情接下来可以怎么走。讨论出具体方案后，我会把它列成卡片——点「开始引导」并选择强度（只铺垫 / 自然推进 / 尽快引爆），主聊天的 AI 就会被悄悄引导着把剧情推向那个方向。引导随时可在上方的方案条里查看、调整或停止。'
        + (getPlan() ? '\n当前已有一个方案在引导中——可以问我「检查进度」。' : ''));
    if (convoForPrompt().length > 0 && !getPlan()) addBridgeChip();
    inputEl.focus();
}

// One-tap chip: fills the input with the canned formalize request and sends it.
// The advisor sees the whole prior side-chat (convo is shared across modes), so
// it can turn an informal discussion into adoptable <StoryPlan> cards.
function addBridgeChip() {
    const wrap = document.createElement('div');
    wrap.className = 'so-note so-bridge';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'so-bridge-chip';
    btn.innerHTML = '<i class="fa-solid fa-compass"></i> 把刚才的讨论整理成方案';
    btn.addEventListener('click', () => {
        if (isGenerating) return;
        wrap.remove();
        inputEl.value = '把我们刚才讨论的剧情走向，整理成可以采用的方案吧。';
        onSend();
    });
    wrap.appendChild(btn);
    messagesEl.appendChild(wrap);
    scrollToBottom();
}

/* ------------------------------------------------------------------ *
 * 方案条（active plan strip）。只要当前聊天存在已采用的方案就显示——
 * 不论神谕处于哪个模式，因为引导作用的是主聊天，必须显眼到没法被遗忘。
 *
 * v1.14.3：同一个方案条元素在两个家之间【搬家】（reparent），绝不复制——
 * 神谕窗口打开时住在窗口顶部；窗口关闭而方案仍在引导时，搬进一个独立的
 * 可拖动悬浮容器，常驻在 ST 界面上。单一 DOM 节点 = 单一真相：强度按钮、
 * 展开器、完成/放弃在两处都是同一批监听器，无需任何同步。
 * ------------------------------------------------------------------ */
function renderPlanBar() {
    if (!planBarEl) return;
    const active = getActiveConstruct();
    if (win) win.classList.toggle('so-plan-on', !!active);
    const pre = planBarEl.querySelector('#so-plan-directive');
    if (!active) {
        pre.classList.remove('open');
        planBarEl.querySelector('#so-plan-show').textContent = '▸ 查看注入内容';
        placePlanBar();
        return;
    }
    const isArc = active.type === 'arc';
    const isBlind = isArc && active.arc.mode === 'blind';
    const isTransparent = isArc && !isBlind;
    // Toggle button families by construct type: single-shot (完成/放弃) ·
    // transparent arc (完成/换个思路) · blind arc (✓达成/✗失败/🚫换个目标).
    // 退出 and ↻重试 are shared by both arc kinds.
    planBarSetDisplay('#so-plan-progress', isArc);
    planBarSetDisplay('#so-plan-done', !isArc);
    planBarSetDisplay('#so-plan-drop', !isArc);
    planBarSetDisplay('#so-arc-complete', isTransparent);
    planBarSetDisplay('#so-arc-reroll', isTransparent);
    planBarSetDisplay('#so-arc-achieved', isBlind);
    planBarSetDisplay('#so-arc-failed', isBlind);
    planBarSetDisplay('#so-arc-reject', isBlind);
    planBarSetDisplay('#so-arc-exit', isArc);
    planBarSetDisplay('#so-arc-retry', isArc && !!arcRetryPending);   // shown only after a compile failure
    if (isArc) renderArcBarBody(active.arc);
    else renderSinglePlanBody(active.plan);
    if (pre.classList.contains('open')) pre.textContent = currentInjectionPreview();
    placePlanBar();
}

// Toggle an element inside the strip (queried via planBarEl — it may be reparented
// into the float). A missing element is a no-op.
function planBarSetDisplay(sel, on) {
    const el = planBarEl.querySelector(sel);
    if (el) el.style.display = on ? '' : 'none';
}

// Rebuild the intensity segmented control, wiring each button to onPick(key).
// label IS the compressed directive; the caption underneath is its one-line expansion.
function renderIntensitySegments(current, onPick) {
    const seg = planBarEl.querySelector('#so-plan-intensity');
    seg.innerHTML = '';
    for (const [key, I] of Object.entries(ADVISOR_INTENSITIES)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'so-plan-int' + (current === key ? ' active' : '');
        b.textContent = I.label;
        b.addEventListener('click', () => onPick(key));
        seg.appendChild(b);
    }
}

// Single-shot plan body. Also resets the shared arc-only widgets (difficulty badge,
// intensity segments, directive spoiler) in case a blind arc previously left them toggled.
function renderSinglePlanBody(plan) {
    planBarEl.querySelector('#so-plan-label').textContent = '引导中';
    planBarEl.querySelector('#so-arc-diff-badge').style.display = 'none';
    planBarEl.querySelector('#so-plan-intensity').style.display = '';
    planBarEl.querySelector('#so-arc-shaping').style.display = 'none';   // arc-only (layer 6)
    const pre = planBarEl.querySelector('#so-plan-directive');
    pre.classList.remove('so-spoiler', 'peek');
    pre.title = '';
    planBarEl.querySelector('#so-plan-goal').textContent = plan.title ? `${plan.title}：${plan.goal}` : plan.goal;
    renderIntensitySegments(plan.intensity, setPlanIntensity);
    const I = ADVISOR_INTENSITIES[plan.intensity] || ADVISOR_INTENSITIES.normal;
    planBarEl.querySelector('#so-plan-caption').textContent = I.caption;
}

// Arc body. Transparent: waypoint intent + beat goal + per-beat intensity segments.
// Blind: player-facing OBJECTIVE (never the goal) + difficulty badge/caption, no
// intensity (blind uses arc-level difficulty), and the waypoint intent is withheld from
// the progress line — only 路标 n/m + 贯穿线 show, so the bar can't telegraph the current
// beat's subject. The directive viewer (which holds the goal) is blurred — soft secrecy.
function renderArcBarBody(arc) {
    const beat = arc.currentBeat;
    const blind = arc.mode === 'blind';
    const total = arc.waypoints.length;
    const idx = Math.min(arc.cursor + 1, total);
    const wp = arcActiveWaypoint(arc);
    const badge = planBarEl.querySelector('#so-arc-diff-badge');
    const seg = planBarEl.querySelector('#so-plan-intensity');
    const pre = planBarEl.querySelector('#so-plan-directive');
    planBarEl.querySelector('#so-plan-label').textContent = blind ? '盲盒引导' : '弧线引导';
    planBarEl.querySelector('#so-plan-progress').textContent =
        `路标 ${idx}/${total}` + (!blind && wp ? `　·　${wp.intent}` : '')
        + (arc.throughline ? `　·　贯穿线：${arc.throughline}` : '');

    if (blind) {
        // Show the task, not the scheme. stage B → objectiveB (a more direct follow-up).
        const task = beat ? arcVisibleObjective(beat) : '';
        const stageB = !!(beat && beat.stage === 'B');
        planBarEl.querySelector('#so-plan-goal').textContent =
            beat ? (task || '（任务待明确——可点「🚫 换个目标」重编）') : '';
        seg.style.display = 'none';
        const diffKey = (arc.consent && arc.consent.difficulty) || 'normal';
        const D = ADVISOR_DIFFICULTIES[diffKey] || ADVISOR_DIFFICULTIES.normal;
        badge.textContent = D.label;
        badge.title = D.caption;
        badge.dataset.difficulty = diffKey;
        badge.style.display = '';
        planBarEl.querySelector('#so-plan-caption').textContent =
            (stageB ? '盲盒 · 延伸任务（上一步还差一口气） · ' : '盲盒 · ') + D.caption;
        pre.classList.add('so-spoiler');
        pre.classList.remove('peek');            // re-mask on every state change (new secret)
        pre.title = '点击查看隐藏指令（含剧透）';
    } else {
        planBarEl.querySelector('#so-plan-goal').textContent = beat ? beat.goal : '';
        badge.style.display = 'none';
        seg.style.display = '';
        renderIntensitySegments(beat ? beat.intensity : 'normal', arcSetActiveIntensity);
        const I = ADVISOR_INTENSITIES[(beat && beat.intensity)] || ADVISOR_INTENSITIES.normal;
        planBarEl.querySelector('#so-plan-caption').textContent = I.caption;
        pre.classList.remove('so-spoiler', 'peek');
        pre.title = '';
    }
    renderArcShaping(arc);   // 弧线节奏控件（两种弧线都显示，layer 6）
}

// Rebuild the arc-shaping segmented control (自动 / 还想继续 / 开始收束). Shown for both arc
// kinds; reflects arc.shaping (null = 自动). Picking sets the soft pacing intent for future beats.
function renderArcShaping(arc) {
    const row = planBarEl.querySelector('#so-arc-shaping');
    const seg = planBarEl.querySelector('#so-arc-shaping-seg');
    if (!row || !seg) return;
    row.style.display = '';
    seg.innerHTML = '';
    const cur = arc.shaping || '';
    const opts = [['', '自动塑形'], ...Object.entries(ADVISOR_SHAPING).map(([k, v]) => [k, v.label])];
    for (const [key, label] of opts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'so-plan-int' + (cur === key ? ' active' : '');
        b.textContent = label;
        b.addEventListener('click', () => arcSetActiveShaping(key || null));
        seg.appendChild(b);
    }
}

// The injected text for the active construct, substituted for display.
function currentInjectionPreview() {
    const active = getActiveConstruct();
    if (!active) return '';
    if (active.type === 'arc') return arcInjectionPreview(active.arc);
    return buildDirective(active.plan);
}
function arcInjectionPreview(arc) {
    const raw = (arc.currentBeat && arc.currentBeat.injectedText) || '';
    try { return getCtx().substituteParams(raw); } catch (e) { return raw; }
}

// One-line label for the active construct (collapsed-float tooltip).
function activeConstructLabel() {
    const active = getActiveConstruct();
    if (!active) return '';
    if (active.type === 'arc') {
        const b = active.arc.currentBeat;
        // 盲盒：tooltip 绝不露幕后 goal / throughline —— 只给【玩家可见】objective（与方案条防剧透遮罩一致，§9）。
        if (active.arc.mode === 'blind') return b ? (arcVisibleObjective(b) || '引导进行中') : '引导进行中';
        return b ? b.goal : (active.arc.throughline || '');
    }
    const p = active.plan;
    return p.title ? `${p.title}：${p.goal}` : p.goal;
}

// 退出整条弧线需一次确认（与游玩按钮空间分离的硬操作）。
async function confirmArcExit() {
    if (await uiConfirm('确定退出？当前弧线和引导将被完全清除，主聊天恢复原状。')) arcExit();
}

// 读手动弧线表单 → 采用一条弧线（透明 或 盲盒；layer-2 / 4b「手动放置拍子」入口）。
// 第一拍仍由真编译器升级（见 adoptArc）。盲盒额外读 consent：难度 / 红线 / 风格 / 方向。
// 关表单 + 清字段 + 复位到「透明」默认（手填与盲盒自动起草两条路径都用）。
function resetArcForm() {
    win.querySelector('#so-arc-form').style.display = 'none';
    win.querySelector('#so-arc-throughline').value = '';
    win.querySelector('#so-arc-waypoints').value = '';
    win.querySelector('#so-arc-redlines').value = '';
    win.querySelector('#so-arc-style').value = '';
    win.querySelector('#so-arc-direction').value = '';
    win.querySelector('#so-arc-mode').value = 'transparent';
    win.querySelector('#so-arc-blind-fields').style.display = 'none';
    win.querySelector('#so-arc-create').textContent = '创建透明弧';
    const wpL = win.querySelector('#so-arc-waypoints-label');
    if (wpL) wpL.textContent = '路标（每行一个，意图级——透明弧你看得到每一拍，需自己填写）';
}

function onArcCreate() {
    const throughline = win.querySelector('#so-arc-throughline').value.trim();
    const waypoints = win.querySelector('#so-arc-waypoints').value
        .split('\n').map((x) => x.trim()).filter(Boolean);
    const spanFeel = win.querySelector('#so-arc-span').value;
    const mode = win.querySelector('#so-arc-mode').value === 'blind' ? 'blind' : 'transparent';
    const spec = { mode, throughline, spanFeel, waypoints };
    if (mode === 'blind') {
        const redlines = win.querySelector('#so-arc-redlines').value
            .split('\n').map((x) => x.trim()).filter(Boolean);
        const difficulty = win.querySelector('#so-arc-difficulty').value;
        spec.consent = {
            style: win.querySelector('#so-arc-style').value.trim(),
            redlines,
            difficulty: ADVISOR_DIFFICULTIES[difficulty] ? difficulty : 'normal',
            direction: win.querySelector('#so-arc-direction').value.trim(),
        };
        // 凛冽 = 不可逆赌注，红线是它唯一的安全护栏（设计 §0.5 / §5）。空着仍放行，但提醒一次。
        if (spec.consent.difficulty === 'stark' && !redlines.length) {
            addSystemNote('提示：凛冽难度会推动不可逆的重大抉择，建议至少填一条红线（编译器绝不触碰的底线）。这次不填也行——「退出」始终一键可达。');
        }
    }
    // 透明弧的路标用户看得到、需自己定，仍须手填；盲盒弧留空 = 由神谕按篇幅暗中拟定整条骨架。
    if (!waypoints.length && mode !== 'blind') {
        addSystemNote('请至少填写一个路标（每行一个）。透明弧的路标你看得到，需要你来定。');
        return;
    }
    resetArcForm();
    if (waypoints.length) adoptArc(spec);
    else adoptArcWithDraftedWaypoints(spec);   // 盲盒留空：异步起草整条骨架后采用
}

/* ---- 「📡 实时输出」查看器：独立浮窗，实时显示模型流式回传（含 reasoning），可拖动 / 关闭 ---- */
let arcLiveEl = null;
let arcLiveDirty = false;
function ensureArcLiveViewer() {
    if (arcLiveEl) return arcLiveEl;
    arcLiveEl = document.createElement('div');
    arcLiveEl.id = 'so-live';
    arcLiveEl.style.display = 'none';
    arcLiveEl.innerHTML = `
        <div id="so-live-head">
            <i class="fa-solid fa-satellite-dish"></i>
            <span id="so-live-title">实时输出</span>
            <span class="so-live-status" id="so-live-status"></span>
            <span class="so-plan-spacer"></span>
            <div class="so-iconbtn" id="so-live-copy" title="复制全部"><i class="fa-solid fa-copy"></i></div>
            <div class="so-iconbtn" id="so-live-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <pre id="so-live-body"></pre>`;
    document.body.appendChild(arcLiveEl);
    arcLiveEl.querySelector('#so-live-close').addEventListener('click', () => { arcLiveEl.style.display = 'none'; });
    arcLiveEl.querySelector('#so-live-copy').addEventListener('click', () => {
        copyTextRobust((arcLiveReasoning ? '〔思考过程〕\n' + arcLiveReasoning + '\n\n' : '') + (arcLiveText || ''));
    });
    makeDraggable(arcLiveEl, arcLiveEl.querySelector('#so-live-head'), { left: 'liveLeft', top: 'liveTop' });
    return arcLiveEl;
}
function toggleArcLiveViewer() {
    ensureArcLiveViewer();
    const show = arcLiveEl.style.display === 'none';
    arcLiveEl.style.display = show ? 'flex' : 'none';
    if (show) renderArcLiveNow();
}
// 节流渲染：查看器关着时是空操作（零开销）；开着时每帧最多渲一次。
function renderArcLive() {
    if (!arcLiveEl || arcLiveEl.style.display === 'none' || arcLiveDirty) return;
    arcLiveDirty = true;
    const run = () => { arcLiveDirty = false; renderArcLiveNow(); };
    try { requestAnimationFrame(run); } catch (e) { arcLiveDirty = false; renderArcLiveNow(); }
}
function renderArcLiveNow() {
    if (!arcLiveEl) return;
    const secs = Math.max(0, Math.round((Date.now() - arcLiveStartedAt) / 1000));
    const n = arcLiveText.length + arcLiveReasoning.length;
    arcLiveEl.querySelector('#so-live-status').textContent = arcLiveActive
        ? `⏳ 接收中…（已 ${secs}s · ${n} 字）`
        : (n ? '✓ 本次已结束' : '— 空闲');
    const parts = [];
    if (arcLiveReasoning) parts.push('〔思考过程 reasoning〕\n' + arcLiveReasoning);
    if (arcLiveText) parts.push('〔正式输出〕\n' + arcLiveText);
    let txt = parts.join('\n\n');
    if (!txt) {
        txt = !arcLiveStreamed
            ? '（本次没走流式——到「设置」里打开「流式」开关后，这里才能看到实时输出；当前只能等最终结果。）'
            : (arcLiveActive
                ? '（已发出请求，但还没有任何内容回来。\n若上方读秒一直在涨、这里却长时间空着，多半是连接卡住了——可点方案条上的「取消」。）'
                : '（本次没有输出。）');
    }
    const body = arcLiveEl.querySelector('#so-live-body');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.textContent = txt;
    if (atBottom) body.scrollTop = body.scrollHeight;   // 用户在底部时才自动滚（不打断往上翻看）
}

// Lazy-build the floating home for the strip.
function ensurePlanFloat() {
    if (planFloat) return;
    planFloat = document.createElement('div');
    planFloat.id = 'so-plan-float';
    planFloat.innerHTML = `
        <div id="so-plan-float-head">
            <i class="fa-solid fa-compass"></i>
            <span class="so-plan-float-title">剧情引导</span>
            <span class="so-plan-spacer"></span>
            <div class="so-iconbtn" id="so-plan-float-collapse" title="收起成小标签 / 展开"><i class="fa-solid fa-chevron-up"></i></div>
            <div class="so-iconbtn" id="so-plan-float-open" title="打开故事神谕"><i class="fa-solid fa-moon"></i></div>
        </div>
        <div id="so-plan-float-slot"></div>`;
    document.body.appendChild(planFloat);
    planFloatSlot = planFloat.querySelector('#so-plan-float-slot');
    planFloat.querySelector('#so-plan-float-open').addEventListener('click', () => toggleWindow(true));
    planFloat.querySelector('#so-plan-float-collapse').addEventListener('click', () => {
        const s2 = getSettings();
        s2.planFloatCollapsed = !s2.planFloatCollapsed;
        save();
        applyPlanFloatCollapsed();
    });
    // 折叠成罗盘药丸后，整张可点面就是那颗按钮 —— 放行「从按钮起拖」，否则手机上只剩 3px 外圈可拖（拖不动）。
    makeDraggable(planFloat, planFloat.querySelector('#so-plan-float-head'),
        { left: 'planFloatLeft', top: 'planFloatTop' },
        { dragFromButtons: () => planFloat.classList.contains('so-collapsed') });
    // Restore the saved position, clamped to the current viewport.
    const s = getSettings();
    if (Number.isFinite(s.planFloatLeft) && Number.isFinite(s.planFloatTop)) {
        planFloat.style.left = Math.max(0, Math.min(window.innerWidth - 60, s.planFloatLeft)) + 'px';
        planFloat.style.top = Math.max(0, Math.min(window.innerHeight - 40, s.planFloatTop)) + 'px';
        planFloat.style.right = 'auto';
    }
    applyPlanFloatCollapsed(); // restore persisted collapsed state
}

// Collapsed = a single 🧭 compass button, no words: tiniest footprint (mobile —
// nothing blocks the screen) while still an unmissable signal that steering is
// active. The collapse toggle itself carries the compass icon when folded; the
// decorative compass + title + open(moon) are hidden via CSS. Strip stays parented
// in the hidden slot, so expanding is pure CSS — no re-render, no listener churn.
function applyPlanFloatCollapsed() {
    if (!planFloat) return;
    const collapsed = !!getSettings().planFloatCollapsed;
    planFloat.classList.toggle('so-collapsed', collapsed);
    const btn = planFloat.querySelector('#so-plan-float-collapse');
    btn.querySelector('i').className = collapsed ? 'fa-solid fa-compass' : 'fa-solid fa-chevron-up';
    planFloat.querySelector('.so-plan-float-title').textContent = collapsed ? '引导中' : '剧情引导';
    // 防剧透：① 绝不在可 hover 的 head 上挂任何内容（此前折叠态把当前拍 goal 直接 hover 出来 = 破坏盲盒保密）；
    // ② 只在 compass 按钮上给【玩家可见】标签（activeConstructLabel 盲盒只回 objective、绝不回 goal）。
    const label = activeConstructLabel();
    btn.title = collapsed ? (label ? `展开 · ${label}` : '展开剧情引导') : '收起成指南针（不挡屏）';
    planFloat.querySelector('#so-plan-float-head').title = '';
}

// Decide where the strip lives right now. Rules: no plan -> hidden (and parked
// back in the window); plan + window visible -> inside the window (the float
// hides); plan + window closed -> inside the float, always on screen.
function placePlanBar() {
    if (!planBarEl || !win) return;
    const active = getActiveConstruct();
    const winVisible = win.style.display !== 'none';
    if (active && !winVisible) {
        ensurePlanFloat();
        if (planBarEl.parentElement !== planFloatSlot) planFloatSlot.appendChild(planBarEl);
        planFloat.style.display = 'flex';
        applyPlanFloatCollapsed(); // refresh pill tooltip (plan may have changed)
    } else {
        if (planFloat) planFloat.style.display = 'none';
        if (planBarEl.parentElement !== win) {
            win.insertBefore(planBarEl, win.querySelector('#so-messages'));
        }
    }
}

// Fill the book checklist: every known book as a checkbox (active ones marked ★).
async function populateLorebookBooks(announce) {
    const listEl = win.querySelector('#so-lb-book-list');
    if (!listEl) return;
    const s = getSettings();
    let active = [];
    let all = [];
    try {
        [active, all] = await Promise.all([getActiveBookNames(), getAllBookNames()]);
    } catch (e) { /* leave empty */ }

    // Prune selections that no longer exist on disk.
    if (Array.isArray(s.lorebookTargets) && s.lorebookTargets.length) {
        const allSet = new Set(all);
        const kept = s.lorebookTargets.filter((n) => allSet.has(n));
        if (kept.length !== s.lorebookTargets.length) { s.lorebookTargets = kept; save(); }
    }

    const chosen = new Set(Array.isArray(s.lorebookTargets) ? s.lorebookTargets : []);
    const activeSet = new Set(active);
    listEl.innerHTML = '';
    if (!all.length) {
        listEl.innerHTML = '<div class="so-lb-ent-empty">（没有找到任何世界书。）</div>';
    } else {
        for (const name of all) {
            const row = document.createElement('label');
            row.className = 'so-lb-book-opt';
            row.dataset.book = name;
            const star = activeSet.has(name) ? '★ ' : '';
            row.innerHTML = `<input type="checkbox"${chosen.has(name) ? ' checked' : ''}><span class="so-lb-book-name"></span>`;
            row.querySelector('.so-lb-book-name').textContent = star + name;
            listEl.appendChild(row);
        }
    }
    updateLbBookSummary();
    updateLbHint();
    populateLorebookEntries();
    if (announce) addSystemNote('已刷新世界书列表。');
}

// Summary text on the picker's <summary>: "全部激活的世界书" or "已选 N 本".
function updateLbBookSummary() {
    const sum = win.querySelector('#so-lb-bookpick-sum');
    if (!sum) return;
    const t = getSettings().lorebookTargets;
    sum.textContent = (Array.isArray(t) && t.length) ? `已选 ${t.length} 本世界书` : '全部激活的世界书';
}

// Recompute lorebookTargets from the checked rows; refresh dependent UI.
function onLbBookSelectionChange() {
    const s = getSettings();
    const picked = [];
    for (const box of win.querySelectorAll('#so-lb-book-list input[type="checkbox"]')) {
        if (box.checked) {
            const row = box.closest('.so-lb-book-opt');
            if (row && row.dataset.book) picked.push(row.dataset.book);
        }
    }
    s.lorebookTargets = picked;
    save();
    updateLbBookSummary();
    updateLbHint();
    populateLorebookEntries();
}

function updateLbHint() {
    const hint = win.querySelector('#so-lb-hint');
    if (!hint) return;
    const t = getSettings().lorebookTargets;
    hint.textContent = (Array.isArray(t) && t.length)
        ? `将聊 / 编辑：已选 ${t.length} 本世界书（${t.join('、')}）。可在下方按条目精选以控制 token。`
        : '将聊 / 编辑：当前角色卡 / 聊天 / 全局所激活的全部世界书。可在下方按条目精选（含仅蓝灯 / 仅绿灯等快捷选择）以控制 token 消耗。';
}

/* ---- per-entry picker (single targeted book, OR every active book grouped) ----
 * Selection is keyed by book name in lbEntryFilter, so the same machinery serves
 * both: each rendered row carries data-book, and the buttons/summary fan out over
 * whatever books are currently shown (one book, or all active ones). */

// All entry uids of one book, from its rendered rows (regardless of checked state).
function allLbEntryUidsForBook(book) {
    const uids = [];
    for (const row of win.querySelectorAll('#so-lb-entries-list .so-lb-ent')) {
        if ((row.dataset.book || '') !== (book || '')) continue;
        const box = row.querySelector('input[type="checkbox"]');
        if (box) uids.push(Number(box.dataset.uid));
    }
    return uids;
}

// Every book currently rendered in the picker -> its entry-row count.
function lbShownBookTotals() {
    const totals = new Map();
    for (const row of win.querySelectorAll('#so-lb-entries-list .so-lb-ent')) {
        const b = row.dataset.book || '';
        totals.set(b, (totals.get(b) || 0) + 1);
    }
    return totals;
}

// Recompute the summary across EVERY book shown. A book whose Set covers all its
// shown entries collapses back to null ("all" — buildLorebookContext's untouched
// 整本 path), so re-checking everything reverts to "send the whole book".
function refreshLbEntriesSummary() {
    const totals = lbShownBookTotals();
    let total = 0;
    let selected = 0;
    let anyFiltered = false;
    for (const [book, t] of totals) {
        const sel = lbEntryFilter[book];
        if (sel instanceof Set && t > 0 && sel.size >= t) lbEntryFilter[book] = null;
        const now = lbEntryFilter[book];
        total += t;
        if (now instanceof Set) { selected += now.size; anyFiltered = true; }
        else selected += t;
    }
    const summary = win.querySelector('#so-lb-entries-summary');
    if (!summary) return;
    summary.textContent = anyFiltered ? `条目：已选 ${selected} / ${total}` : `条目：全部（${total}）`;
}

function toggleLbEntry(book, uid, checked) {
    let sel = lbEntryFilter[book];
    if (!(sel instanceof Set)) sel = new Set(allLbEntryUidsForBook(book)); // was "all" -> materialize
    if (checked) sel.add(uid); else sel.delete(uid);
    lbEntryFilter[book] = sel;
    refreshLbEntriesSummary();
}

// 全选 / 全不选 across every book shown (each book is its own filter entry).
function setAllLbEntries(on) {
    const books = new Set();
    for (const row of win.querySelectorAll('#so-lb-entries-list .so-lb-ent')) {
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = on;
        books.add(row.dataset.book || '');
    }
    for (const b of books) lbEntryFilter[b] = on ? null : new Set();   // all | none, per book
    refreshLbEntriesSummary();
}

// Select exactly the entries of one lamp type: 'blue' (常驻), 'green' (关键词触发),
// or 'off' (已禁用), across every book shown. None include disabled except 'off'.
function setLbEntriesByType(type) {
    const rows = [...win.querySelectorAll('#so-lb-entries-list .so-lb-ent')];
    if (!rows.length) return;
    const perBook = new Map();   // book -> Set of matching uids
    for (const row of rows) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const match = row.dataset.type === type;
        if (box) box.checked = match;
        if (match) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, sel] of perBook) lbEntryFilter[book] = sel;   // empty Set -> sends none of that book
    refreshLbEntriesSummary();
}

function filterLbEntries(q) {
    const needle = (q || '').trim().toLowerCase();
    const list = win.querySelector('#so-lb-entries-list');
    if (!list) return;
    for (const row of list.querySelectorAll('.so-lb-ent')) {
        row.style.display = (!needle || (row.dataset.hay || '').includes(needle)) ? '' : 'none';
    }
    // Hide a book header (+ its "empty" sub-line) when none of its rows are visible.
    for (const head of list.querySelectorAll('.so-lb-book-head, .so-lb-ent-empty-sub')) {
        if (!needle) { head.style.display = ''; continue; }
        const book = head.dataset.book || '';
        const headMatches = (head.dataset.hay || '').includes(needle);
        const anyRowVisible = [...list.querySelectorAll('.so-lb-ent')]
            .some((r) => (r.dataset.book || '') === book && r.style.display !== 'none');
        head.style.display = (headMatches || anyRowVisible) ? '' : 'none';
    }
    updateLbFilteredBtn();
}

// 「全选筛选」：把选择设为【当前筛选 / 搜索后仍可见】的那些条目（每本书各自计算）；
// 被筛掉（隐藏）的条目一律不选 —— 于是结果恰好等于你眼前筛出来的这些。无筛选时＝全选。
function selectFilteredLbEntries() {
    const perBook = new Map();   // book -> Set of visible uids
    for (const row of win.querySelectorAll('#so-lb-entries-list .so-lb-ent')) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const visible = row.style.display !== 'none';
        if (box) box.checked = visible;
        if (visible && box) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, sel] of perBook) lbEntryFilter[book] = sel;   // exactly the visible set (refresh collapses full→null)
    refreshLbEntriesSummary();
}

// 「全选筛选」只在有筛选词时才有意义（否则就等于「全选」）—— 没筛选时禁用它。
function updateLbFilteredBtn() {
    const btn = win.querySelector('#so-lb-filtered');
    if (!btn) return;
    const f = win.querySelector('#so-lb-entries-filter');
    btn.disabled = !(f && f.value && f.value.trim());
}

// 纯函数：把一条世界书条目的 raw content 压成选条目器里展示的一行短摘要——折叠所有空白
// （含换行 / 制表 / 全角空格）为单空格、首尾去空白、超过 cap 字裁断加省略号；空 / 纯空白回空串。
// 宏（{{user}} 等）字面保留——这是只读预览、不喂模型、不做锚点，遵循世界书模式的逐字原则。可单测。
function entryPreviewText(content, cap = 200) {
    const s = String(content == null ? '' : content).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > cap ? s.slice(0, cap) + '…' : s;
}

// 把「内容预览」开关的当前状态映射到 DOM：给条目列加 / 去 .so-lb-show-preview（CSS 据此整列显隐预览行），
// 并同步顶部开关按钮的 .active 高亮。在渲染条目、点开关、初始化绑定时各调一次。
function reflectLbPreview() {
    const on = !!getSettings().lbShowEntryPreview;
    const list = win.querySelector('#so-lb-entries-list');
    const btn = win.querySelector('#so-lb-preview-toggle');
    if (list) list.classList.toggle('so-lb-show-preview', on);
    if (btn) btn.classList.toggle('active', on);
}

// 点「👁 内容预览」：翻转设置、持久化、刷新 DOM。纯展示开关，不重建列表（预览行始终在 DOM 里、靠 CSS 显隐）。
function toggleLbPreview() {
    const s = getSettings();
    s.lbShowEntryPreview = !s.lbShowEntryPreview;
    save();
    reflectLbPreview();
}

// Build / refresh the entry checklist. A specific target -> just that book's
// entries. "All active books" ('') -> every active book's entries, grouped under
// per-book headers (the same book set buildLorebookContext feeds in all-active
// mode); the shortcut buttons + filter then span all of them. Hidden entirely when
// there's nothing to show (no target picked AND no active book).
async function populateLorebookEntries() {
    const box = win.querySelector('#so-lb-entries');
    const list = win.querySelector('#so-lb-entries-list');
    if (!box || !list) return;
    const s = getSettings();
    let books;
    try {
        const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
        books = resolveLbTargetNames(s.lorebookTargets, allNames, activeNames);
    } catch (e) { books = []; }
    if (!books.length) { box.classList.remove('shown'); return; }
    box.classList.add('shown');
    reflectLbPreview();   // 把「内容预览」开关状态贴到列表 + 按钮（每次渲染都对齐）
    const grouped = books.length > 1;   // per-book headers whenever more than one book is shown

    list.innerHTML = '<div class="so-lb-ent-empty">读取条目中…</div>';
    const mod = await getWiEditApi();
    const loaded = [];   // [{ name, entries }]
    for (const name of books) {
        let entries = [];
        try {
            const data = mod ? await mod.loadWorldInfo(name) : null;
            if (data && data.entries) {
                entries = Object.values(data.entries)
                    .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
            }
        } catch (e) { /* leave empty */ }
        // Drop stale uids from a prior selection (entries may have changed since).
        if (lbEntryFilter[name] instanceof Set) {
            const valid = new Set(entries.map((e) => e.uid));
            lbEntryFilter[name] = new Set([...lbEntryFilter[name]].filter((u) => valid.has(u)));
        }
        loaded.push({ name, entries });
    }

    const totalEntries = loaded.reduce((n, b) => n + b.entries.length, 0);
    list.innerHTML = '';
    if (!totalEntries) {
        list.innerHTML = `<div class="so-lb-ent-empty">（${grouped ? '当前激活的世界书暂无条目' : '此世界书暂无条目'}。）</div>`;
        refreshLbEntriesSummary();
        return;
    }

    for (const { name, entries } of loaded) {
        if (grouped) {
            const head = document.createElement('div');
            head.className = 'so-lb-book-head';
            head.dataset.book = name;
            head.dataset.hay = name.toLowerCase();
            head.innerHTML = '<i class="fa-solid fa-book"></i><span class="so-lb-book-name"></span>' +
                `<span class="so-lb-book-count">${entries.length}</span>`;
            head.querySelector('.so-lb-book-name').textContent = name;
            list.appendChild(head);
            if (!entries.length) {
                const empty = document.createElement('div');
                empty.className = 'so-lb-ent-empty so-lb-ent-empty-sub';
                empty.dataset.book = name;
                empty.dataset.hay = name.toLowerCase();
                empty.textContent = '（此书暂无条目）';
                list.appendChild(empty);
                continue;
            }
        }
        const sel = lbEntryFilter[name];   // Set | null (= all)
        for (const e of entries) {
            const checked = !(sel instanceof Set) || sel.has(e.uid);
            const title = (e.comment && e.comment.trim()) ? e.comment.trim() : '（无标题）';
            const keys = Array.isArray(e.key) ? e.key.filter(Boolean).join(', ') : '';
            const row = document.createElement('label');
            row.className = 'so-lb-ent';
            row.dataset.book = name;
            row.dataset.hay = `${grouped ? name + ' ' : ''}${e.uid} ${title} ${keys}`.toLowerCase();
            row.dataset.type = e.disable ? 'off' : (e.constant ? 'blue' : 'green');
            row.innerHTML = `<input type="checkbox" data-uid="${e.uid}"${checked ? ' checked' : ''}>` +
                `<span class="so-lb-ent-type so-lb-type-${e.disable ? 'off' : (e.constant ? 'blue' : 'green')}"></span>` +
                `<span class="so-lb-ent-uid">#${e.uid}</span><span class="so-lb-ent-title"></span>` +
                `<span class="so-lb-ent-preview"></span>`;
            row.querySelector('.so-lb-ent-title').textContent = title;
            // 内容预览（开关在 .so-lb-show-preview 上；textContent 不走 innerHTML —— raw lore 绝不当 HTML 解析）。
            const prevEl = row.querySelector('.so-lb-ent-preview');
            const prevText = entryPreviewText(e.content);
            prevEl.textContent = prevText || '（空条目）';
            if (!prevText) prevEl.classList.add('is-empty');
            row.querySelector('input').addEventListener('change', (ev) => toggleLbEntry(name, e.uid, ev.target.checked));
            list.appendChild(row);
        }
    }
    const f = win.querySelector('#so-lb-entries-filter');
    if (f && f.value) filterLbEntries(f.value);
    refreshLbEntriesSummary();
    updateLbFilteredBtn();
}

/* ---- 诊断模式「精选世界书条目」选条目器（用户功能请求；ENABLE_DIAG_WI_PICKER）----
 * 复用世界书选条目器的视觉（.so-lb-* 类），但语义不同：
 *   · 选择 diagEntrySel[书名] 始终是【显式 Set<uid>】（无「null = 全选」惯例）——勾了才发，没勾就不发；
 *   · 每次改动都【按聊天持久化】（persistDiagSel）；
 *   · 首开按 computeDiagSnapshot（当前激活＝蓝灯 + 命中绿灯）预选一份，之后随你增删。 */

// 首开预选「当前快照」：蓝灯常驻（未禁用）+ 主聊天此刻命中的绿灯，不含禁用。-> { 书名: Set<uid> }。
// 蓝灯直接从【原始书】取（不依赖扫描预算——某些环境下 dry-run 扫描会因预算返回空），扫描只用来定「哪些绿灯当前命中」。
async function computeDiagSnapshot() {
    const mod = await getWiEditApi();
    if (!mod) return {};
    let books = [];
    try { books = await getActiveBookNames(); } catch (e) { books = []; }
    const active = await getActiveScanUids();   // { 书名: Set<uid> } 当前命中（含蓝 + 绿）
    const snap = {};
    for (const name of books) {
        let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
        const all = data && data.entries ? Object.values(data.entries) : [];
        const activeSet = active[name] || new Set();
        const set = new Set();
        for (const e of all) {
            if (!e || e.disable) continue;                                  // 禁用条目不进快照
            if (e.constant === true) set.add(Number(e.uid));                // 蓝灯常驻（原始书直取）
            else if (activeSet.has(Number(e.uid))) set.add(Number(e.uid));  // 当前命中的绿灯
        }
        if (set.size) snap[name] = set;
    }
    return snap;
}

// 填充诊断选条目器的书下拉（与 populateLorebookBooks 同构，但目标存元数据而非设置）。
async function populateDiagWiBooks(announce) {
    const sel = win.querySelector('#so-diag-book');
    if (!sel) return;
    let active = [];
    let all = [];
    try { [active, all] = await Promise.all([getActiveBookNames(), getAllBookNames()]); } catch (e) { /* leave empty */ }
    sel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = active.length ? `① 当前激活的全部世界书（${active.length} 本）` : '① 当前激活的全部世界书（无）';
    sel.appendChild(optAll);
    const activeSet = new Set(active);
    for (const name of all) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = activeSet.has(name) ? `★ ${name}` : name;
        sel.appendChild(opt);
    }
    const meta = getDiagWiMeta();
    if (meta.target && all.includes(meta.target)) {
        sel.value = meta.target;
    } else {
        if (meta.target) setDiagWiMeta({ use: meta.use, hybrid: meta.hybrid, target: '', sel: serializeDiagSel(diagEntrySel) });
        sel.value = '';
    }
    updateDiagHint();
    populateDiagWiEntries();
    if (announce) addSystemNote('已刷新世界书列表。');
}

function updateDiagHint() {
    const hint = win.querySelector('#so-diag-hint');
    if (!hint) return;
    const meta = getDiagWiMeta();
    hint.textContent = meta.target
        ? `从「${meta.target}」这一本里挑条目喂给诊断。`
        : '从当前激活的全部世界书里挑条目喂给诊断。勾选即覆盖默认扫描——只发你选中的（无视启用 / 禁用）。';
}

// 当前显示的全部行里有多少被勾选 -> 更新条目摘要（直接数复选框，与显式 Set 模型一致）。
function refreshDiagEntriesSummary() {
    const rows = [...win.querySelectorAll('#so-diag-entries-list .so-lb-ent')];
    const total = rows.length;
    let selected = 0;
    for (const row of rows) {
        const box = row.querySelector('input[type="checkbox"]');
        if (box && box.checked) selected++;
    }
    const summary = win.querySelector('#so-diag-entries-summary');
    if (!summary) return;
    summary.textContent = (total && selected >= total) ? `条目：全部（${total}）` : `条目：已选 ${selected} / ${total}`;
}

// 勾 / 取消单条：显式 Set，缺省从空集合起（绝不「从全选物化」——精选模型默认不选）。
function toggleDiagEntry(book, uid, checked) {
    let sel = diagEntrySel[book];
    if (!(sel instanceof Set)) sel = new Set();
    if (checked) sel.add(Number(uid)); else sel.delete(Number(uid));
    diagEntrySel[book] = sel;
    refreshDiagEntriesSummary();
    persistDiagSel();
}

// 全选 / 全不选（仅作用于当前显示的书）。on -> 该书所有显示行的 uid；off -> 空集合。
function setAllDiagEntries(on) {
    const perBook = new Map();
    for (const row of win.querySelectorAll('#so-diag-entries-list .so-lb-ent')) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = on;
        if (on && box) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, set] of perBook) diagEntrySel[book] = set;
    refreshDiagEntriesSummary();
    persistDiagSel();
}

// 按灯型选：'blue'（常驻）/ 'green'（关键词）/ 'off'（已禁用），跨当前显示的每本书。
function setDiagEntriesByType(type) {
    const rows = [...win.querySelectorAll('#so-diag-entries-list .so-lb-ent')];
    if (!rows.length) return;
    const perBook = new Map();
    for (const row of rows) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const match = row.dataset.type === type;
        if (box) box.checked = match;
        if (match && box) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, set] of perBook) diagEntrySel[book] = set;
    refreshDiagEntriesSummary();
    persistDiagSel();
}

// 文本筛选条目（标题 / 关键词 / uid）——纯 DOM 显隐，与世界书器同款；分组头随其行显隐。
function filterDiagEntries(q) {
    const needle = (q || '').trim().toLowerCase();
    const list = win.querySelector('#so-diag-entries-list');
    if (!list) return;
    for (const row of list.querySelectorAll('.so-lb-ent')) {
        row.style.display = (!needle || (row.dataset.hay || '').includes(needle)) ? '' : 'none';
    }
    for (const head of list.querySelectorAll('.so-lb-book-head, .so-lb-ent-empty-sub')) {
        if (!needle) { head.style.display = ''; continue; }
        const book = head.dataset.book || '';
        const headMatches = (head.dataset.hay || '').includes(needle);
        const anyRowVisible = [...list.querySelectorAll('.so-lb-ent')]
            .some((r) => (r.dataset.book || '') === book && r.style.display !== 'none');
        head.style.display = (headMatches || anyRowVisible) ? '' : 'none';
    }
    updateDiagFilteredBtn();
}

// 「全选筛选」：把选择设为当前筛选后仍可见的那些（每本书各自计算）。
function selectFilteredDiagEntries() {
    const perBook = new Map();
    for (const row of win.querySelectorAll('#so-diag-entries-list .so-lb-ent')) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const visible = row.style.display !== 'none';
        if (box) box.checked = visible;
        if (visible && box) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, set] of perBook) diagEntrySel[book] = set;
    refreshDiagEntriesSummary();
    persistDiagSel();
}

function updateDiagFilteredBtn() {
    const btn = win.querySelector('#so-diag-filtered');
    if (!btn) return;
    const f = win.querySelector('#so-diag-entries-filter');
    btn.disabled = !(f && f.value && f.value.trim());
}

// 渲染条目清单：勾选态来自 diagEntrySel（显式 Set；未选即未勾）。单本目标 -> 仅该书；否则按激活书分组。
async function populateDiagWiEntries() {
    const box = win.querySelector('#so-diag-entries');
    const list = win.querySelector('#so-diag-entries-list');
    if (!box || !list) return;
    const target = getDiagWiMeta().target;
    let books;
    if (target) books = [target];
    else { try { books = await getActiveBookNames(); } catch (e) { books = []; } }
    if (!books.length) { box.classList.remove('shown'); return; }
    box.classList.add('shown');
    const grouped = !target;

    list.innerHTML = '<div class="so-lb-ent-empty">读取条目中…</div>';
    const mod = await getWiEditApi();
    const loaded = [];
    for (const name of books) {
        let entries = [];
        try {
            const data = mod ? await mod.loadWorldInfo(name) : null;
            if (data && data.entries) {
                entries = Object.values(data.entries)
                    .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
            }
        } catch (e) { /* leave empty */ }
        // 清理失效 uid（条目可能已变）。
        if (diagEntrySel[name] instanceof Set) {
            const valid = new Set(entries.map((e) => Number(e.uid)));
            diagEntrySel[name] = new Set([...diagEntrySel[name]].filter((u) => valid.has(Number(u))));
        }
        loaded.push({ name, entries });
    }

    const totalEntries = loaded.reduce((n, b) => n + b.entries.length, 0);
    list.innerHTML = '';
    if (!totalEntries) {
        list.innerHTML = `<div class="so-lb-ent-empty">（${grouped ? '当前激活的世界书暂无条目' : '此世界书暂无条目'}。）</div>`;
        refreshDiagEntriesSummary();
        return;
    }

    for (const { name, entries } of loaded) {
        if (grouped) {
            const head = document.createElement('div');
            head.className = 'so-lb-book-head';
            head.dataset.book = name;
            head.dataset.hay = name.toLowerCase();
            head.innerHTML = '<i class="fa-solid fa-book"></i><span class="so-lb-book-name"></span>' +
                `<span class="so-lb-book-count">${entries.length}</span>`;
            head.querySelector('.so-lb-book-name').textContent = name;
            list.appendChild(head);
            if (!entries.length) {
                const empty = document.createElement('div');
                empty.className = 'so-lb-ent-empty so-lb-ent-empty-sub';
                empty.dataset.book = name;
                empty.dataset.hay = name.toLowerCase();
                empty.textContent = '（此书暂无条目）';
                list.appendChild(empty);
                continue;
            }
        }
        const set = diagEntrySel[name];   // Set（精选模型：未选即未勾，无 null=全选惯例）
        for (const e of entries) {
            const checked = (set instanceof Set) && set.has(Number(e.uid));
            const title = (e.comment && e.comment.trim()) ? e.comment.trim() : '（无标题）';
            const keys = Array.isArray(e.key) ? e.key.filter(Boolean).join(', ') : '';
            const row = document.createElement('label');
            row.className = 'so-lb-ent';
            row.dataset.book = name;
            row.dataset.hay = `${grouped ? name + ' ' : ''}${e.uid} ${title} ${keys}`.toLowerCase();
            row.dataset.type = e.disable ? 'off' : (e.constant ? 'blue' : 'green');
            row.innerHTML = `<input type="checkbox" data-uid="${e.uid}"${checked ? ' checked' : ''}>` +
                `<span class="so-lb-ent-type so-lb-type-${e.disable ? 'off' : (e.constant ? 'blue' : 'green')}"></span>` +
                `<span class="so-lb-ent-uid">#${e.uid}</span><span class="so-lb-ent-title"></span>`;
            row.querySelector('.so-lb-ent-title').textContent = title;
            row.querySelector('input').addEventListener('change', (ev) => toggleDiagEntry(name, Number(e.uid), ev.target.checked));
            list.appendChild(row);
        }
    }
    const f = win.querySelector('#so-diag-entries-filter');
    if (f && f.value) filterDiagEntries(f.value);
    refreshDiagEntriesSummary();
    updateDiagFilteredBtn();
}

// L2 混合开关 + 选条目区只在 L1 开启后显示。
function reflectDiagPickerVisible(on) {
    const bar = win && win.querySelector('#so-diag-bar');
    if (bar) bar.classList.toggle('so-diag-usesel-on', !!on);
}

// L1（用精选条目）切换：首开且无既有选择 -> 预选当前快照；否则载入既有。落元数据、刷新可见性、填充。
async function onDiagUseSelToggle(on) {
    const meta = getDiagWiMeta();
    if (on && !Object.keys(meta.sel || {}).length) {
        try { diagEntrySel = await computeDiagSnapshot(); } catch (e) { diagEntrySel = {}; }
    } else {
        diagEntrySel = deserializeDiagSel(meta.sel);
    }
    setDiagWiMeta({ use: on, hybrid: meta.hybrid, target: meta.target, sel: serializeDiagSel(diagEntrySel) });
    reflectDiagPickerVisible(on);
    if (on) await populateDiagWiBooks();
    addSystemNote(on
        ? '已开启「诊断精选世界书条目」。已按当前激活情况预选了一份——可在下方增删（含已禁用条目）；选择只影响喂给诊断的内容，且按【本聊天】记忆。'
        : '已关闭精选，诊断恢复默认世界书扫描（你的选择仍按本聊天保留，下次打开即恢复）。');
}

// L2（混合模式）切换：只改 hybrid 标志（影响喂料，不改选条目视图）。
function onDiagHybridToggle(on) {
    const meta = getDiagWiMeta();
    setDiagWiMeta({ use: meta.use, hybrid: on, target: meta.target, sel: serializeDiagSel(diagEntrySel) });
    addSystemNote(on
        ? '已开启混合模式：除了你精选的条目，诊断还会带上主聊天此刻触发的绿灯条目。'
        : '已关闭混合模式：只喂你精选的条目。');
}

// 把本聊天保存的诊断选择载入内存 + 刷新选条目器 UI（在 onChatChanged 调用，随聊天切换）。
function loadDiagSelForChat() {
    diagEntrySel = deserializeDiagSel(getDiagWiMeta().sel);
    refreshDiagPickerUI();
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式 Phase 4：把校正控件（#so-fix-bar 里的目标 / 约束 / 上下文开关 / 自动）
 * 与【本聊天】生效配置对齐。loadSettingsIntoForm 初次填表、切聊天（onChatChanged）都调 seedFixControls。
 * ------------------------------------------------------------------ */
// 校正设置面板：按 fixSettingsView 显示手动 / 自动那一套（纯视图切换，不改任何行为）。窗口未建好时静默跳过。
function applyFixModeView() {
    if (!win) return;
    const view = (getSettings().fixSettingsView === 'auto') ? 'auto' : 'manual';
    const sel = win.querySelector('#so-fix-mode-select');
    if (sel) sel.value = view;
    const man = win.querySelector('#so-fix-manual');
    const auto = win.querySelector('#so-fix-auto-wrap');
    if (man) man.style.display = (view === 'manual') ? '' : 'none';
    if (auto) auto.style.display = (view === 'auto') ? '' : 'none';
    applyFixFlavorView();   // ✨ 精校侧重行仅在选了「精校」时显示
    updateFixVerdict();   // ✨ Phase 6：切到自动视图 / 刷新时更新作用域判定预览
}

// ✨ 校正提示词选择器：「精校侧重」行仅在版本 === 'thorough'（精校）时显示，轻校时隐藏（镜像作用域 / 排除区的条件显隐）。
// 读【本聊天】生效配置为准（非 DOM select 值），故 seed 顺序无关。窗口未建好时静默跳过。
function applyFixFlavorView() {
    if (!win) return;
    const cfg = getEffectiveFixCfg(getSettings(), getFixCfg());
    const row = win.querySelector('#so-fix-prompt-flavor-row');
    if (row) row.style.display = (cfg.fixA_promptVersion === 'thorough') ? '' : 'none';
}

// ✨ 校正模式「自动配置」Phase 6（B）——作用域判定预览行：对【最新一条回复】跑 resolveFixScope（= 自动模式此刻
// 会怎么处理这条），渲染成一行人话（命中→只校正正文 N 字 / 会切标签 / 会跳过 / 整条校正）。仅自动视图显示；textContent 安全。
function updateFixVerdict() {
    if (!win) return;
    const el = win.querySelector('#so-fix-verdict');
    if (!el) return;
    if (getSettings().fixSettingsView !== 'auto') { el.hidden = true; return; }   // 作用域是自动模式专属
    el.hidden = false;
    const latest = getLatestAiMessage();
    if (latest.idx < 0) {
        el.className = 'so-fix-verdict so-fix-verdict-neutral';
        el.textContent = 'ⓘ 还没有可预览的回复——主聊天里发一条后，这里会显示这条回复的校正范围。';
        return;
    }
    const cfg = getEffectiveFixCfg(getSettings(), getFixCfg());
    const a = resolveFixModeCfg(cfg, 'auto');
    const dec = resolveFixScope({ cachedTag: a.scopeTag, scopeManual: a.scopeManual, reply: latest.text, replies: recentAiReplies(getCtx().chat, 5) });
    if (dec.action === 'cache') {
        const v = fixScopeVerdict(latest.text, a.scopeTag, a.keepTags);
        el.className = 'so-fix-verdict so-fix-verdict-ok';
        el.textContent = '✓ 命中 <' + a.scopeTag + '> → 只校正正文 ' + v.fixChars + ' 字，正文外 ' + v.preservedTags.length + ' 块原样保留'
            + (v.keepBlockCount ? ('（含你指定保留的 ' + v.keepBlockCount + ' 块）') : '');
    } else if (dec.action === 'fallbackWhole') {
        el.className = 'so-fix-verdict so-fix-verdict-neutral';
        el.textContent = a.scopeTag
            ? 'ⓘ 这条回复没有包裹标签（整条都是正文）→ 会校正整条回复。'
            : 'ⓘ 没设作用域 → 会校正整条回复（适合没有状态栏 / 选项等结构块的简单卡）。';
    } else if (dec.action === 'detected') {
        el.className = 'so-fix-verdict so-fix-verdict-warn';
        el.textContent = '✨ 这条回复用的是 <' + dec.note.detectedTag + '>（不是 <' + a.scopeTag + '>）→ 自动会切到 <' + dec.note.detectedTag + '> 再校正。';
    } else if (dec.action === 'suggest') {
        el.className = 'so-fix-verdict so-fix-verdict-warn';
        el.textContent = dec.note.detectedTag
            ? '⚠️ 你设的 <' + a.scopeTag + '> 不在这条回复里；可能是 <' + dec.note.detectedTag + '>（点扫描采纳，或手动改）——这条会被跳过、不动。'
            : '⚠️ 你设的 <' + a.scopeTag + '> 不在这条回复里 → 这条会被跳过、不动（避免误改整条）。';
    } else {   // skip（anomaly / uncertain）
        el.className = 'so-fix-verdict so-fix-verdict-warn';
        el.textContent = '⏭️ 这条回复里没有 <' + a.scopeTag + '> → 自动会跳过、不动它（可能这条格式特殊，或卡片换了标签——点扫描看看）。';
    }
}

// ✨ Phase 6（C）——扫描按钮：对最近几条 AI 回复跑 detectScopeTag + detectInnerBlocks，出「采纳标签 / 加入保留区」建议。
// 标签名受 scanTopLevelBlocks 字符集约束（[A-Za-z0-9_一-龥-]，无 HTML 元字符）→ 直插 innerHTML 无注入风险。
function scanFixScope() {
    if (!win) return;
    const panel = win.querySelector('#so-fix-scan-panel');
    if (!panel) return;
    panel.hidden = false;
    const chat = getCtx().chat;
    const replies = recentAiReplies(chat, 8);
    if (!replies.length) { panel.innerHTML = '<div class="so-hint">还没有 AI 回复可供扫描——先在主聊天里生成几条回复再来。</div>'; return; }
    const det = detectScopeTag(replies);
    if (det.noWrapper) {
        panel.innerHTML = '<div class="so-scan-row">这几条回复的正文是【裸的】——没有包裹标签。</div>'
            + '<div class="so-hint">→ 把上面的「只校正此标签内」<strong>留空</strong>即可，会校正整条回复（简单卡的正常情况）。</div>'
            + '<button type="button" id="so-scan-clear" class="so-fix-run-btn">留空作用域</button>';
        const cb = win.querySelector('#so-scan-clear');
        if (cb) cb.addEventListener('click', () => applyScopeFromScan(''));
        return;
    }
    const conf = det.confidence;
    const confLabel = (conf === 'high') ? '很可能' : (conf === 'med' ? '可能' : '不太确定');
    let html = '<div class="so-scan-row">检测到正文标签：<code>&lt;' + det.tag + '&gt;</code> <span class="so-scan-conf so-scan-conf-' + conf + '">' + confLabel + '</span></div>';
    if (conf === 'high') {
        html += '<button type="button" class="so-fix-run-btn" data-scan-adopt="' + det.tag + '">采纳 &lt;' + det.tag + '&gt; 作为作用域</button>';
    } else {
        html += '<div class="so-hint">不太确定，从下面挑一个（点一下就填上），或直接手动填：</div><div class="so-scan-cands">';
        for (const c of det.candidates.slice(0, 5)) html += '<button type="button" class="so-scan-cand" data-scan-adopt="' + c.tag + '">&lt;' + c.tag + '&gt;</button>';
        html += '</div>';
    }
    const inner = (splitContentScope(replies[replies.length - 1], det.tag).inner) || '';
    const blocks = detectInnerBlocks(inner);
    if (blocks.length) {
        html += '<div class="so-scan-row" style="margin-top:6px;">正文里还嵌着这些结构块——勾选后加入保留区，校正时会原样留住：</div><div class="so-scan-blocks">';
        for (const b of blocks) {
            const form = b.bracket ? ('[' + b.name + ']') : ('&lt;' + b.name + '&gt;');
            html += '<label class="so-check"><input type="checkbox" class="so-scan-block" data-bn="' + b.name + '" data-bb="' + (b.bracket ? '1' : '0') + '" checked>&nbsp;<span>' + form + '</span></label>';
        }
        html += '</div><button type="button" id="so-scan-keep" class="so-fix-run-btn">把勾选的加入保留区</button>';
    }
    panel.innerHTML = html;
    panel.querySelectorAll('[data-scan-adopt]').forEach((b) => b.addEventListener('click', () => applyScopeFromScan(b.getAttribute('data-scan-adopt'))));
    const keepBtn = win.querySelector('#so-scan-keep');
    if (keepBtn) keepBtn.addEventListener('click', () => {
        const picks = [...panel.querySelectorAll('.so-scan-block:checked')].map((c) => ({ name: c.getAttribute('data-bn'), bracket: c.getAttribute('data-bb') === '1' }));
        if (!picks.length) { if (typeof toastr !== 'undefined') toastr.info('没勾选任何块'); return; }
        const keepEl = win.querySelector('#so-fix-keep');
        const merged = mergeKeepTags(keepEl.value, picks);
        keepEl.value = merged;
        setFixCfg({ fixA_keepTags: merged });
        updateFixVerdict();
        if (typeof toastr !== 'undefined') toastr.success('已把 ' + picks.length + ' 个结构块加入保留区');
    });
}

// 采纳扫描建议的作用域标签（写 per-chat 配置，scopeManual=false —— 这是「接受检测建议」非用户手填，之后仍可自纠）+ 刷新输入框 / 判定。
function applyScopeFromScan(tag) {
    setFixCfg({ fixA_scopeTag: tag, fixA_scopeManual: false });
    const el = win && win.querySelector('#so-fix-scope');
    if (el) el.value = tag;
    updateFixVerdict();
    const panel = win && win.querySelector('#so-fix-scan-panel');
    if (panel) panel.hidden = true;
    if (typeof toastr !== 'undefined') toastr.success(tag ? ('作用域已设为 <' + tag + '>') : '作用域已留空（校正整条）');
}

// ✨ 校正模式「自动配置」Phase 7（M4）——把【本聊天】的自动校正设置一键还原成推荐值（作用域 content / 默认目标 /
// 排除区清空 / 收紧开 / 自动关 / scopeManual 清掉）。只动自动那套（fixA_* + autoFixEnabled），手动 fixM_* 不碰。
function resetFixCfg() {
    setFixCfg({
        fixA_scopeTag: 'content', fixA_scopeManual: false,
        fixA_targetSlop: true, fixA_targetDialogue: true, fixA_targetPrecision: true, fixA_targetMagic: false, fixA_targetPacing: true,
        fixA_keepTags: '', fixA_dropTags: '', fixA_knowledgeBoundary: '', fixA_guardrails: '',
        fixA_tighten: true, autoFixEnabled: false,
    });
    seedFixControls();        // 回填控件（含 applyFixModeView → updateFixVerdict）
    updateFixButtonVisual();  // autoFixEnabled 归 false → ✨ 金色指示对齐
    if (typeof toastr !== 'undefined') toastr.success('已恢复本聊天的推荐校正设置');
}

// 经【自定义补全预设】发送时（fixM_/fixA_usePreset，手动 / 自动各自独立），角色卡 / 世界书由预设的 charDescription / worldInfo 标记提供 →
// 校正设置里的「带角色卡 / 带世界书」勾选会被忽略，故置灰（disabled + 变淡 + 悬停说明）。手动 + 自动两组都处理。
// 概要 / 前文仍走 slim 信封（不由预设标记提供），故不灰。
function applyFixPresetLock() {
    if (!win) return;
    const s = getSettings();
    const lockIds = (ids, locked) => {
        for (const id of ids) {
            const el = win.querySelector(id);
            if (!el) continue;
            el.disabled = locked;
            const label = el.closest('label');
            if (label) {
                label.style.opacity = locked ? '0.45' : '';
                label.title = locked ? '已由自定义补全预设的标记提供（角色卡 / 世界书）——预设模式下此项被忽略' : '';
            }
        }
    };
    lockIds(['#so-fixm-card', '#so-fixm-world'], fixUsePresetFor(s, 'manual'));   // 手动组按 fixM_usePreset
    lockIds(['#so-fix-card', '#so-fix-world'], fixUsePresetFor(s, 'auto'));       // 自动组按 fixA_usePreset
}

// 用【本聊天】生效配置（per-chat 覆盖全局）回填校正控件（手动 fixM_* + 自动 fixA_*），并按 fixSettingsView 切视图。
// 控件未建好（窗口未初始化）时静默跳过。
function seedFixControls() {
    if (!win) return;
    const cfg = getEffectiveFixCfg(getSettings(), getFixCfg());
    const set = (id, prop, val) => { const el = win.querySelector(id); if (el) el[prop] = val; };
    // 手动（fixM_*）
    set('#so-fixm-depth', 'value', cfg.fixM_contextDepth);
    set('#so-fixm-card', 'checked', !!cfg.fixM_includeCard);
    set('#so-fixm-world', 'checked', !!cfg.fixM_includeWorld);
    set('#so-fixm-summary', 'checked', !!cfg.fixM_includeSummary);
    // 自动（fixA_*）
    set('#so-fix-tgt-slop', 'checked', !!cfg.fixA_targetSlop);
    set('#so-fix-tgt-dialogue', 'checked', !!cfg.fixA_targetDialogue);
    set('#so-fix-tgt-precision', 'checked', !!cfg.fixA_targetPrecision);
    set('#so-fix-tgt-magic', 'checked', !!cfg.fixA_targetMagic);
    set('#so-fix-tgt-pacing', 'checked', !!cfg.fixA_targetPacing);
    set('#so-fix-scope', 'value', cfg.fixA_scopeTag != null ? cfg.fixA_scopeTag : 'content');   // ✨ 作用域标签（默认 content）
    set('#so-fix-keep', 'value', cfg.fixA_keepTags || '');
    set('#so-fix-drop', 'value', cfg.fixA_dropTags || '');
    set('#so-fix-know', 'value', cfg.fixA_knowledgeBoundary || '');
    set('#so-fix-guard', 'value', cfg.fixA_guardrails || '');
    set('#so-fix-tighten', 'checked', cfg.fixA_tighten !== false);
    set('#so-fix-prompt-version', 'value', (cfg.fixA_promptVersion === 'thorough') ? 'thorough' : 'light');   // ✨ 校正提示词（轻校 / 精校）
    set('#so-fix-prompt-flavor', 'value', (cfg.fixA_promptFlavor === 'opus') ? 'opus' : 'deepseek');           // ✨ 精校侧重（DeepSeek / Opus）
    set('#so-fix-card', 'checked', !!cfg.fixA_includeCard);
    set('#so-fix-ctx', 'checked', !!cfg.fixA_includeContext);
    set('#so-fix-ctx-depth', 'value', cfg.fixA_contextDepth);
    set('#so-fix-world', 'checked', !!cfg.fixA_includeWorld);
    set('#so-fixa-summary', 'checked', !!cfg.fixA_includeSummary);
    set('#so-fix-auto', 'checked', !!cfg.autoFixEnabled);
    set('#so-fixm-preset', 'checked', !!getSettings().fixM_usePreset);   // 全局开关（手动）；不在 cfg / FIX_CFG_KEYS 里
    set('#so-fixa-preset', 'checked', !!getSettings().fixA_usePreset);   // 全局开关（自动）
    applyFixPresetLock();   // 预设模式下置灰「带角色卡 / 带世界书」（由预设标记提供）
    applyFixModeView();
}

// 切聊天时把校正控件重置成新聊天的生效配置（同 loadConvoForChat / loadDiagSelForChat 风格）。
function loadFixCfgForChat() {
    seedFixControls();
    updateFixButtonVisual();   // 切聊天后按本聊天生效的 autoFixEnabled 对齐 ✨ 金色指示
}

// ✨ 校正模式 Phase 4：用全局 fixBundles 的名字填充套餐下拉。窗口打开时 + 每次存 / 删后调用。
function populateFixBundles() {
    if (!win) return;
    const sel = win.querySelector('#so-fix-bundle');
    if (!sel) return;
    const prev = sel.value;
    const bundles = (Array.isArray(getSettings().fixBundles) ? getSettings().fixBundles : []);
    sel.innerHTML = '';
    if (!bundles.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（暂无已存套餐）';
        sel.appendChild(opt);
    } else {
        for (const b of bundles) {
            if (!b || !b.name) continue;
            const opt = document.createElement('option');
            opt.value = b.name;
            opt.textContent = b.name;
            sel.appendChild(opt);
        }
        // 尽量保留原选中项（存 / 删后列表变了仍停在合理位置）。
        if (prev && bundles.some((b) => b && b.name === prev)) sel.value = prev;
    }
}

// 让选条目器 UI（两个开关 + 可见性 + 列表）与本聊天元数据对齐。进入诊断模式 / 切聊天时调用。
function refreshDiagPickerUI() {
    if (!win || !ENABLE_DIAG_WI_PICKER) return;
    const meta = getDiagWiMeta();
    const useBox = win.querySelector('#so-diag-usesel');
    const hybBox = win.querySelector('#so-diag-hybrid');
    if (useBox) useBox.checked = meta.use;
    if (hybBox) hybBox.checked = meta.hybrid;
    reflectDiagPickerVisible(meta.use);
    if (meta.use && diagnoseMode) populateDiagWiBooks();
}

function formatPrompt(msgs) {
    return msgs.map((m) => {
        const role = (m.role || '?').toUpperCase();
        return `┌─────────── ${role} ───────────\n${m.content || ''}`;
    }).join('\n\n');
}

function openDebug() {
    const panel = win.querySelector('#so-debug');
    const body = win.querySelector('#so-debug-body');
    const meta = win.querySelector('#so-debug-meta');
    if (!lastPrompt || !lastPrompt.length) {
        meta.textContent = '';
        body.textContent = '还没有发送过任何提示词。请先向故事神谕提问，然后再打开此面板。';
    } else {
        meta.textContent = lastPromptMeta
            ? `· ${lastPromptMeta.mode} · ${lastPromptMeta.target} · ${lastPromptMeta.chars.toLocaleString()} chars · ${lastPromptMeta.time}`
            : '';
        body.textContent = formatPrompt(lastPrompt);
    }
    panel.classList.add('open');
    body.scrollTop = 0;
}

/* ------------------------------------------------------------------ *
 * Context assembly
 * ------------------------------------------------------------------ */
function buildSystemPrompt() {
    const ctx = getCtx();
    const s = getSettings();

    if (diagnoseMode) return buildDiagnosePrompt(ctx, s);
    if (lorebookMode) return buildLorebookPrompt(ctx, s);
    if (advisorMode) return buildAdvisorPrompt(ctx, s);
    if (fixMode) return buildFixPrompt(ctx, s);

    const parts = [resolveSystemPrompt(s)];

    const personaBlock = buildPersonaBlock(s.personaId);
    if (personaBlock) parts.push(personaBlock);

    if (s.includeCard) {
        parts.push(buildCardSection(ctx));
    }

    if (worldInfoBlock) {
        parts.push('=== 世界书 / 设定 ===\n' + worldInfoBlock);
    }

    parts.push(buildChatStatSection());
    parts.push(buildChatWorldSection());

    // 用户功能请求：运行概要插在最近对话记录的正前方。
    const summarySection = buildSummarySection(getSummary());
    if (summarySection) parts.push(summarySection);

    const transcript = buildTranscript(ctx, s);
    if (transcript) {
        parts.push('=== 故事对话记录（最新的在最后）===\n' + transcript);
    }

    const full = parts.filter(Boolean).join('\n\n');
    try { return ctx.substituteParams(full); } catch (e) { return full; }
}

// 普通模式的变量数值纪律（v1.14.6）。两种姿态、绝无中间态：
// 有权威状态 -> 给全量数值 + 「剧情里的旧数值一律以此为准」（状态栏残影免疫）；
// 无权威状态 -> 明令如实拒答具体数值。LLM 被问数值时默认编一个像样的，
// 这一段就是把「编」这条路堵死。
function buildChatStatSection() {
    if (chatStatData) {
        return '=== 当前变量状态（stat_data —— 唯一权威数值）===\n' + chatStatData +
            '\n（用户问数值时以上方为准；剧情文字 / 状态栏里出现的任何数值都可能是旧的，一律不要采信。）';
    }
    return '（注意：你看不到实时变量数值（好感度、金钱等状态数据）。用户问具体数值时，如实说明无法查看精确数值，建议用诊断或剧情参谋模式查询；可以根据剧情做定性判断（关系变暖 / 资源吃紧），但绝不要编造具体数字。）';
}

// ===== 外部扩展世界信息桥接（用户功能请求）=========================================
// 让神谕读到「住在别的扩展自己系统里」的世界信息——主聊天与 MVU 之外、神谕原本看不到的后台世界。
// 两路来源：
//   (1) 内置「世界引擎」适配器：直接读 window.WORLD_ENGINE_CORE（官方原版与 Edwin 的 World-mod 同名全局）。
//       仅当该聊天确有落盘状态（hasState）时才喂——loadState() 在无状态时只返回空的默认世界，喂它没意义。
//       按用户选择喂【完整 state JSON】（含全部字段，包括 blackbox 私密层）。
//   (2) 通用注册表 window.__ST_CONTEXT_PROVIDERS__：任何扩展可 push({ name, getContext })，getContext()
//       返回字符串或对象。将来别的扩展无需改神谕即可接入——三行注册即可。
// 全程 try/catch + 全局存在性判断：相关扩展没装 / 没加载时安静返回空、零副作用（仿 getMvuStatData 的写法）。
function getExternalWorldBlocks() {
    const blocks = [];

    // (1) 世界引擎 / World-mod
    try {
        const we = window.WORLD_ENGINE_CORE;
        if (we && typeof we.loadState === 'function' &&
            (typeof we.hasState !== 'function' || we.hasState())) {
            const state = we.loadState();
            if (state && typeof state === 'object') {
                blocks.push({ name: '世界引擎（World Engine）', text: JSON.stringify(state, null, 2) });
            }
        }
    } catch (e) { console.warn('[Story Oracle] 读取世界引擎状态失败:', e); }

    // (2) 通用上下文提供者注册表（任何扩展可自行注册）
    try {
        const providers = window.__ST_CONTEXT_PROVIDERS__;
        if (Array.isArray(providers)) {
            for (const p of providers) {
                if (!p || typeof p.getContext !== 'function') continue;
                try {
                    const out = p.getContext();
                    const text = (out == null) ? ''
                        : (typeof out === 'string' ? out : JSON.stringify(out, null, 2));
                    if (text && text.trim()) {
                        blocks.push({ name: String(p.name || '外部扩展'), text: text });
                    }
                } catch (e) { console.warn('[Story Oracle] 外部上下文提供者出错:', p && p.name, e); }
            }
        }
    } catch (e) { console.warn('[Story Oracle] 读取上下文提供者注册表失败:', e); }

    return blocks; // [{ name, text }, ...]
}

// 把各来源拼成一段文本（每段带「来源」小标题），无任何来源时返回 ''。在 generateReply 里算好、存进
// chatWorldData；buildChatWorldSection 负责加外层大标题。拆两步与 stat_data 那套写法保持一致。
function assembleExternalWorld() {
    const blocks = getExternalWorldBlocks();
    if (!blocks.length) return '';
    return blocks.map((b) => `--- 来源：${b.name} ---\n${b.text}`).join('\n\n');
}

// 外部世界信息区块。无数据时返回 ''（被 parts.filter(Boolean) / pushMsg 跳过）——与参谋的 stat_data
// 一样属「可选情报，没有就整段省略」，不像普通模式 stat 那样留拒答占位。
function buildChatWorldSection() {
    if (!chatWorldData) return '';
    return '=== 其它扩展维护的世界信息（由扩展系统提供，是主聊天之外、神谕本来看不到的后台世界状态——'
        + '可据此回答与剧情世界相关的问题；其中的数值若与上方 MVU stat_data 冲突，以 stat_data 为准）===\n'
        + chatWorldData;
}

// 用户功能请求：用户粘贴的运行概要 / 前情提要（本聊天）。在【普通聊天】与【剧情参谋】模式下
// 插入到最近对话记录的正前方——填补「有总结但存在预设 / 世界书 / 主聊天之外」、神谕本来读不到
// 的那段故事。纯函数（文本入参），可单测：空串回空串（调用处用 if/pushMsg 跳过）；末尾的
// substituteParams 由各调用方统一处理。
function buildSummarySection(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    return '=== 剧情概要 / 前情提要（用户提供，是最近对话之前的故事梗概，供你理解来龙去脉）===\n' + t;
}

function buildDiagnosePrompt(ctx, s) {
    // 手动诊断模式：用 generateReply 现算好的模块状态变量。
    return buildDiagnosePromptFrom(ctx, s, {
        wiBlock: worldInfoBlock, statStr: diagStatData, latestBlock: diagLatestUpdate,
    });
}

// 纯函数：把可选上下文块（角色卡 / 激活世界书 / 前文）+ 待校正正文拼成校正调用信封。空块省略；
// <text_to_transform> 始终存在。顺序：characters → world_info → scene_context → text_to_transform。可单测。
function buildFixEnvelope(blocks) {
    const b = blocks || {};
    const parts = [];
    const card = String(b.card || '').trim();
    const world = String(b.world || '').trim();
    const summary = String(b.summary || '').trim();   // 📜剧情概要 / 前情提要（用户提供）
    const context = String(b.context || '').trim();
    if (card) parts.push('<characters>\n' + card + '\n</characters>');
    if (world) parts.push('<world_info>\n' + world + '\n</world_info>');
    // 概要在前情、scene_context 是最近对话——按时间线放在世界书之后、最近对话之前。
    if (summary) parts.push('<story_summary>\n' + summary + '\n</story_summary>');
    if (context) parts.push('<scene_context>\n' + context + '\n</scene_context>');
    parts.push('<text_to_transform>\n' + String(b.reply || '').trim() + '\n</text_to_transform>');
    return parts.join('\n\n');
}

// 校正系统提示 = 基础规则（可被 s.fixSystemPrompt 覆盖，空 = 用内置常量）+ 内嵌的【待校正正文】。
function buildFixPrompt(ctx, s) {
    const override = (s.fixSystemPrompt || '').trim();
    // 自动分支：精校（thorough）时用 resolveFixAutoPrompt 选侧重提示；轻校（light，默认）时保持现行「收紧 toggle」行为不变。
    const base = override || (fixActiveMode === 'manual'
        ? FIX_SYSTEM_PROMPT_MANUAL
        : (fixAutoPromptVersion === 'thorough'
            ? resolveFixAutoPrompt({ promptVersion: fixAutoPromptVersion, promptFlavor: fixAutoPromptFlavor })
            : (fixTightenActive ? FIX_SYSTEM_PROMPT_TIGHTEN : FIX_SYSTEM_PROMPT)));
    let subst = (t) => t;
    if (ctx && typeof ctx.substituteParams === 'function') {
        subst = (t) => { try { return ctx.substituteParams(t); } catch (e) { return t; } };
    }
    const reply = fixTargetProse || '（未捕获到待校正的回复——请确认主聊天里已有一条 AI 回复）';
    const envelope = buildFixEnvelope({ card: fixCardBlock, world: fixWorldBlock, summary: fixSummaryBlock, context: fixContextBlock, reply });
    let prompt = subst(base) + '\n\n' + envelope;
    // 排除·保留区：正文里嵌了 ⟦SO_KEEP_n⟧ 占位锚点时，明确要求模型原样留在原位（弄丢了由 composeFixedReply 兜底接回）。
    if (Array.isArray(fixExtraKeep) && fixExtraKeep.length) {
        prompt += '\n\n【保留区锚点】<text_to_transform> 里形如 ⟦SO_KEEP_数字⟧ 的标记是系统占位锚点（用户「保留区」的内容已被抽走，稍后会按标记位置原样接回）：必须【原样保留、留在它出现的位置】，绝不改写、移动、合并或删除——它不是要校正的内容；正文其余照常校正。';
    }
    return prompt;
}

// 无状态版诊断提示词构建器（用入参而非模块变量）——这样「自动诊断」后台运行能自建提示词、
// 不与窗口共享的 worldInfoBlock/diagStatData/diagLatestUpdate 抢状态。keepMechanism 这里强制
// 为 true：诊断是唯一需要读 <UpdateVariable> 区块的模式。
//
// auto=true 时进入「自动诊断」双模（见 ADDENDUM）：回复里有更新区块就核验修正；没有区块就把这条
// 回复的正文当输入、据 MVU 规则【推导】出本回合应有的更新——即充当 MVU「额外模型解析」的替代品
// （那也是每回合用另一个模型从回复里抽更新；二者择一，绝不并用——见首开警告）。latestReply 是这条
// AI 回复的正文（仅在没有更新区块的推导情形用到）。手动诊断 auto 缺省为假，行为与原先完全一致。
function buildDiagnosePromptFrom(ctx, s, { wiBlock, statStr, latestBlock, latestReply, auto }) {
    const parts = [resolveModePrompt(s, 'diagnose')];

    // 自动诊断附则：基础诊断提示词假设「当前状态已反映最新更新」——这在【没有区块、需从正文推导】
    // 的情形里是错的（没有任何机制写过这条回复）。下面这段把两种情形讲清，并推翻那个假设。
    if (auto) {
        parts.push(
            '【自动诊断模式 —— 重要】这是一次后台自动诊断，时机是一条新 AI 回复刚到、其变量更新可能还没被任何机制写入。按以下两种情形之一处理：\n'
            + '（甲）若下面「最新更新区块」里给出了 <UpdateVariable>：当前状态已反映该更新，按既定规则核验并最小化修正它（仍以当前状态为事实依据）。\n'
            + '（乙）若没有给出更新区块、只给了「最新一条 AI 回复」正文：说明本回合的变量更新【还没有】被写入，当前状态【尚未】包含这条回复带来的变化。请你充当变量更新引擎——通读这段回复，依角色卡 MVU 规则与当前状态，推导出本回合【应当】发生的全部变量更新（好感度增减、物品获得 / 消耗、时间推进、地点 / 状态变化……），生成 <UpdateVariable> 补丁把状态更新到这条回复之后的正确值。只依据回复里确凿发生的事，绝不脑补没写的细节。\n'
            + '两种情形都遵循下方输出规则；确实没有任何变量需要变动时，输出空的 JSONPatch（[]）。',
        );
    }

    // World info carries the card's MVU rules (blue/constant entries always fire).
    parts.push('=== 角色卡 MVU 规则（来自世界书）===\n' +
        (wiBlock || '（未找到世界书规则 —— 诊断结果可能不完整）'));

    parts.push('=== 当前变量状态（stat_data）===\n' +
        (statStr || '（不可用 —— 未检测到 MVU 框架）'));

    if (latestBlock) {
        parts.push('=== 最新更新区块（待检查的更新）===\n' + latestBlock);
    } else if (auto && latestReply) {
        // 推导情形：把整条回复正文交给模型，明确「正文里没有更新区块、请据此推导」。
        parts.push('=== 最新一条 AI 回复（正文里【没有】变量更新区块——请据这段剧情、依 MVU 规则与当前状态，推导出本回合应当发生的全部变量更新）===\n' + latestReply);
    } else {
        parts.push('=== 最新更新区块（待检查的更新）===\n（在最新一条 AI 回复中未找到 <UpdateVariable> 区块）');
    }

    if (s.includeCard) parts.push(buildCardSection(ctx));

    const transcript = buildTranscript(ctx, s, /*keepMechanism*/ true);
    if (transcript) parts.push('=== 故事对话记录（最新的在最后）===\n' + transcript);

    const full = parts.filter(Boolean).join('\n\n');
    try { return ctx.substituteParams(full); } catch (e) { return full; }
}

function buildLorebookPrompt(ctx, s) {
    const parts = [resolveModePrompt(s, 'lorebook')];

    // 说话人格（仅当用户主动选了某个人格时）：管家指令之上叠一层语气皮肤，
    // 附带职责调整 + 结构保护（区块格式与围栏正文不受人格影响）。
    const personaBlock = buildPersonaBlock(s.personaId, 'lorebook');
    if (personaBlock) parts.push(personaBlock);

    parts.push('=== 当前世界书内容 ===\n' +
        (lbContextText || '（未读取到世界书 —— 请检查上方的选择。）'));

    if (s.lorebookIncludeStory) {
        const transcript = buildTranscript(ctx, s);
        if (transcript) parts.push('=== 最近的故事对话记录（仅供参考，最新的在最后）===\n' + transcript);
    }

    // Note: lbContextText is already substituteParams'd; the system prompt itself
    // has no macros, so no further substitution is needed (and would risk
    // mangling literal braces inside entry content).
    return parts.filter(Boolean).join('\n\n');
}

// 把【当前正在引导的弧线】渲染成参谋上下文（供”检查进度”等对话）。since = 自本拍采用以来的主聊天
// 消息数，由调用方注入（保持纯函数、可 jsdom 单测，同弧线纯函数层把”时钟”作参数的约定）。两种模式分流：
//   透明弧——全可见：贯穿线 + 当前拍幕后 goal/seed + 逐拍强度 + 路标进度，参谋可畅所欲言。
//   盲盒弧——只交出玩家自己也看得到的 objective + 难度 + 已解决拍数，【绝不】交出幕后 goal/seed/贯穿线/路标
//   意图（拿不到就漏不了），并附「盲盒守则」：回答只用任务/过程语言，不点名幕后目标或未揭晓事件（守软保密）。
function buildAdvisorArcBlock(arc, since) {
    if (!arc || !Array.isArray(arc.waypoints)) return '';
    const beat = arc.currentBeat || null;
    const sinceN = Math.max(0, Number(since) || 0);
    if (arc.mode === 'blind') {
        const c = arc.consent || {};
        const diff = ADVISOR_DIFFICULTIES[c.difficulty] || ADVISOR_DIFFICULTIES.normal;
        const task = beat ? arcVisibleObjective(beat) : '';
        const lines = [
            '=== 当前正在引导的剧情弧线（盲盒弧 · 正在引导主聊天）===',
            `难度 / 赌注层级：${diff.label}（${diff.caption}）`,
        ];
        if (task) lines.push(`玩家当前的任务（objective，玩家自己也看得到）：${task}`);
        lines.push(`已解决拍数：${(arc.revealed || []).length}　·　已持续：${sinceN} 条主聊天消息`);
        lines.push(
            '【盲盒守则 —— 回答用户时务必遵守】这是一条「盲盒」弧线：你看不到、也绝不可编造或点名幕后目标（goal）、'
            + '起始迹象、贯穿线或任何未揭晓的转折 / 结局——上面只给了玩家自己也看得到的任务。用户问进度 / 接下来怎么走时，'
            + '只用「任务（过程）」语言如实回答：铺垫是否已经露头、当前任务离达成还差哪一步（例如「铺垫已经露头，但关键事件还没正面发生」），'
            + '绝不替他剧透幕后在做什么。若用户明说想直接看幕后内容，请提示他在方案条上点开「查看注入内容」的防剧透遮罩自行揭开——由他主动，而不是你说破。',
        );
        return lines.join('\n');
    }
    // 透明弧：全可见。
    const I = ADVISOR_INTENSITIES[(beat && beat.intensity)] || ADVISOR_INTENSITIES.normal;
    const total = arc.waypoints.length;
    const doneCount = arc.waypoints.filter((w) => w && w.status === 'done').length;
    const wpList = arc.waypoints.map((w, i) => {
        const tag = w.status === 'done' ? '[已完成]'
            : (w.status === 'active' ? '【当前】'
                : (w.status === 'skipped' ? '[已跳过]' : '[待办]'));
        return `${i + 1}. ${tag} ${w.intent}`;
    }).join('\n');
    const lines = [
        '=== 当前正在引导的剧情弧线（透明弧 · 正在引导主聊天）===',
        `贯穿线：${arc.throughline || '（未填）'}`,
        `进度：第 ${Math.min(doneCount + 1, total)} / ${total} 拍（路标）　·　已持续：${sinceN} 条主聊天消息`,
    ];
    if (beat) {
        lines.push(`当前这一拍的幕后目标：${beat.goal}`);
        if (beat.seed) lines.push(`起始迹象：${beat.seed}`);
        lines.push(`强度：${I.label}（${I.caption}）`);
    }
    lines.push(`路标列表：\n${wpList}`);
    return lines.join('\n');
}

// 参谋模式提示词：参谋指令 + 人格（若选）+ 当前引导构件（单拍 异或 弧线，若有，供”检查进度”
// 用）+ 角色卡 + 世界书 + 【整段】对话记录。无论全局上下文深度设成多少，参谋
// 都看全史——只看最近十几条提出的方案会漏掉长线伏笔。
function buildAdvisorPrompt(ctx, s) {
    const parts = [resolveModePrompt(s, 'advisor')];   // 用户在设置里自定义了就用其覆盖，否则用内置 ADVISOR_SYSTEM_PROMPT

    // 说话人格（仅当用户主动选了某个人格时）：参谋指令之上叠语气皮肤，附带
    // 职责调整（构思未来剧情正是本职，不算「擅自续写」）+ 结构保护。
    const personaBlock = buildPersonaBlock(s.personaId, 'advisor');
    if (personaBlock) parts.push(personaBlock);

    // 当前正在引导主聊天的构件：弧线 异或 单拍（§4 不变量）。参谋拿到它才能回答"检查进度"。
    // 弧线走 buildAdvisorArcBlock（盲盒分支只给 objective + 难度 + 防剧透守则，绝不交出幕后 goal）。
    const arc = ENABLE_ARC ? getArc() : null;
    if (arc) {
        const beatAt = (arc.currentBeat && arc.currentBeat.beatAdoptedAt) || arc.adoptedAt || 0;
        parts.push(buildAdvisorArcBlock(arc, Math.max(0, chatMsgCount() - beatAt)));
    } else {
        const plan = getPlan();
        if (plan) {
            const I = ADVISOR_INTENSITIES[plan.intensity] || ADVISOR_INTENSITIES.normal;
            const since = Math.max(0, chatMsgCount() - (plan.adoptedAt || 0));
            parts.push('=== 当前已采用的引导方案（正在引导主聊天）===\n' +
                `${plan.title ? `标题：${plan.title}\n` : ''}目标：${plan.goal}\n` +
                (plan.seed ? `起始迹象：${plan.seed}\n` : '') +
                `强度：${I.label}（${I.caption}）\n` +
                `已持续：${since} 条主聊天消息`);
        }
    }

    if (s.includeCard) parts.push(buildCardSection(ctx));

    // 变量状态：剧情的硬事实层。有 MVU 时给出，方案必须与数值现状自洽
    //（好感度还没到的别提结婚，钱包空的别提一掷千金）；无 MVU 卡时整段省略，
    // 不显示“不可用”占位——这对参谋是可选情报，不是诊断那样的必需输入。
    if (advStatData) {
        parts.push('=== 当前变量状态（stat_data，来自 MVU —— 剧情推进到此刻的实时数值）===\n' + advStatData);
    }

    // 外部扩展世界信息（世界引擎等）——参谋规划须知道后台正在酝酿的事件 / 势力动向（用户功能请求）。
    parts.push(buildChatWorldSection());

    if (worldInfoBlock) {
        parts.push('=== 世界书 / 设定 ===\n' + worldInfoBlock);
    }

    // 用户功能请求：运行概要插在完整对话记录的正前方（参谋本就读全程，对超长聊天仍有帮助）。
    const summarySection = buildSummarySection(getSummary());
    if (summarySection) parts.push(summarySection);

    // Full history, regardless of the shared contextDepth setting.
    const transcript = buildTranscript(ctx, { ...s, contextDepth: -1 });
    if (transcript) {
        parts.push('=== 完整故事对话记录（最新的在最后）===\n' + transcript);
    }

    const full = parts.filter(Boolean).join('\n\n');
    try { return ctx.substituteParams(full); } catch (e) { return full; }
}

function buildCardSection(ctx) {
    const cardLines = [];
    try {
        const f = ctx.getCharacterCardFields();
        if (ctx.name2) cardLines.push(`角色：${ctx.name2}`);
        if (ctx.name1) cardLines.push(`用户 / Persona：${ctx.name1}`);
        if (f.description) cardLines.push(`描述：\n${f.description}`);
        if (f.personality) cardLines.push(`性格：\n${f.personality}`);
        if (f.scenario) cardLines.push(`场景：\n${f.scenario}`);
        if (f.persona) cardLines.push(`Persona：\n${f.persona}`);
    } catch (e) { /* group chat or no char selected */ }
    return cardLines.length ? '=== 角色 / 设定 ===\n' + cardLines.join('\n\n') : '';
}

// 一条主聊天消息是否进入喂给神谕的剧情记录。默认排除 /hide 的隐藏楼层（is_system）；
// includeHidden（用户设置 includeHiddenFloors）勾选后纳入。纯谓词，便于单测。
function messageVisibleForTranscript(m, includeHidden) {
    return !!m && (includeHidden || !m.is_system) && typeof m.mes === 'string';
}

// Story-context turns as role-tagged objects {role:'user'|'assistant', name, text}.
// Mirrors ST's prompt builder: drop system messages, run each through the regex
// engine (isPrompt, depth relative to full chat), trim empties, take last N.
function buildTranscriptTurns(ctx, s, keepMechanism = diagnoseMode) {
    if (s.contextDepth === 0) return [];
    const coreChat = (ctx.chat || []).filter((m) => messageVisibleForTranscript(m, s.includeHiddenFloors));
    const useRegex = s.applyRegex && regexEngine && regexEngine.getRegexedString;

    let processed = coreChat.map((m, index) => {
        let text = m.mes;
        if (useRegex) {
            const placement = m.is_user
                ? regexEngine.regex_placement.USER_INPUT
                : regexEngine.regex_placement.AI_OUTPUT;
            const depth = coreChat.length - index - 1; // last message = depth 0
            try {
                text = regexEngine.getRegexedString(text, placement, { isPrompt: true, depth });
            } catch (e) {
                console.warn('[Story Oracle] regex failed on a message; using raw.', e);
            }
        }
        return {
            role: m.is_user ? 'user' : 'assistant',
            name: m.name || (m.is_user ? ctx.name1 : ctx.name2),
            // v1.14.5：主聊天消息里嵌着的 <UpdateVariable> 是【增量】不是【状
            // 态】——普通/参谋模式的模型看到「好感度+5」这种碎片、又没有权威
            // 基线，就会自信地推算出离谱数值。除诊断模式外（读这些区块正是诊
            // 断的本职），一律从喂给神谕的剧情记录里剥掉。整条消息只剩区块时
            // 会变成空串，被下方的过滤器自然丢弃。
            text: keepMechanism ? text : stripMechanismBlocks(text),
        };
    });

    processed = processed.filter((l) => l.text && l.text.trim() !== '');
    if (s.contextDepth > 0) processed = processed.slice(-s.contextDepth);
    return processed;
}

function buildTranscript(ctx, s, keepMechanism) {
    return buildTranscriptTurns(ctx, s, keepMechanism).map((l) => `${l.name}: ${l.text}`).join('\n\n');
}

// v1.14.1 修复：用户预设里常带「每条回复末尾必须输出 <UpdateVariable>」的输出
// 契约（MVU 卡），忠实组装会让神谕也继承它——于是神谕的回复尾巴上挂出一个对
// 主聊天毫无意义的机制区块（“Variables remain unchanged”之类）。主聊天里这
// 些区块由 MVU 自己的管线消化隐藏，神谕没有那条管线，所以原样可见，还会写进
// 神谕历史让后续回合越锁越死。普通 / 参谋模式下从显示与历史两头剥掉它；诊断
// 模式绝不剥（读这些区块正是诊断的本职）。
// v1.14.5 起也用于【喂入神谕的主聊天剧情记录】（见 buildTranscriptTurns）：
// 消息里的更新区块是增量不是状态，留着只会诱导模型瞎报数值。
function stripMechanismBlocks(text) {
    let out = String(text || '');
    out = out.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '');
    // 被截断、没闭合的尾部区块也剥掉（开标签一路到结尾）。
    out = out.replace(/<UpdateVariable>[\s\S]*$/i, '');
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

// 思维链（CoT）标签——某些自定义补全预设或推理模型会把 <think> / <thinking> 这类
// 思考区块直接吐进回复正文里。主聊天靠自带管线把它们藏起来，神谕没有那条管线，于是
// 它们会原样显示在气泡里；用户的「清理思维链」正则往往是按某一个预设调的，常常漏网。
// 所以这里做一道内置兜底，用在普通 / 参谋模式的回复上（显示 + 历史两头都剥）。诊断 /
// 世界书模式不走这里（它们各自带 <UpdateVariable> / <LorebookEdit> 区块，需原样保留）。
const REASONING_TAGS = ['think', 'thinking', 'thought', 'reasoning', 'reflection', 'cot'];

function stripReasoningTags(text) {
    let out = String(text || '');
    for (const tag of REASONING_TAGS) {
        // 1) 成对区块（大小写不敏感、跨行、容忍属性）——最常见的情况，连内容一起删。
        out = out.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi'), '');
        // 2) 被截断、没闭合的开标签——从开标签一路删到结尾（同 stripMechanismBlocks）。
        out = out.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*$', 'i'), '');
        // 3) 任何残留的孤立标签（如推理放在单独字段、只漏出一个 </think>）——只删标签本身、
        //    保留周围文字，确保标签字面量绝不残留在屏幕上。
        out = out.replace(new RegExp('<\\/?' + tag + '\\b[^>]*>', 'gi'), '');
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

// Run a finished Oracle reply through the enabled AI_OUTPUT regex.
//   forPrompt=true  -> prompt stage (what ST feeds back into context); used for
//                      the copy stored in history, so the Oracle doesn't
//                      re-ingest its own think tags / status bars next turn.
//   forPrompt=false -> display stage (markdown); rarely needed directly because
//                      renderReplyHtml() applies it via ST's own formatter.
function applyOutputRegex(text, forPrompt) {
    if (!regexEngine || !regexEngine.getRegexedString || !regexEngine.regex_placement) return text;
    try {
        const opts = forPrompt
            ? { isPrompt: true, isMarkdown: false, depth: 0 }
            : { isPrompt: false, isMarkdown: true, depth: 0 };
        const out = regexEngine.getRegexedString(String(text || ''), regexEngine.regex_placement.AI_OUTPUT, opts);
        return (typeof out === 'string') ? out : text;
    } catch (e) {
        console.warn('[Story Oracle] output regex failed; using raw reply.', e);
        return text;
    }
}

// Render a reply to sanitized HTML using ST's OWN message formatter — the same
// path main chat uses — so display-stage regex, markdown, and HTML/CSS widgets
// (e.g. a status-bar beautifier) render identically here. Returns null if the
// formatter isn't available, signaling the caller to fall back to plain text.
let soMdConverter = null;
// 只渲染 Markdown（不跑 ST 正则引擎）——用于普通聊天【关闭「应用正则」】时的显示。showdown + DOMPurify 均由 ST 挂在 window 上。
// 拿不到库时返回 null，调用方回退纯文本（jsdom 无这两个库 → null → textContent，安全）。
function renderMarkdownOnly(text) {
    try {
        if (!soMdConverter && typeof window !== 'undefined' && window.showdown) {
            soMdConverter = new window.showdown.Converter({ simpleLineBreaks: true, strikethrough: true, tables: false, literalMidWordUnderscores: true });
        }
        if (soMdConverter && typeof window !== 'undefined' && window.DOMPurify) {
            const html = window.DOMPurify.sanitize(soMdConverter.makeHtml(String(text || '')));
            if (typeof html === 'string' && html) return html;
        }
    } catch (e) {
        console.warn('[Story Oracle] markdown render failed; showing raw text.', e);
    }
    return null;
}
function renderReplyHtml(text) {
    const ctx = getCtx();
    try {
        if (typeof ctx.messageFormatting === 'function') {
            const html = ctx.messageFormatting(String(text || ''), ctx.name2 || '故事神谕', false, false, null);
            if (typeof html === 'string' && html) return html;
        }
    } catch (e) {
        console.warn('[Story Oracle] messageFormatting failed; showing raw text.', e);
    }
    return null;
}

function buildMessages() {
    const s = getSettings();
    if (lorebookMode && s.lorebookUsePreset && presetCurationActive(s)) {
        return buildLorebookPresetMessages(s);
    }
    if (advisorMode && s.advisorUsePreset && presetCurationActive(s)) {
        return buildAdvisorPresetMessages(s);
    }
    if (fixMode && fixUsePresetFor(s, 'manual') && presetCurationActive(s)) {
        return buildFixPresetMessages(s);   // 自由发挥（手动）：用户那句话在 convoForPrompt() 里，directive 省略
    }
    if (!diagnoseMode && !lorebookMode && !advisorMode && !fixMode && presetCurationActive(s)) {
        return buildPresetMessages(s);
    }
    return [{ role: 'system', content: buildSystemPrompt() }, ...convoForPrompt()];
}

/* ------------------------------------------------------------------ *
 * Faithful, marker-aware, role-preserving assembly from a curated preset.
 *
 * Walks the frozen snapshot in order. Text blocks become messages with their
 * own role; marker blocks expand IN PLACE with the Oracle's own context. The
 * chatHistory slot expands to story-context turns followed by the Oracle's own
 * Q&A turns (per the user's choice). Each text block runs through
 * substituteParams, so getvar/setvar resolve live (setvar self-heals on the
 * next main-chat turn). The built-in short prompt / textarea is never used here.
 * ------------------------------------------------------------------ */
function subst(ctx, text) {
    try { return ctx.substituteParams(String(text || '')); } catch (e) { return String(text || ''); }
}

// Push a message, coalescing into the previous one if roles match — keeps the
// array clean without changing meaning.
function pushMsg(out, role, content) {
    const c = (content == null) ? '' : String(content);
    if (!c.trim()) return;
    out.push({ role: role || 'system', content: c });
}

function expandMarker(out, identifier, ctx, s) {
    let card = {};
    try { card = ctx.getCharacterCardFields() || {}; } catch (e) { /* group / none */ }
    switch (identifier) {
        case 'personaDescription':
            pushMsg(out, 'system', subst(ctx, card.persona || (ctx.name1 ? `用户 / Persona：${ctx.name1}` : '')));
            break;
        case 'charDescription':
            pushMsg(out, 'system', subst(ctx, card.description || ''));
            break;
        case 'charPersonality':
            pushMsg(out, 'system', subst(ctx, card.personality || ''));
            break;
        case 'scenario':
            pushMsg(out, 'system', subst(ctx, card.scenario || ''));
            break;
        case 'worldInfoBefore':
            pushMsg(out, 'system', subst(ctx, wiBefore));
            break;
        case 'worldInfoAfter':
            pushMsg(out, 'system', subst(ctx, wiAfter));
            break;
        case 'dialogueExamples':
            pushMsg(out, 'system', subst(ctx, card.mesExamples || ''));
            break;
        case 'chatHistory': {
            // Authoritative variable state (or the honest-refusal caveat) rides
            // just ahead of the story context — same discipline as plain mode.
            pushMsg(out, 'system', buildChatStatSection());
            pushMsg(out, 'system', buildChatWorldSection());
            // 用户功能请求：运行概要紧贴故事记录之前（仅普通模式经此 marker；参谋 / 世界书
            // 预设各走自己的 placeAdv / placeLore，不经这里）。
            pushMsg(out, 'system', buildSummarySection(getSummary()));
            // Story context first, then the Oracle's own Q&A — as real turns.
            for (const t of buildTranscriptTurns(ctx, s)) {
                pushMsg(out, t.role, t.text);
            }
            for (const m of convoForPrompt()) pushMsg(out, m.role, m.content);
            break;
        }
        default:
            break;
    }
}

function buildPresetMessages(s) {
    const ctx = getCtx();
    const snap = getCuratedSnapshot(s, s.sysPromptPresetName);
    const items = (snap && snap.items) || [];
    const out = [];

    // Optional voice-persona layer, off by default in preset mode. When chosen,
    // it leads as a top-level voice directive; the preset still governs content.
    const personaBlock = buildPersonaBlock(s.personaId);
    if (personaBlock) pushMsg(out, 'system', subst(ctx, personaBlock));

    let sawHistory = false;
    for (const it of items) {
        if (it.kind === 'marker') {
            if (it.identifier === 'chatHistory') sawHistory = true;
            expandMarker(out, it.identifier, ctx, s);
        } else {
            pushMsg(out, it.role || 'system', subst(ctx, it.content));
        }
    }

    // If the curation dropped the chatHistory slot, the Oracle still needs the
    // story + the question — append them so it never sends a question with no
    // context and no final user turn.
    if (!sawHistory) {
        pushMsg(out, 'system', buildSummarySection(getSummary()));
        for (const t of buildTranscriptTurns(ctx, s)) pushMsg(out, t.role, t.text);
        for (const m of convoForPrompt()) pushMsg(out, m.role, m.content);
    }

    return out.length ? out : [{ role: 'system', content: subst(ctx, '（预设无可用内容）') }, ...convoForPrompt()];
}

/* ------------------------------------------------------------------ *
 * Lorebook mode THROUGH a curated preset (opt-in: s.lorebookUsePreset).
 *
 * We keep the preset's TEXT blocks (its jailbreak / formatting / framing) and
 * drop the RP-content markers (card / persona / world-info / examples) — those
 * are irrelevant to editing a world book and would pull attention onto the RP.
 * The lore-manager directive (LOREBOOK_SYSTEM_PROMPT + the current book content,
 * via buildLorebookPrompt) plus the side-chat Q&A go where the chat history would
 * sit, so a post-history jailbreak block still lands last.
 * ------------------------------------------------------------------ */
function buildLorebookPresetMessages(s) {
    const ctx = getCtx();
    const snap = getCuratedSnapshot(s, s.sysPromptPresetName);
    const items = (snap && snap.items) || [];
    const out = [];

    const loreBlock = buildLorebookPrompt(ctx, s);  // directive + book (+ optional transcript)
    let placed = false;
    const placeLore = () => {
        if (placed) return;
        pushMsg(out, 'system', loreBlock);
        for (const m of convoForPrompt()) pushMsg(out, m.role, m.content);
        placed = true;
    };

    for (const it of items) {
        if (it.kind === 'marker') {
            if (it.identifier === 'chatHistory') placeLore();
            // every other marker is skipped in lore mode
        } else {
            pushMsg(out, it.role || 'system', subst(ctx, it.content));
        }
    }
    placeLore(); // no chatHistory marker in the curation -> append at the end

    return out.length ? out : [{ role: 'system', content: loreBlock }, ...convoForPrompt()];
}

/* ------------------------------------------------------------------ *
 * 校正模式（手动 + 自动）THROUGH a curated preset（opt-in: fixM_/fixA_usePreset，各自独立；仅破限 / 越狱用）。
 * 保留预设的【文本块（含其角色——破限 / 框架 / 格式 / few-shot 都照旧）】，并【展开 RP 内容标记】（charDescription /
 * worldInfo / scenario / 示例 / 人格 照预设位置 expandMarker）——这样校正模型能看到角色卡 / 世界书（改对话 / 知不知道
 * 某事都用得上）。把校正调用塞到 chatHistory 位：system = buildFixPrompt（信封已 slim：仅 reply + 概要 + 前文 + 指令；
 * 卡 / 世界书不在此、由上面标记提供——captureFixContext 在预设模式已把信封的卡 / 世界书置空、免重复），紧跟 user =
 * directive（手动那句话 / 按目标 / 自动的指令）。directive 省略时（自由发挥手动经 buildMessages 进来）用 convoForPrompt()。
 * buildFixPrompt 仍按 fixActiveMode 选系统提示；captureFixContext 已先跑（含 wiBefore/wiAfter 备槽给 worldInfo 标记）。
 * ------------------------------------------------------------------ */
function buildFixPresetMessages(s, directive) {
    const ctx = getCtx();
    const snap = getCuratedSnapshot(s, s.sysPromptPresetName);
    const items = (snap && snap.items) || [];
    const out = [];

    let placed = false;
    const placeFix = () => {
        if (placed) return;
        pushMsg(out, 'system', buildFixPrompt(ctx, s));
        if (directive != null) pushMsg(out, 'user', directive);
        else for (const m of convoForPrompt()) pushMsg(out, m.role, m.content);
        placed = true;
    };

    for (const it of items) {
        if (it.kind === 'marker') {
            // chatHistory 槽 = 校正调用（slim 信封）；其余 RP 内容标记照预设位置展开（卡 / 世界书 / 场景 / 示例 / 人格），
            // 让校正模型看到角色 / 世界设定（改对话 / 知不知道某事都用得上），且只出现一次（信封已 slim）。
            if (it.identifier === 'chatHistory') placeFix();
            else expandMarker(out, it.identifier, ctx, s);
        } else {
            pushMsg(out, it.role || 'system', subst(ctx, it.content));
        }
    }
    placeFix(); // 预设里没有 chatHistory marker -> 追加到末尾

    return out.length ? out : (directive != null
        ? [{ role: 'system', content: buildFixPrompt(ctx, s) }, { role: 'user', content: directive }]
        : [{ role: 'system', content: buildFixPrompt(ctx, s) }, ...convoForPrompt()]);
}

/* ------------------------------------------------------------------ *
 * Advisor mode THROUGH a curated preset (opt-in: s.advisorUsePreset).
 * Same skeleton as buildLorebookPresetMessages: keep the preset's TEXT blocks
 * (jailbreak / formatting / framing), skip the RP markers (the advisor block
 * already carries card + WI + full transcript itself), and drop the advisor
 * directive + side-chat Q&A where the chat history would sit, so a post-history
 * jailbreak block still lands last.
 * ------------------------------------------------------------------ */
function buildAdvisorPresetMessages(s) {
    const ctx = getCtx();
    const snap = getCuratedSnapshot(s, s.sysPromptPresetName);
    const items = (snap && snap.items) || [];
    const out = [];

    const advBlock = buildAdvisorPrompt(ctx, s);  // directive + plan + card + WI + full transcript
    let placed = false;
    const placeAdv = () => {
        if (placed) return;
        pushMsg(out, 'system', advBlock);
        for (const m of convoForPrompt()) pushMsg(out, m.role, m.content);
        placed = true;
    };

    for (const it of items) {
        if (it.kind === 'marker') {
            if (it.identifier === 'chatHistory') placeAdv();
            // every other marker is skipped in advisor mode
        } else {
            pushMsg(out, it.role || 'system', subst(ctx, it.content));
        }
    }
    placeAdv(); // no chatHistory marker in the curation -> append at the end

    return out.length ? out : [{ role: 'system', content: advBlock }, ...convoForPrompt()];
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */
async function onSend() {
    if (isGenerating) { stopGeneration(); return; }
    const s = getSettings();
    const text = inputEl.value.trim();
    if (!text) return;

    // validate config
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) {
        addSystemNote('请先在设置（齿轮图标）中填写端点 URL 和模型。');
        return;
    }
    if (s.mode === 'profile' && !s.profileId) {
        addSystemNote('请先在设置（齿轮图标）中选择一个连接配置文件。');
        return;
    }

    inputEl.value = '';
    autoGrowInput();                                        // #4 清空后把输入框收回下限高度
    const entry = { id: ++cidSeq, role: 'user', content: text };
    convo.push(entry);
    persistConvo();
    entry._el = addMessage('user', text, entry);
    await generateReply();
}

// 纯判定：这次生成失败算不算用户主动「停止」（AbortError）。是 → 不给「重试」按钮（中止是有意的）；
// 其余错误（429 限流 / 网络 / 空回复传 null）都不是中止 → 给重试。容错：无错误对象按非中止处理。
function isUserAbort(err) {
    return err?.name === 'AbortError';
}

// Generate one assistant reply for the current tail of `convo` (which must already
// end with the user turn being answered). Shared by send / edit / regenerate.
async function generateReply() {
    if (isGenerating) return;
    const s = getSettings();
    if (s.applyRegex) await loadRegexEngine(); // ensure engine is ready before building context

    if (diagnoseMode) {
        if (diagPickerActive()) {
            // 精选模式（用户功能请求）：只喂【本聊天挑选】的世界书条目（无视启用 / 禁用；L2 混合再并入主聊天
            // 此刻命中的绿灯）。所见即所得——不自动补 [mvu_update] 规则；若一条规则都没选，给个温和提醒。
            const picked = await buildDiagSelectedWi();
            worldInfoBlock = picked.block;
            if (!diagSelHasRules(picked.selectedEntries)) {
                addSystemNote('⚠ 当前精选里没有选中任何变量规则（[mvu_update]）条目，诊断可能不准确——可在上方选条目栏勾选规则条目（含已禁用的）。');
            }
        } else {
            // 原行为：强制一次世界书扫描（保留 'all' 选择），再从原始书补回 [mvu_update] 规则——buildWorldInfo
            // 按设计会剥掉它们（聊天 / 参谋不想要），且 MVU 额外模型解析模式还会把它们从扫描里藏掉，而诊断正需要它们。
            worldInfoBlock = await buildWorldInfo(wiContextMode(s));
            const mvuRules = await collectMvuUpdateRules(worldInfoBlock);
            if (mvuRules.length) {
                worldInfoBlock = [worldInfoBlock, ...mvuRules].filter(Boolean).join('\n\n');
            }
        }
        const stat = await getMvuStatData();
        diagStatData = stat ? JSON.stringify(stat, null, 2) : '';
        diagLatestUpdate = extractUpdateBlock(getLatestAiMessageText());
    } else if (lorebookMode) {
        // Read the selected world book(s) fresh so the model sees the current
        // state, and remember which books are in scope for the apply step.
        await buildLorebookContext();
    } else if (advisorMode) {
        // Advisor (incl. the arc system) forces a WI scan like Diagnose, so the
        // card's blue entries + keyword-matched green entries are always present
        // (keep 'all' if the user chose it) — gives the arc lore to recall.
        // Builds its own full-history transcript inside buildAdvisorPrompt.
        worldInfoBlock = await buildWorldInfo(wiContextMode(s));
        // Live MVU variable state (好感度 / 时间 / 资源…) — hard story facts the
        // proposed beats must not contradict. Silently absent for non-MVU cards.
        const stat = await getMvuStatData();
        advStatData = stat ? JSON.stringify(stat, null, 2) : '';
    } else if (fixMode) {
        // 校正模式（手动 / 引导式：在输入框直接说要改什么）：抓待校正回复 + 手动那套上下文（卡 / 世界书 / 概要 / 全部前文）。
        await captureFixContext(s, { mode: 'manual' });
        // R2 双重校正（手动）：目标当前 swipe 已是校正结果 → 提醒；仍继续（在其基础上再校正）。
        if (isFixSwipe((getCtx().chat || [])[fixTargetIdx])) addSystemNote('这条回复当前显示的已是一次校正结果；将在其基础上再次校正（如需校正原文请先左滑回原文）。');
    } else if (presetCurationActive(s)) {
        // Faithful assembly needs WI split into the Before/After-Char-Defs slots.
        const split = await buildWorldInfoSplit();
        wiBefore = split.before;
        wiAfter = split.after;
        worldInfoBlock = ''; // legacy single-block path unused while preset is active
    } else {
        worldInfoBlock = await buildWorldInfo(); // empty string when mode is 'off'
    }

    // Normal chat mode only: fetch the authoritative variable state (or leave ''
    // so the prompt builders emit the honest-refusal caveat instead).
    chatStatData = '';
    if (!diagnoseMode && !lorebookMode && !advisorMode && !fixMode && s.chatIncludeStat) {
        const st = await getMvuStatData();
        chatStatData = st ? JSON.stringify(st, null, 2) : '';
    }

    // 外部扩展世界信息（世界引擎等）——普通聊天与剧情参谋两种模式都附带（用户功能请求）；
    // 诊断 / 世界书模式不需要。无相关扩展时 assembleExternalWorld() 返回 ''，整段省略。
    chatWorldData = '';
    if (!diagnoseMode && !lorebookMode && !fixMode && s.chatIncludeWorld) {
        chatWorldData = assembleExternalWorld();
    }

    const messages = buildMessages();
    // Snapshot the exact prompt for the debug viewer (both modes).
    lastPrompt = messages.map((m) => ({ role: m.role, content: m.content }));
    lastPromptMeta = {
        mode: diagnoseMode ? '诊断' : (lorebookMode ? '世界书' : (advisorMode ? '参谋' : (fixMode ? '校正' : '聊天'))),
        target: s.mode === 'direct' ? (s.model || '直连') : '配置文件',
        chars: lastPrompt.reduce((n, m) => n + (m.content ? m.content.length : 0), 0),
        time: new Date().toLocaleTimeString(),
    };
    const aEntry = { id: ++cidSeq, role: 'assistant', content: '' };
    const assistantEl = addMessage('assistant', '', aEntry);
    aEntry._el = assistantEl;
    const contentEl = assistantEl.querySelector('.so-content');
    const clearTyping = showTyping(contentEl);
    setGenerating(true);
    abortCtl = new AbortController();

    try {
        let finalText = '';
        // Diagnose audits are long, and reasoning models spend part of the budget
        // "thinking" before any visible output — too small a cap yields an empty
        // reply (budget gone during thinking) or a patch cut off mid-token. Give
        // Diagnose a generous floor so a full 审计 has room to finish.
        const effMaxTokens = (diagnoseMode || fixMode) ? Math.max(s.maxTokens, 4096) : s.maxTokens;
        if (s.mode === 'direct') {
            const url = normalizeUrl(s.endpoint);
            const body = {
                model: s.model,
                messages,
                max_tokens: effMaxTokens,
            };
            if (s.sendTemperature) body.temperature = s.temperature;
            if (s.stream) {
                contentEl.classList.add('so-streaming');
                finalText = await streamDirect(url, s.apiKey, body, abortCtl.signal, (delta) => {
                    clearTyping();
                    contentEl.textContent += delta;
                    if (soFollowStream) scrollToBottom();   // #1 只在用户跟随到底部时才自动滚
                });
                contentEl.classList.remove('so-streaming');
            } else {
                finalText = await callDirect(url, s.apiKey, body, abortCtl.signal);
                clearTyping();
                contentEl.textContent = finalText;
            }
        } else {
            const override = s.sendTemperature ? { temperature: s.temperature } : {};
            if (s.stream) {
                contentEl.classList.add('so-streaming');
                finalText = await callProfileStream(s.profileId, messages, effMaxTokens, override, abortCtl.signal, (full) => {
                    clearTyping();
                    contentEl.textContent = full;
                    if (soFollowStream) scrollToBottom();   // #1 只在用户跟随到底部时才自动滚
                });
                contentEl.classList.remove('so-streaming');
            } else {
                finalText = await callProfile(s.profileId, messages, effMaxTokens, override, abortCtl.signal);
                clearTyping();
                contentEl.textContent = finalText;
            }
        }

        clearTyping();
        if (!finalText) {
            // Almost always a token-budget issue: the cap was spent before any
            // visible text (common with reasoning models, and with long Diagnose
            // audits). Point the user at the fix instead of a bare "(空回复)".
            contentEl.textContent = diagnoseMode
                ? '(空回复) — 审计可能把 token 预算用光了（推理也算在内）。调大设置里的「最大 token 数」，或问得更聚焦一点（比如只审某一类变量）。'
                : '(空回复) — 多半是「最大 token 数」太小、或被模型思考占满了。到设置里调大它再试。';
            contentEl.classList.add('so-error');
            addRetryControl(assistantEl, aEntry);   // 空回复也给「↻ 重试」（与真实失败一致）
        } else {
            // Strip main-chat mechanism blocks (<UpdateVariable>) the preset's
            // output contract may have coaxed out of the model — display AND
            // history, chat/advisor modes only (see stripMechanismBlocks).
            const mechStrip = !diagnoseMode && !lorebookMode;
            let cleanText = finalText;
            if (mechStrip) {
                cleanText = stripMechanismBlocks(finalText);
                // Backstop for CoT leakage: some custom presets / reasoning models
                // emit visible <think>/<thinking> blocks the oracle has no pipeline
                // to hide (the main chat does). Strip them from display AND history
                // so an imperfect — or absent — thinking-strip regex can't leave
                // them on screen, and they never re-feed into the next turn.
                cleanText = stripReasoningTags(cleanText);
                if (!cleanText) {
                    // The whole reply was hidden content — show why instead of a
                    // blank bubble, and keep history non-empty (some APIs reject
                    // empty message content on the next turn).
                    cleanText = '（这条回复只剩被自动隐藏的内容——主聊天机制区块（如 <UpdateVariable>）或思维链（如 <think>）。）';
                }
                if (cleanText !== finalText) contentEl.textContent = cleanText;
            }
            // When a curated preset drives the output AND regex is on, mirror main
            // chat: RENDER the reply through ST's own formatter (so display-stage
            // regex, markdown, and HTML/CSS widgets actually render instead of
            // showing as raw text), and STORE the prompt-stage regex'd copy in
            // history (clean text for re-feeding — no widget markup looping back).
            // Never for the plain textarea prompt, never in Diagnose mode (which
            // needs the raw <UpdateVariable> block intact), never in Advisor mode
            // (the raw <StoryPlan> blocks must survive for the adopt cards).
            // 普通聊天定稿渲染（#2 Markdown）：开「应用正则」→ 走 ST 自己的 messageFormatting（正则=全局+当前角色+
            // 当前选中预设 + Markdown + HTML 挂件，与主聊天一致）；关正则 → 只渲染 Markdown（showdown+DOMPurify，不碰
            // 正则引擎）。历史仍存干净文本（仅精选预设+正则时存 prompt 阶段正则后的拷贝，与原行为一致）。诊断/世界书/参谋/校正 不在此渲染。
            const isPlainChat = !diagnoseMode && !lorebookMode && !advisorMode && !fixMode;
            const useOutputRegex = isPlainChat && presetCurationActive(s) && s.applyRegex;
            let historyText = cleanText;
            if (useOutputRegex) historyText = applyOutputRegex(cleanText, /*forPrompt*/ true);
            if (isPlainChat) {
                const html = s.applyRegex ? renderReplyHtml(cleanText) : renderMarkdownOnly(cleanText);
                if (html != null) {
                    contentEl.innerHTML = html;
                    contentEl.classList.add('so-rendered');
                    contentEl.style.whiteSpace = 'normal';
                } else {
                    contentEl.textContent = cleanText;
                }
            }
            aEntry.content = historyText;
            convo.push(aEntry);
            persistConvo();
            if (diagnoseMode) {
                const block = extractUpdateBlock(finalText);
                if (block) addApplyControls(assistantEl, block);
            } else if (lorebookMode) {
                const parsed = parseLorebookBlocks(finalText);
                if (parsed.ops.length || parsed.errors.length) addLorebookApplyControls(assistantEl, parsed);
            } else if (advisorMode) {
                const plans = parseStoryPlans(cleanText);
                if (plans.length) addPlanControls(assistantEl, plans);
            } else if (fixMode) {
                // 失败时 .so-content 已显示剥离机制/思维链后的 cleanText，不覆盖它——只补一条说明 note。
                const fixStatus = renderFixCard(assistantEl, contentEl, aEntry, finalText);
                if (fixStatus === 'truncated') {
                    addSystemNote('校正稿似乎被截断了（模型没写完就断了）——把设置里的「最大 token 数」调大些，或点 ↻ 重试。');
                } else if (fixStatus !== 'ok') {
                    addSystemNote('没能从模型回复里解析出校正稿，已原样保留。请检查连接/模型，或换一句指令重试。');
                }
            }
        }
    } catch (err) {
        clearTyping();
        const aborted = isUserAbort(err);
        contentEl.textContent = aborted ? '(已停止)' : `错误：${err?.message || err}`;
        if (!aborted) {
            contentEl.classList.add('so-error');
            addRetryControl(assistantEl, aEntry);   // 失败（429 等）→ 常显「↻ 重试」，点它重发那一轮（不用重打）
        }
        console.error('[Story Oracle]', err);
    } finally {
        setGenerating(false);
        abortCtl = null;
        scrollToBottom();
    }
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式 Phase 4 —— 目标完整性守卫（M1）+ 两个数据完整性缺陷。PURE 层（无 DOM / 无副作用 / 确定）
 * 外加两个读 getCtx 的运行时薄封装（fixChatKey / fixCurrentSnapshot）。把「这份校正稿到底该不该写进这条
 * 回复」的判据抠成可单测的纯函数：
 *   · P-CORRUPT（切聊天跨聊天写）：捕获触发时的聊天身份 + 目标快照；应用前若聊天已切 / 目标已变 → 不写、记一条。
 *   · P-TRUNC（截断稿被应用）：模型回复被中转 / max_tokens 截断 → 半句稿会腰斩回复 → 不应用、记一条。
 * ------------------------------------------------------------------ */

// 纯函数：陈旧判定真值表。captured/current 均为普通对象 {chatId,targetIdx,swipeId,fingerprint,prose}（current 另带
// exists?:boolean）。优先级【自上而下】：缺任一 → gone；chatId 变 → chatSwitched（P-CORRUPT，压过一切）；目标
// 消失（exists:false / targetIdx 空 / <0）→ gone；swipe 变 → swipeChanged；指纹变 → contentChanged；否则 ok。
// prose 只随行、【不参与】判定。可单测（fix-target-integrity.test.mjs）。
function fixTargetStale(captured, current) {
    if (!captured || !current) return { stale: true, reason: 'gone' };
    if (current.chatId !== captured.chatId) return { stale: true, reason: 'chatSwitched' };
    if (current.exists === false || current.targetIdx == null || current.targetIdx < 0) return { stale: true, reason: 'gone' };
    if (current.swipeId !== captured.swipeId) return { stale: true, reason: 'swipeChanged' };
    if (current.fingerprint !== captured.fingerprint) return { stale: true, reason: 'contentChanged' };
    return { stale: false, reason: 'ok' };
}

// 纯函数：便宜确定性指纹——长度 + djb2 滚动哈希（36 进制）。对【整条 m.mes】取；捕获与应用两端比对以检测这条
// 回复是否在校正往返期间被编辑 / 换 swipe。不追求抗碰撞，只要「同文同指纹、异文极大概率异指纹」。nullish 安全。
function fixFingerprint(text) {
    const s = String(text == null ? '' : text);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;   // h*33 + c，逐步夹在 32 位
    return s.length + ':' + (h >>> 0).toString(36);
}

// 纯函数：截断检测。finish==='length'（上游 finish_reason，或 R1 合成：<FixedReply> 开了没闭）→ 权威判截断；
// 空成品 → empty。启发式【三条全中才算截断】：成品末尾无终止标点 且 原文收尾干净 且 成品散文字数 < 原文一半——
// 单看任一条都会误伤（✂️收紧本就合法缩短；RP 片段本就常无标点收尾），保守 AND 才不挡合法校正。终止标点正则与
// 0.5 比例【就地内联】（不设常量）。复用 proseCharCount。可单测。
function fixOutputTruncated(fixedText, finish, originalText) {
    if (finish === 'length') return { truncated: true, reason: 'length' };
    const fixed = String(fixedText == null ? '' : fixedText).trim();
    if (!fixed) return { truncated: true, reason: 'empty' };
    const orig = String(originalText == null ? '' : originalText).trim();
    const term = /[。．.！!？?…⋯~〜」』】）)"”’\]]$/;   // CJK + ASCII 终止 / 收尾标点
    const fixedMidSentence = !term.test(fixed);
    if (fixedMidSentence && term.test(orig) && proseCharCount(fixed) < 0.5 * proseCharCount(orig)) {
        return { truncated: true, reason: 'midSentenceShort' };
    }
    if (fixedMidSentence) return { truncated: false, reason: 'midSentenceOnly' };   // 断句但不短 → 放行
    return { truncated: false, reason: 'ok' };
}

// 纯函数：目标消息【当前】swipe 是否已是一次校正结果（applyFixAsSwipe 在 swipe_info[...].extra.story_oracle_fix
// 打了 true）。只看当前 swipe（防止在校正稿上再叠一层）。nullish 安全。可单测。
function isFixSwipe(m) {
    return m?.swipe_info?.[m.swipe_id]?.extra?.story_oracle_fix === true;
}

// 运行时薄封装（读 getCtx；导出以便测试 stub SillyTavern.getContext）：聊天身份键 groupId::chatId。
// 【排除 characterId】（R4）——群聊生成中它被改写成应答成员，纳入会在同一群聊里误报 chatSwitched。getContext
// 不可用 / 抛错 → 退化成 '::'（空键；捕获与应用两端一致时仍相等，不假性触发陈旧）。
function fixChatKey() {
    try {
        const ctx = getCtx();
        return String((ctx && ctx.groupId) || '') + '::' + String((ctx && ctx.chatId) || '');
    } catch (e) {
        return '::';
    }
}

// 运行时薄封装（非导出）：读【当前】getCtx() 造出 current 快照供 fixTargetStale 比对。复用 resolveAutoTargetMessage
// 的「仍是非空 AI 回复」判据（失效 → idx:-1 → exists:false → gone）；指纹取当前 m.mes；swipe 取当前 swipe_id。
function fixCurrentSnapshot(idx) {
    const ctx = getCtx();
    const chat = (ctx && ctx.chat) || [];
    const t = resolveAutoTargetMessage(chat, idx);
    const exists = t.idx >= 0;
    const m = exists ? chat[t.idx] : null;
    return {
        chatId: fixChatKey(),
        targetIdx: t.idx,
        swipeId: exists ? ((m && m.swipe_id) | 0) : -1,
        fingerprint: fixFingerprint(m ? m.mes : ''),
        exists,
        prose: '',
    };
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式「自动配置」Phase 5 —— 按聊天懒检测 + 记忆 + 静默兜底（D+E）。PURE 决策层
 * （无 DOM / 无副作用 / 确定；无时钟无随机；不发 LLM 调用）。复用 Phase 1 的 detectScopeTag /
 * fixScopeVerdict，不重新扫描——这里只把「这条回复该用哪个作用域标签、要不要出提示」的判断收拢成
 * 一张可单测的决策表：
 *   缓存命中（cachedTag 在这条回复里找得到）→ 直接用、不重检测（省 detectScopeTag 的开销）。
 *   缓存未命中 → 按来源分流：自动（用户没手填过）→ 高置信就采纳新标签并记住（下次就是缓存命中）；
 *     中低置信 / 检测出来的还是同一个标签（这条只是个例）→ 静默跳过这条，不瞎猜也不整条校正（D）。
 *   手动（用户明确填过）→ 永不代替用户改写，只在侧聊建议、原样跳过这条（E）。
 *   两种来源有一个共同例外：这条回复压根没有任何信封结构（noWrapper）→ 校正整条回复本就安全、正确
 *   （D 的例外——没有结构可保护，就没有「误伤」这回事）。
 * ------------------------------------------------------------------ */

// 纯函数：给定 chat，取【最近 n 条非空 AI 回复】原文，供 detectScopeTag 当嗅探语料。排除 chat[0]
// （开场白 / 问候语可能不代表卡片真实回复形态，见设计 §3「懒检测」）；跳过用户 / 系统消息与空白/非字符串；
// 按时间顺序（旧→新）返回，条数不足 n 也不补齐。nullish / 非数组 chat → []。可单测。
function recentAiReplies(chat, n = 5) {
    const list = Array.isArray(chat) ? chat : [];
    const lim = Math.max(1, Number(n) || 5);
    const picked = [];
    for (let i = list.length - 1; i >= 1 && picked.length < lim; i -= 1) {   // 止步于下标 1：排除 chat[0]
        const m = list[i];
        if (!m || m.is_user || m.is_system || typeof m.mes !== 'string' || !m.mes.trim()) continue;
        picked.push(m.mes);
    }
    return picked.reverse();   // 出栈顺序是新→旧，翻回旧→新（与 buildTranscriptTurns 等「前文数组」的惯例一致）
}

// 纯函数：D+E 决策核。reply = 已【钉住】的待校正回复原文（cache-hit 用 fixScopeVerdict 判在场；钉住来自
// resolveAutoTargetMessage，未必是「最新一条」——刻意与 replies 分开传参，两者合并会重犯 1.17.12
// 「改到上一条」那次教训）；replies = 供 detectScopeTag 嗅探用的最近 AI 回复语料（不含 reply 本身也没关系——
// 嗅探要的是【卡片的一般形态】，不是这一条本身）。
//   action:
//     'fallbackWhole' —— 用户主动留空作用域【或】这条回复所在的语料压根没有信封结构（noWrapper，D 的
//                        例外）→ 校正整条回复；tag 回空串，active:false。
//     'cache'         —— 缓存的 cachedTag 在这条回复里找得到 → 直接用，不重检测；tag 原样回传，active:true。
//     'detected'      —— 缓存未命中 + 自动来源 + 高置信 + 检测出的标签≠缓存 → 采纳新标签（调用方负责
//                        setFixCfg 写回 + 缓存，本函数只判断不写状态）；tag 换成检测到的标签，active:true。
//     'skip'          —— 缓存未命中，但不该猜：自动来源且检测结果就是缓存本身（这条是个例，note 码
//                        skipAnomaly）；或置信不够（note 码 skipUncertain）→ 跳过这条，不改、不整条校正；
//                        tag 原样回传（仅供参考），active:false。
//     'suggest'       —— 缓存未命中 + 手动来源（用户明确填过标签，永不代替用户改写）→ 只建议、不采纳；
//                        tag 原样回传，active:false。
//   note: null | { code, cachedTag, detectedTag }，code ∈ 'detected'|'suggest'|'skipAnomaly'|'skipUncertain'。
//   标签比较大小写不敏感（cache-hit 判定复用 fixScopeVerdict/splitContentScope 内建的不敏感匹配；
//   det.tag ↔ cachedTag 的「是否同一个标签」比较本函数自己转小写再比）。nullish 安全（各参数缺省视作
//   空/关闭，委托 fixScopeVerdict / detectScopeTag 自身的 nullish 兜底）。可单测。
function resolveFixScope({ cachedTag, scopeManual, reply, replies }) {
    const cached = (cachedTag == null) ? '' : String(cachedTag);
    if (!cached.trim()) return { tag: '', active: false, action: 'fallbackWhole', note: null };   // 用户主动关闭作用域（opt-out）

    const verdict = fixScopeVerdict(reply, cached, '');
    if (!verdict.danger) return { tag: cached, active: true, action: 'cache', note: null };   // 缓存命中——无需重检测

    const det = detectScopeTag(replies);
    if (det.noWrapper) return { tag: '', active: false, action: 'fallbackWhole', note: null };   // D 例外：无信封可保护，整条本就安全

    const manual = !!scopeManual;
    if (!manual) {
        if (det.confidence === 'high') {
            const same = det.tag.toLowerCase() === cached.toLowerCase();
            if (same) return { tag: cached, active: false, action: 'skip', note: { code: 'skipAnomaly', cachedTag: cached, detectedTag: det.tag } };
            return { tag: det.tag, active: true, action: 'detected', note: { code: 'detected', cachedTag: cached, detectedTag: det.tag } };
        }
        return { tag: cached, active: false, action: 'skip', note: { code: 'skipUncertain', cachedTag: cached, detectedTag: '' } };
    }
    const detectedTag = (det.confidence === 'high') ? det.tag : '';   // 只在高置信时才给出候选，认不准就不瞎猜
    return { tag: cached, active: false, action: 'suggest', note: { code: 'suggest', cachedTag: cached, detectedTag } };
}

// 纯函数：resolveFixScope 的 note 码 → 人话文案表（仿 fixEnvNote / autoDiagNoteContent 的 reason→人话查表）。
// emoji：detected ✨（采纳新标签）/ suggest ⚠️（提醒但不代劳）/ skipAnomaly、skipUncertain 都是 ⏭️（跳过）。
// nullish-safe：note 为空 / 非对象 / 无法识别的 code → 都回 { emoji:'', body:'' }（调用方据此自然不出提示）。
function fixScopeNoteText(note) {
    if (!note || typeof note !== 'object') return { emoji: '', body: '' };
    const cachedTag = String(note.cachedTag || '');
    const detectedTag = String(note.detectedTag || '');
    if (note.code === 'detected') {
        return { emoji: '✨', body: `检测到本卡正文标签是 <${detectedTag}>，已自动切换（原设 <${cachedTag}> 这条回复里没找到）。` };
    }
    if (note.code === 'suggest') {
        const body = detectedTag
            ? `你设的 <${cachedTag}> 不在这条回复里；检测到的可能是 <${detectedTag}>，要改就去校正设置里改（已跳过、未动这条回复）。`
            : `你设的 <${cachedTag}> 不在这条回复里，也没能猜出别的候选；已跳过、未动这条回复——去校正设置里检查一下作用域标签。`;
        return { emoji: '⚠️', body };
    }
    if (note.code === 'skipAnomaly') {
        return { emoji: '⏭️', body: `这条回复没找到 <${cachedTag}>，但最近其它回复都还在用它——像是这条的个例，已跳过、未动它（没有误改整条）。` };
    }
    if (note.code === 'skipUncertain') {
        return { emoji: '⏭️', body: `这条回复没找到 <${cachedTag}>，也认不准换成了哪个标签；已跳过、未动这条回复，避免误改整条。` };
    }
    return { emoji: '', body: '' };
}

// ✨ 校正模式「自动配置」Phase 6（B+C 扫描面板用）——纯函数：把扫描出的结构块并入用户现有【保留区】标签串。
// 去重按「名 + 分隔符」大小写不敏感；existing 内容在前、新增块按传入顺序每行一个追加；existing 里已有的不重复加。
// blocks = detectInnerBlocks 的 [{name,bracket}]。existing/blocks nullish 安全。复用 parseExcludeTags 解析已有串。
function mergeKeepTags(existing, blocks) {
    const cur = String(existing == null ? '' : existing);
    const have = new Set(parseExcludeTags(cur).map((sp) => (sp.bracket ? '[' : '<') + sp.name.toLowerCase()));
    const add = [];
    for (const b of (Array.isArray(blocks) ? blocks : [])) {
        if (!b || !b.name) continue;
        const key = (b.bracket ? '[' : '<') + String(b.name).toLowerCase();
        if (have.has(key)) continue;
        have.add(key);
        add.push(b.bracket ? ('[' + b.name + ']') : ('<' + b.name + '>'));
    }
    if (!add.length) return cur;
    return cur + ((cur && !cur.endsWith('\n')) ? '\n' : '') + add.join('\n');
}

// 抓取待校正回复 + 按开关备好上下文块。含前文用 buildTranscriptTurns 多取一条再去掉末条——末条就是待校正回复本身
// （已在 <text_to_transform>，不重复喂；与 recast 的 slice(-(N+1),-1) 同理）。generateReply 的 fixMode 分支与 runFixByTargets 共用。
// mode='manual'（在输入框直接说要改什么）或 'auto'（按目标校正按钮 / 每条新回复自动校正）。两套设置经
// resolveFixModeCfg 归一后彻底独立：手动=上下文丰富 / 无目标 / 不收紧 / 无排除区；自动=按 fixA_* 的目标 + 上下文 +
// 排除区 + 收紧。排除区仅自动有（手动 keepTags/dropTags 恒空）；MVU 机制块两模式都自动剥离（composeFixedReply 原样接回）。
async function captureFixContext(s, { mode = 'manual', targetId } = {}) {
    const ctx = getCtx();
    // 走【本聊天】生效值（per-chat 覆盖全局 s），再按 mode 归一成手动 / 自动各自的一套——绝不直读 fixM_/fixA_ 原始键。
    const norm = resolveFixModeCfg(getEffectiveFixCfg(s, getFixCfg()), mode);
    // 自动·事件驱动（runAutoFix 经 maybePostReply 传入触发消息 id）→ 钉住那条；手动 / 「按目标校正」按钮无 id → 仍取最近一条。
    const latest = (targetId != null) ? resolveAutoTargetMessage(ctx.chat, targetId) : getLatestAiMessage();
    fixTargetIdx = latest.idx;
    // ✨ 作用域（仅自动；用户功能请求）：若设了正文标签（默认 content）且回复里确有该标签 → 只校正 <content> 内层，
    // 正文外的所有块作为【信封】逐字保留、原位回插（应用时 wrapContentScope）。找不到该标签 / 留空 → active:false，
    // baseText 回退整条回复（旧行为，简单卡不受影响）。后续 extractExcludedSections / 机制块剥离 / 看改动 都基于 baseText。
    // ✨ Phase 5（D+E）：不再直接 splitContentScope(norm.scopeTag) —— 缓存的标签可能已经不在这条回复里了（卡片
    // 格式变了 / 这条回复是个例）。resolveFixScope 先判「缓存是否命中」，未命中再按来源（自动可自纠 / 手动只建议）
    // 决定用哪个标签、要不要出提示；本函数只负责【决策 + 落状态】，不写配置也不发通知——那是 runAutoFix /
    // runFixByTargets（D+E 门）的事，这里保持 captureFixContext「只搭建上下文」的既有契约。手动模式没有作用域
    // （resolveFixModeCfg 早把 scopeTag 归一成 ''），fixScopeDecision 置空，行为与之前完全一致。
    if (mode === 'auto') {
        const dec = resolveFixScope({ cachedTag: norm.scopeTag, scopeManual: norm.scopeManual, reply: latest.text, replies: recentAiReplies(ctx.chat, 5) });
        fixScopeDecision = dec;
        fixScope = dec.active ? splitContentScope(latest.text, dec.tag) : { active: false };
    } else {
        fixScopeDecision = null;
        fixScope = { active: false };
    }
    const baseText = fixScope.active ? fixScope.inner : latest.text;
    fixOriginalReply = baseText;   // 机制块接回 + 看改动「before」基于作用域内层（作用域外的块在信封里、不参与校正与差异）
    const ex = extractExcludedSections(baseText, norm.keepTags, norm.dropTags);   // 排除区（仅自动）；思考块去留由用户「保留/丢弃」决定
    fixTargetProse = stripMechanismBlocks(ex.prose);   // 仍自动剥离 MVU 机制块（<UpdateVariable>，composeFixedReply 会原样接回）
    fixExtraKeep = ex.keepBlocks;   // 保留区块数组（composeFixedReply 按 ⟦SO_KEEP_n⟧ 位置还原，而非接到末尾）
    // ✨ Phase 4 目标完整性：抓下这次校正的【身份 + 目标快照】。应用前（尤其手动卡「应用」的延迟点击、以及自动
    // 在 LLM 往返后）用 fixTargetStale 比对，聊天已切（P-CORRUPT）/ 目标换 swipe / 内容变更 / 目标消失 → 不写、记一条。
    // 指纹取整条 m.mes（换 swipe 后 mes 也变，两端不一致即拦下）；prose 存去机制块正文，供 addFixApplyControls 廉价截断复检。
    fixCaptured = {
        chatId: fixChatKey(),
        targetIdx: latest.idx,
        swipeId: (ctx.chat[latest.idx]?.swipe_id) | 0,
        fingerprint: fixFingerprint(ctx.chat[latest.idx]?.mes),
        prose: fixTargetProse,
    };
    fixSummaryBlock = norm.includeSummary ? getSummary() : '';   // 📜剧情概要（手动默认带、自动可选）；buildFixEnvelope 包成 <story_summary>
    fixTightenActive = norm.tighten;   // ✨ 收紧：手动恒 false（单稿省时间）；自动按 ✂️收紧 开关（默认开）
    fixActiveMode = mode;              // buildFixPrompt 据此选系统提示：手动 → FIX_SYSTEM_PROMPT_MANUAL；自动 → FIX_SYSTEM_PROMPT(_TIGHTEN)
    fixAutoPromptVersion = norm.promptVersion;   // ✨ 精校版本（仅自动生效；手动 norm 恒 'light'）；'thorough' → buildFixPrompt 用精校
    fixAutoPromptFlavor = norm.promptFlavor;     // ✨ 精校侧重（'deepseek' / 'opus'）
    if (norm.includeContext) {
        const depth = norm.contextDepth | 0;              // -1（或任何非正数）= 全部前文
        const fetchDepth = depth > 0 ? depth + 1 : -1;    // 多取 1 条以便下面去掉待校正回复；非正数→-1 取全部
        const turns = buildTranscriptTurns(ctx, { ...s, contextDepth: fetchDepth }, false);
        const prior = turns.slice(0, -1);   // 去掉末条（待校正回复本身）
        fixContextBlock = prior.map((l) => `${l.name}: ${l.text}`).join('\n\n');
    } else {
        fixContextBlock = '';
    }
    // 卡 / 世界书：经【自定义补全预设】发送时（fixM_/fixA_usePreset + 已精选预设），由预设的 charDescription / worldInfo 标记在
    // 各自位置提供（见 buildFixPresetMessages 的 expandMarker），故信封里【不再带】卡 / 世界书（slim，免重复）——
    // 改备 before/after 两槽给那两个标记。否则（普通发送）按 fix 模式上下文开关带卡 / 世界书。概要 / 前文两模式都仍在信封里。
    if (fixUsePresetFor(s, mode) && presetCurationActive(s)) {
        fixCardBlock = '';
        fixWorldBlock = '';
        const split = await buildWorldInfoSplit();
        wiBefore = split.before;
        wiAfter = split.after;
    } else {
        fixCardBlock = norm.includeCard ? buildCardSection(ctx) : '';
        fixWorldBlock = norm.includeWorld ? await buildWorldInfo('st') : '';
    }
}

// 校正卡的「解析成功 → 渲染 → 出按钮」公共段：generateReply 的 fixMode 分支与 runFixByTargets 共用（Phase 2b 评审要求去重）。
// 只处理解析成功这一支（真正重复的那段）：历史存干净校正正文 + persistConvo + 把校正稿渲染进 .so-content（同普通回复
// 路径，不动 .so-bubble.innerHTML，否则会连角色标签/复制重生删除按钮一起抹掉）+ 在 .so-bubble 层挂「发现并修正」note
// + 出「应用到回复」按钮条。读 module 级 fixOriginalReply/fixTargetIdx/fixExtraKeep（captureFixContext 已抓好）。
// 返回 true=已渲染校正卡；false=解析不出 <FixedReply>，**失败处理留给各调用点自己做**（两处失败语义不同：手动分支此时
// .so-content 已显示剥离后的 cleanText、不应覆盖；按目标分支要把原文/「（空回复）」回填——故不在这里统一）。
function renderFixCard(assistantEl, contentEl, aEntry, finalText) {
    // 手动宽容 / 自动严格：路由归一成 status；非 ok（'truncated' / 'unparseable'）原样回传给调用点出对应提示。
    const r = parseFixReply(finalText, fixActiveMode);
    if (r.status !== 'ok') return r.status;
    // P-TRUNC：解析成功但成品像是被截断（<FixedReply> 开了没闭 / 末尾断句且明显偏短）→ 当截断处理，回传
    // 'truncated' 让调用点提示「调大 token / 重试」并【不出应用按钮】——半句稿会腰斩这条回复。
    const finishHint = (/<FixedReply\b[^>]*>/i.test(finalText) && !/<\/FixedReply\s*>/i.test(finalText)) ? 'length' : undefined;
    if (fixOutputTruncated(r.fixed, finishHint, fixTargetProse).truncated) return 'truncated';
    const parsed = { fixed: r.fixed, problems: r.problems };   // 保持下游 parsed.fixed / parsed.problems / addFixApplyControls 契约不变
    aEntry.content = parsed.fixed;   // 历史里存干净的校正正文，而非原始 <FixedReply> 标签
    persistConvo();
    const html = renderReplyHtml(parsed.fixed);
    if (html != null) {
        contentEl.innerHTML = html;
        contentEl.classList.add('so-rendered');
        contentEl.style.whiteSpace = 'normal';
    } else {
        contentEl.textContent = parsed.fixed;
    }
    // 无改动检测：模型把原文原样返回（手动模式没有 <problems> 可解释——否则用户只看到「同样的输出、没说明」，
    // 这正是用户报的「偶尔拒绝改动、又不解释」）。明确告知，且【不出「应用」按钮】——应用一条与原文相同的 swipe 没意义。
    if (fixNoOp(fixTargetProse, parsed.fixed)) {
        const note = document.createElement('div');
        note.className = 'so-fix-changes';
        note.textContent = '模型没有做出改动——它认为按当前要求无需修改。可换一句更具体的指令、或调整目标后再试。';
        assistantEl.querySelector('.so-bubble')?.appendChild(note);
        return 'ok';   // 已处理（解析失败那条 note 不该再补）；但不挂应用按钮
    }
    if (parsed.problems) {
        const note = document.createElement('div');
        note.className = 'so-fix-changes';
        note.textContent = '发现并修正：\n' + parsed.problems;
        // 「发现并修正」note 挂在 .so-bubble 层（同 addApplyControls 的做法），落在 .so-content 下方而非混进正文。
        assistantEl.querySelector('.so-bubble')?.appendChild(note);
    }
    // 把捕获快照 fixCaptured 一并传给应用控件：延迟点击「应用」时用它做陈旧守卫（P-CORRUPT 主要面）。
    addFixApplyControls(assistantEl, parsed, fixOriginalReply, fixTargetIdx, fixExtraKeep, fixScope, fixCaptured);
    return 'ok';
}

// 「按目标校正最新回复」：用勾选的目标 + 约束（不是手动输入）当指令，对最新回复跑一次两段式校正并出卡。
// 这是后续自动模式的核心，这里由按钮手动触发。一次性非流式调用（仿 runAutoDiagnose）。
async function runFixByTargets() {
    if (isGenerating) return;
    const s = getSettings();
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) { addSystemNote('请先在设置里配置直连端点与模型。'); return; }
    if (s.mode === 'profile' && !s.profileId) { addSystemNote('请先在设置里选择一个连接配置档。'); return; }
    await captureFixContext(s, { mode: 'auto' });   // 「按目标校正」= 自动那套（双稿 / 目标 / 上下文按 fixA_*），手动触发一次
    if (!fixTargetProse.trim()) { addSystemNote('没找到可校正的 AI 回复（主聊天里要先有一条 AI 回复）。'); return; }
    // R2 双重校正（一次性手动触发）：目标当前 swipe 已是校正结果 → 提醒会在其基础上再校正，随后继续（不静默改基准）。
    if (isFixSwipe((getCtx().chat || [])[fixTargetIdx])) addSystemNote('这条回复当前显示的已是一次校正结果；将在其基础上再次校正（如需校正原文请先左滑回原文）。');
    // ✨ Phase 5 D+E 门：与 runAutoFix 同一套判断（RESOLUTION A——这个按钮走的也是「自动」那套配置，理应遵守
    // 同一份 D 静默兜底），只是这里是一次性、有人盯着屏幕的手动触发，所以走 addSystemNote 通道（普通侧聊提示），
    // 不是 addAutoFixNote 的持久记录；suggest / skip 时直接 return，不出校正卡（呼应下面「没找到可校正的
    // AI 回复」那类提前退出，不留下一张会误导的卡片）。
    const scopeDec = fixScopeDecision;
    if (scopeDec && scopeDec.action === 'detected') {
        setFixCfg({ fixA_scopeTag: scopeDec.tag, fixA_scopeManual: false });
        const scopeEl = win && win.querySelector('#so-fix-scope');
        if (scopeEl) scopeEl.value = scopeDec.tag;
        addSystemNote(fixScopeNoteText(scopeDec.note).body);
    } else if (scopeDec && (scopeDec.action === 'suggest' || scopeDec.action === 'skip')) {
        addSystemNote(fixScopeNoteText(scopeDec.note).body);
        return;
    }
    // 自动模式配置（per-chat 覆盖全局，再经 resolveFixModeCfg 归一）。
    const a = resolveFixModeCfg(getEffectiveFixCfg(s, getFixCfg()), 'auto');
    const directive = compileFixTargets(
        a.targets,
        { card: a.includeCard, context: a.includeContext, world: a.includeWorld },
        { knowledge: a.knowledge, guardrails: a.guardrails },
    );
    if (!directive) { addSystemNote('还没勾选任何校正目标、也没填约束。请在「校正设置」里勾选或填写，或直接在下方输入框手动说要改什么。'); return; }

    const ctx = getCtx();
    const messages = (fixUsePresetFor(s, 'auto') && presetCurationActive(s))
        ? buildFixPresetMessages(s, directive)   // 破限 / 越狱：套上自定义补全预设（仅文本块 + 角色，跳过 RP 内容标记）
        : [{ role: 'system', content: buildFixPrompt(ctx, s) }, { role: 'user', content: directive }];
    const aEntry = { id: ++cidSeq, role: 'assistant', content: '' };
    const assistantEl = addMessage('assistant', '', aEntry);
    aEntry._el = assistantEl;
    const contentEl = assistantEl.querySelector('.so-content');
    const clearTyping = showTyping(contentEl);
    setGenerating(true);
    // 用【模块级】abortCtl（与 generateReply / stopGeneration / 停止按钮同一个）：setGenerating(true) 已把发送键变成
    // 「停止」键，点它经 onSend → stopGeneration 中断的正是 abortCtl。此前这里用【本地】ctl，停止键够不着 →「按目标
    // 校正最新回复」一旦发出就无法中断（只能等 120s 超时 / 重载）。改用 abortCtl 后停止键即时生效（用户反馈修复）。
    abortCtl = new AbortController();
    const timer = setTimeout(() => { try { abortCtl?.abort(); } catch (e) { /* ignore */ } }, 120000);
    try {
        const effMaxTokens = Math.max(s.maxTokens, 4096);
        let finalText = '';
        if (s.mode === 'direct') {
            const url = normalizeUrl(s.endpoint);
            const body = { model: s.model, messages, max_tokens: effMaxTokens };
            if (s.sendTemperature) body.temperature = s.temperature;
            if (s.stream) {
                contentEl.classList.add('so-streaming');
                finalText = await streamDirect(url, s.apiKey, body, abortCtl.signal, (delta) => { clearTyping(); contentEl.textContent += delta; if (soFollowStream) scrollToBottom(); });
                contentEl.classList.remove('so-streaming');
            } else {
                finalText = await callDirect(url, s.apiKey, body, abortCtl.signal);
            }
        } else {
            const override = s.sendTemperature ? { temperature: s.temperature } : {};
            if (s.stream) {
                contentEl.classList.add('so-streaming');
                finalText = await callProfileStream(s.profileId, messages, effMaxTokens, override, abortCtl.signal, (full) => { clearTyping(); contentEl.textContent = full; if (soFollowStream) scrollToBottom(); });
                contentEl.classList.remove('so-streaming');
            } else {
                finalText = await callProfile(s.profileId, messages, effMaxTokens, override, abortCtl.signal);
            }
        }
        clearTyping();
        if (renderFixCard(assistantEl, contentEl, aEntry, finalText) !== 'ok') {
            contentEl.textContent = finalText || '（空回复）';
            addSystemNote('没能从模型回复里解析出 <FixedReply> 校正稿。请检查连接 / 模型，或调整目标后重试。');
        }
    } catch (e) {
        clearTyping();
        if (isUserAbort(e)) {
            contentEl.textContent = '(已停止)';                       // 用户点停止键中断 → 平静收尾，不当报错（与 generateReply 一致）
        } else {
            contentEl.textContent = '校正失败：' + (e?.message || e);
            contentEl.classList.add('so-hint-error');
        }
    } finally {
        clearTimeout(timer);
        setGenerating(false);
        abortCtl = null;                                             // 交还共享中断器（与 generateReply 一致）
        scrollToBottom();
    }
}

// 「正在校正…」提示（仿 showAutoDiagGenerating）。timeOut:0 = 不自动消失，由我们在生成结束后 dismissToast 收掉。
function showAutoFixGenerating() {
    try {
        if (window.toastr && window.toastr.info) {
            return window.toastr.info('正在校正最新回复…（点此中断）', '故事神谕 · 自动校正', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, onclick: () => cancelPostReply() });
        }
    } catch (e) { /* ignore */ }
    return null;
}

// 纯副作用：在侧聊里留一条【持久】自动校正记录（仿 notifyAutoDiagnose 的记录部分）。status:
// fixed / nochange / failed；problems = 「发现并修正」摘要（仅 fixed 有意义，可空）。窗口关着也留得下
// （DOM 在 init 建好），随 per-chat 持久化、跨重载存活；是 note 条目、绝不回灌给模型（见 convoForPrompt）。
function addAutoFixNote(status, problems, fix = null) {
    try {
        const stamp = (() => { try { return new Date().toLocaleTimeString(); } catch (e) { return ''; } })();
        const entry = { id: ++cidSeq, role: 'note', content: autoFixNoteContent({ status, problems, stamp }) };
        convo.push(entry);
        persistConvo();
        // fix（仅 'fixed' 结果带）= { idx, before, after, fixSwipeId }，给记录挂「用原文 / 看改动」按钮。
        // 注意：和手动校正回复一样，按钮只在【本会话】可用——重载后记录是纯文本（fix 不进 persistConvo）。
        if (messagesEl) entry._el = addNoteMessage(entry, fix ? { fix } : null);
    } catch (e) { console.warn('[Story Oracle] 自动校正记录写入侧聊失败：', e); }
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式「自动配置」Phase 3 —— 环境自检 PURE 层（无 DOM / 无副作用 / 确定；无时钟无随机）。
 * 校正结果偶尔让人费解，真正原因常常出在【外部环境】——弱模型 / 中转拒绝或吐垃圾、连接没配好、这条回复
 * 压根没用 MVU——而不是校正本身的问题。这里只建纯检测 + 人话文案，供后续集成阶段调用：
 * fixFailureReason（把模型调用的失败分类成人话原因，港 arcFailureReason 的形状——权威 API 信号优先，
 * 文本启发式兜底）/ fixEnvNote（连接未配置 / MVU 缺失两种运行时条件的静态文案）/ replyExpectsMvu
 * （这条回复是否带 MVU 状态栏标记的纯谓词，供判断 mvuAbsent 提示该不该出——没用 MVU 的卡片不该被
 * 瞎报「状态栏不显示」）。真正读 window.Mvu / 设置的判断留给后续集成阶段；这一层只出文案 + 判定。
 * ------------------------------------------------------------------ */

// 纯函数：把模型调用的失败分类成人话原因。finish = 上游 finish_reason（今天实践中通常是 undefined，
// 这里先接住以便日后接入，不强求）。按权威信号优先、文本启发式兜底的顺序：
//   1. finish==='content_filter' → refusal（无条件，甚至先于「空回复」判断——这是 API 给的确凿信号）。
//   2. text 是 null/undefined（缺内容），或整条 trim 后是空串 → empty（= 空回复）。注意：模型【回复正文本身】
//      恰好是字面串 'null'/'[object Object]' 这类（序列化泄漏 = 有内容但是垃圾）仍走分支 4(d)——那是文本内容，不是缺内容。
//   3. refusal：命中常见破限/审查话术（中英，大小写不敏感），且没有可用的 <FixedReply> 尝试——哪怕
//      模型先道了个歉，只要还给出一份 <FixedReply>，就还有可用内容，不算拒绝（不按长度砍，只看这一个闸门）。
//   4. garbage：明显不是模型的叙事校正输出——中转/网关的 JSON 错误体（{...} 且带 error 键）、HTML 错误页
//      （<!DOCTYPE/<html 开头）、语言运行时调用栈（JS "at foo (file:12:34)" / Python Traceback）、整串
//      字面 undefined/null/NaN/[object Object]、连续 3+ 个 U+FFFD 替换字符（编码乱码）。刻意不做「同字符
//      连续重复」的启发式——正文里「啊啊啊啊」「哈哈哈哈」是正常 RP 语气，会被错杀。
//   5. 否则 → ok（放行；「解析不出校正稿」的通用兜底文案已由调用方的 autoFixNoteContent('failed') 承担，这里不重复）。
// 返回 {kind:'refusal'|'empty'|'garbage'|'ok', message}。可单测。
function fixFailureReason(text, finish) {
    const refusalMsg = '模型像是拒绝了这次校正，可试试勾『经自定义补全预设发送』破限';
    if (finish === 'content_filter') return { kind: 'refusal', message: refusalMsg };
    const trimmed = text == null ? '' : String(text).trim();
    if (!trimmed) return { kind: 'empty', message: '中转返回空回复' };

    const refusalPattern = /抱歉|很遗憾|对不起|无法(协助|完成|生成)|不能(提供|生成|协助)|违反[^\n]{0,10}(政策|准则)|内容政策|i'm sorry|i cannot|i can'?t (assist|help|comply|provide)|i won'?t|as an ai|content policy/i;
    if (refusalPattern.test(trimmed) && !trimmed.includes('<FixedReply')) {
        return { kind: 'refusal', message: refusalMsg };
    }

    let jsonError = false;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const obj = JSON.parse(trimmed);
            if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, 'error')) jsonError = true;
        } catch (e) { /* 不是合法 JSON，不算命中 */ }
    }
    const lower = trimmed.toLowerCase();
    const isGarbage = jsonError
        || /^<!doctype|^<html/i.test(trimmed)
        || /\bat\s+\S+\s*\([^)]*:\d+:\d+\)/.test(trimmed)
        || trimmed.includes('Traceback (most recent call last)')
        || lower === 'undefined' || lower === 'null' || lower === 'nan' || lower === '[object object]'
        || /�{3,}/.test(trimmed);
    if (isGarbage) return { kind: 'garbage', message: '模型回复异常' };

    return { kind: 'ok', message: '' };
}

// 纯函数：环境自检提示文案——静态 kind→string 查表，供后续集成阶段在对应运行时条件成立时展示。
//   connectionUnset —— 自动校正开着，但连接（直连端点/模型，或配置档）没配好，所以不会运行。
//   mvuAbsent —— 这条回复带 MVU 状态栏标记，但当前环境检测不到 window.Mvu，状态栏不显示是环境问题，与校正无关。
// 其余 / nullish → ''（不出提示）。
function fixEnvNote(kind) {
    if (kind === 'connectionUnset') return '自动校正已开，但还没配置连接（端点/模型 或 配置档），所以不会运行——去设置里配一下。';
    if (kind === 'mvuAbsent') return '状态栏由 MVU 渲染，当前没检测到 MVU，状态栏不显示与校正无关。';
    return '';
}

// 纯谓词：这条回复文本是否【期待】MVU 渲染状态栏（带 STATUS_PLACEHOLDER 占位符，或 <UpdateVariable> 更新块）。
// nullish → false。刻意不走 Phase 1 的 listTopLevelTagNames——那只看【顶层】块，标记若嵌在别的标签内部
// （如埋在 <content>/<gametxt> 里）会被漏判；这里就是要在整条文本里【任意位置】找，嵌套也要认得出来。
function replyExpectsMvu(text) {
    if (text == null) return false;
    const s = String(text);
    return s.includes(STATUS_PLACEHOLDER) || /<UpdateVariable\b/i.test(s);
}

// 自动校正【运行步】（仿 runAutoDiagnose）：对最新一条主聊天 AI 回复用【勾选目标 + 约束】跑一次两段式校正，
// 解析成功且确有改动则自动【作为新 swipe】应用（非破坏性，原文留在 swipe 0），每跑一轮在侧聊留一条记录。
// 后台操作：自建上下文、不碰窗口共享态、不 setGenerating、不出问答气泡（与手动 runFixByTargets 的区别）。
// 【不】自管锁 / settle——编排（Task 5 的 message_received 监听）持锁；本函数只负责「跑这一次」。
// 一次性非流式调用（own AbortController + 120s 超时）。
async function runAutoFix(ctx, s, targetId) {
    // 连接没配好就静默退出——别让每条回复都报错（开自动模式的人一般已配好直连 / 配置档）。
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) return;
    if (s.mode === 'profile' && !s.profileId) return;

    await captureFixContext(s, { mode: 'auto', targetId });     // 自动模式：双稿 / 目标 / 上下文按 fixA_*（收紧仍受 ✂️收紧 开关）；targetId 钉住触发消息
    if (!fixTargetProse.trim()) return;                         // 没有可校正的 AI 回复正文
    // R2 双重校正（自动）：目标当前 swipe 已是一次校正结果 → 跳过 + 记一条 nochange（防止在校正稿上再叠一层、越改越偏）。
    if (isFixSwipe((ctx.chat || [])[fixTargetIdx])) { addAutoFixNote('nochange'); return; }

    // ✨ Phase 5 D+E 门：captureFixContext 已经决策好这条回复该拿哪个作用域标签、要不要出提示（fixScopeDecision）；
    // 这里只负责【落地】——写配置 / 出提示 / 决定继续还是跳过。位置刻意排在上面的 R2 双重校正之后（那条已经
    // return 掉的情形不该再叠加一条作用域提示）、成本门 fixPreFilter 之前（省一次可能白花的 LLM 调用）。
    //   detected → 采纳新标签：写回 per-chat 配置（缓存，且 scopeManual 仍是 false——这不是用户手填的）+
    //     顺手同步一下设置面板里的 #so-fix-scope 输入框（如果窗口开着，用户正好能看见变化），继续往下走。
    //   suggest / skip → D 的静默兜底：只留一条侧聊记录，绝不整条回复瞎改，本轮直接结束。
    //   cache / fallbackWhole → 无需任何动作，直接往下走（fixScope 已经在 captureFixContext 里按决策设好了）。
    const scopeDec = fixScopeDecision;
    if (scopeDec && scopeDec.action === 'detected') {
        setFixCfg({ fixA_scopeTag: scopeDec.tag, fixA_scopeManual: false });
        const scopeEl = win && win.querySelector('#so-fix-scope');
        if (scopeEl) scopeEl.value = scopeDec.tag;   // 单字段回填；el.value= 不触发 'input' 事件，scopeManual 不会被误置 true
        addAutoFixNote('scope', scopeDec.note);
        if (typeof toastr !== 'undefined') toastr.success(fixScopeNoteText(scopeDec.note).body, '', { timeOut: 6000 });   // ✨ M4：一次性自动切标签——窗口关着也看得见（skip/suggest 每条都弹会烦，故只 detected 弹）
    } else if (scopeDec && (scopeDec.action === 'suggest' || scopeDec.action === 'skip')) {
        addAutoFixNote('scope', scopeDec.note);
        return;   // D 静默兜底：跳过这条，绝不整条误改
    }

    // 自动模式配置（per-chat 覆盖全局，再归一）；fixAutoMinChars = 成本门最小字符数（自动专属，不进归一）。
    const cfg = getEffectiveFixCfg(s, getFixCfg());
    const a = resolveFixModeCfg(cfg, 'auto');
    const targets = a.targets;
    const constraints = { knowledge: a.knowledge, guardrails: a.guardrails };

    // 成本门：不值得发调用（太短 / 没勾目标的禁词命中 / 没约束）→ 记一条「无需校正」直接跳过，不发 LLM。
    if (!fixPreFilter(fixTargetProse, targets, constraints, cfg.fixAutoMinChars)) { addAutoFixNote('nochange'); return; }

    const directive = compileFixTargets(
        targets,
        { card: a.includeCard, context: a.includeContext, world: a.includeWorld },
        constraints,
    );
    if (!directive) return;                                      // 什么都没配（无目标 + 无约束）——不留记录、静默退出

    const messages = (fixUsePresetFor(s, 'auto') && presetCurationActive(s))
        ? buildFixPresetMessages(s, directive)   // 破限 / 越狱：套上自定义补全预设（仅文本块 + 角色，跳过 RP 内容标记）
        : [{ role: 'system', content: buildFixPrompt(ctx, s) }, { role: 'user', content: directive }];
    const effMaxTokens = Math.max(s.maxTokens, 4096);
    const ctl = beginPostReplyCall(120000);      // 模块级中断器：120s 超时兜底 + 让「正在自动校正…」提示可点一下中断
    const genToast = showAutoFixGenerating();
    let finalText = '';
    try {
        if (s.mode === 'direct') {
            const body = { model: s.model, messages, max_tokens: effMaxTokens };
            if (s.sendTemperature) body.temperature = s.temperature;
            finalText = await callDirect(normalizeUrl(s.endpoint), s.apiKey, body, ctl.signal);
        } else {
            const override = s.sendTemperature ? { temperature: s.temperature } : {};
            finalText = await callProfile(s.profileId, messages, effMaxTokens, override, ctl.signal);
        }
    } finally {
        ctl.end();
        dismissToast(genToast);
    }

    const parsed = parseFixedReply(finalText);
    if (!parsed) { addAutoFixNote('failed'); return; }          // 解析不出 <FixedReply> 校正稿
    if (fixNoOp(fixTargetProse, parsed.fixed)) { addAutoFixNote('nochange'); return; }   // 校正稿与原文除空白外无差 → 无操作
    // R1 P-TRUNC 截断守卫：原始回复里 <FixedReply> 开了没闭 → 合成 finish='length'；否则靠启发式（末尾断句 + 原文
    // 收尾干净 + 明显偏短）。截断稿会把回复腰斩成半句 → 不应用、记一条 truncated（不落 swipe）。
    const finishHint = (/<FixedReply\b[^>]*>/i.test(finalText) && !/<\/FixedReply\s*>/i.test(finalText)) ? 'length' : undefined;
    if (fixOutputTruncated(parsed.fixed, finishHint, fixTargetProse).truncated) { addAutoFixNote('truncated'); return; }

    // 接回原回复的机制块（<UpdateVariable> + 状态栏占位符）+ 用户「排除·保留」区，再作为【新 swipe】应用。
    const innerFixed = composeFixedReply(parsed.fixed, fixOriginalReply, fixExtraKeep);
    const finalText2 = wrapContentScope(fixScope, innerFixed);   // ✨ 作用域：把校正后的内层回插信封原位（inactive 时为无操作）
    // P-CORRUPT 权威网：LLM 返回后聊天可能已切走 / 这条回复已换 swipe / 被编辑 / 被删——写入前再核对捕获快照，
    // 失效则不写、记一条 stale（原因经 problems 槽映射人话）。这是「切聊天发生在 LLM 返回之后」的最后一道闸。
    const st = fixTargetStale(fixCaptured, fixCurrentSnapshot(fixTargetIdx));
    if (st.stale) { addAutoFixNote('stale', st.reason); return; }
    await applyFixAsSwipe(fixTargetIdx, finalText2);
    // 抓【应用后】落点的 swipe_id（addSwipeToMessage 把新 swipe 设为当前），给记录的「用原文 ↔ 用校正稿」
    // 开关用；原文留在 swipe 0。before = 去机制块的原文 prose（fixTargetProse）；after 必须也是【纯散文】
    // parsed.fixed——不是 finalText2：finalText2 经 composeFixedReply 接回了 <UpdateVariable> + 状态栏占位符
    // + 保留区，拿它做 after 会让 MVU 卡的整个状态块在差异里被误标成大段绿色新增。prose ↔ prose 才干净
    //（与手动卡 stripMechanismBlocks(原文) vs parsed.fixed 一致）。swipe 目标仍是 finalText2 落点（不动）。
    const fixSwipeId = (ctx.chat[fixTargetIdx] || {}).swipe_id;
    addAutoFixNote('fixed', parsed.problems, { idx: fixTargetIdx, before: fixTargetProse, after: parsed.fixed, fixSwipeId });
}

function stopGeneration() {
    try { abortCtl?.abort(); } catch (e) { /* ignore */ }
}

function setGenerating(on) {
    isGenerating = on;
    sendBtn.innerHTML = on ? '<i class="fa-solid fa-stop"></i>' : '<i class="fa-solid fa-paper-plane"></i>';
    sendBtn.title = on ? '停止' : '发送';
    sendBtn.classList.toggle('so-generating', on);
}

/* ---- transports (all OpenAI Chat Completions shaped) ---- */
function normalizeUrl(u) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (!u) return u;
    if (/\/chat\/completions$/.test(u)) return u;          // full path given
    if (/\/v\d+$/.test(u)) return u + '/chat/completions';  // ends in /v1, /v2 ...
    return u + '/v1/chat/completions';                      // bare host or base
}

function directHeaders(apiKey) {
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
    return h;
}

// Derive the OpenAI-compatible models endpoint from whatever the user typed.
function modelsUrl(u) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (!u) return u;
    if (/\/chat\/completions$/.test(u)) return u.replace(/\/chat\/completions$/, '/models');
    if (/\/models$/.test(u)) return u;
    if (/\/v\d+$/.test(u)) return u + '/models';
    return u + '/v1/models';
}

async function onFetchModels() {
    const s = getSettings();
    const hint = win.querySelector('#so-model-hint');
    const sel = win.querySelector('#so-model-list');
    const btn = win.querySelector('#so-model-fetch');

    if (!s.endpoint) { hint.textContent = '请先填写端点 URL。'; hint.classList.add('so-hint-error'); return; }

    hint.classList.remove('so-hint-error');
    hint.textContent = '正在加载模型…';
    btn.classList.add('so-busy');

    try {
        const url = modelsUrl(s.endpoint);
        const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(20000) : undefined;
        const res = await fetch(url, { method: 'GET', headers: directHeaders(s.apiKey), signal });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 200)}`);
        }
        const data = await res.json();
        // OpenAI: { data: [{id}] }. Tolerate top-level arrays and { models: [...] }.
        let list = Array.isArray(data?.data) ? data.data
            : Array.isArray(data) ? data
            : Array.isArray(data?.models) ? data.models
            : [];
        const ids = [...new Set(
            list.map((m) => (typeof m === 'string' ? m : (m?.id || m?.name))).filter(Boolean)
        )].sort((a, b) => a.localeCompare(b));

        if (!ids.length) { hint.textContent = '服务商未返回任何模型。'; sel.style.display = 'none'; return; }

        sel.innerHTML = '';
        const ph = document.createElement('option');
        ph.value = '';
        ph.textContent = `— 选择一个模型（共 ${ids.length} 个）—`;
        sel.appendChild(ph);
        for (const id of ids) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            sel.appendChild(opt);
        }
        // pre-select the current model if it's in the list
        if (s.model && ids.includes(s.model)) sel.value = s.model;
        sel.style.display = '';
        hint.textContent = `共 ${ids.length} 个模型 —— 选择其一，或继续输入自定义名称。`;
    } catch (err) {
        const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        hint.textContent = aborted ? '请求超时。' : `获取模型失败：${err?.message || err}`;
        hint.classList.add('so-hint-error');
        sel.style.display = 'none';
        console.error('[Story Oracle] model fetch failed:', err);
    } finally {
        btn.classList.remove('so-busy');
    }
}

async function callDirect(url, apiKey, body, signal) {
    const res = await fetch(url, {
        method: 'POST',
        headers: directHeaders(apiKey),
        body: JSON.stringify({ ...body, stream: false }),
        signal,
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
}

// 有些中转 / 代理会【无视 stream:true】，直接回一个普通 JSON 补全（不是 SSE 事件流）。逐行找 data: 会一无所获、
// 返回空串 → 上层「无可解析 ArcBeat」→「编译没成功」。这个纯函数把那种普通 JSON 正文里的 content 取出来作回退；
// 既不是 SSE、也不是合法补全 JSON 时返回 ''（交给上层报「空回复」）。纯函数 → 可单测。
function extractNonStreamContent(raw) {
    if (!raw || !raw.trim()) return '';
    try {
        const data = JSON.parse(raw);
        return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    } catch (e) {
        return '';
    }
}

async function streamDirect(url, apiKey, body, signal, onDelta) {
    const res = await fetch(url, {
        method: 'POST',
        headers: directHeaders(apiKey),
        body: JSON.stringify({ ...body, stream: true }),
        signal,
    });
    if (!res.ok || !res.body) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    let raw = '', sawData = false;   // raw=原始正文（供非 SSE 回退）；sawData=是否出现过 SSE 行
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        raw += chunk;
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop(); // keep the (possibly partial) last line
        for (let line of lines) {
            line = line.trim();
            if (!line.startsWith('data:')) continue;
            sawData = true;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') return full;
            try {
                const json = JSON.parse(payload);
                const delta = json?.choices?.[0]?.delta?.content || '';
                if (delta) { full += delta; onDelta(delta); }
            } catch (e) { /* keepalive / non-JSON line */ }
        }
    }
    // 回退：整段流里从未出现 SSE 的 data: 行（端点无视了 stream:true、回了普通 JSON）→ 按普通补全解析，别返回空串。
    if (!sawData && !full) {
        const content = extractNonStreamContent(raw);
        if (content) { onDelta(content); return content; }
    }
    return full;
}

// 弧线「实时输出」专用流式 direct：同时累计 content 与 reasoning_content（reasoning 模型把 CoT 放在后者），
// 经 onLive({content, reasoning}) 实时报给查看器——这样窗口在 reasoning 模型上也看得到「在动」，而不是盯着
// content 卡在空。返回值仍是 content 全文（供 parseArcBeat / parseArcCheck 解析，与非流式完全一致）。
async function streamDirectArc(url, apiKey, body, signal, onLive) {
    const res = await fetch(url, { method: 'POST', headers: directHeaders(apiKey), body: JSON.stringify({ ...body, stream: true }), signal });
    if (!res.ok || !res.body) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '', reasoning = '', raw = '', sawData = false;   // raw=原始正文（供非 SSE 回退）；sawData=是否出现过 SSE 行
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        raw += chunk;
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (let line of lines) {
            line = line.trim();
            if (!line.startsWith('data:')) continue;
            sawData = true;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') { if (onLive) onLive({ content: full, reasoning }); return full; }
            try {
                const d = JSON.parse(payload)?.choices?.[0]?.delta || {};
                if (typeof d.content === 'string') full += d.content;
                const r = (typeof d.reasoning_content === 'string' ? d.reasoning_content : '') || (typeof d.reasoning === 'string' ? d.reasoning : '');
                if (r) reasoning += r;
                if ((typeof d.content === 'string' && d.content) || r) { if (onLive) onLive({ content: full, reasoning }); }
            } catch (e) { /* keepalive / 非 JSON 行 */ }
        }
    }
    // 回退：整段流里从未出现 SSE 的 data: 行（中转无视了 stream:true、回了普通 JSON 补全）→ 按普通补全解析其 content，
    // 别再返回空串（空串 → parseArcBeat 解不出 → 黑箱「编译没成功」）。这正是「反重力 / 部分中转」会触发的情形。
    if (!sawData && !full) {
        const content = extractNonStreamContent(raw);
        if (content) { if (onLive) onLive({ content, reasoning: '' }); return content; }
    }
    if (onLive) onLive({ content: full, reasoning });
    return full;
}

async function callProfile(profileId, messages, maxTokens, overridePayload, signal) {
    const ctx = getCtx();
    const result = await ctx.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        { stream: false, extractData: true, signal },
        overridePayload || {},
    );
    return result?.content ?? '';
}

async function callProfileStream(profileId, messages, maxTokens, overridePayload, signal, onText) {
    const ctx = getCtx();
    // With stream:true, sendRequest resolves to a function that creates an
    // AsyncGenerator. Each chunk's `.text` is the CUMULATIVE text so far.
    const gen = await ctx.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        { stream: true, signal },
        overridePayload || {},
    );
    const iterator = (typeof gen === 'function') ? gen() : gen;
    let full = '';
    for await (const chunk of iterator) {
        if (chunk && typeof chunk.text === 'string') {
            full = chunk.text;
            onText(full);
        }
    }
    return full;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/* Copy that also works in non-secure (http) contexts. ST is frequently
 * served over plain HTTP on a LAN / Tailscale address, where
 * navigator.clipboard is undefined — so fall back to a hidden textarea +
 * execCommand, with the readonly + selection-range trick iOS needs. */
async function copyTextRobust(text) {
    text = text || '';
    if (!text.trim()) return false;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) { /* fall through to legacy path */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length); // iOS Safari needs an explicit range
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch (e) {
        return false;
    }
}

function addMessage(role, content, entry) {
    const empty = messagesEl.querySelector('.so-empty');
    if (empty) empty.remove();

    const wrap = document.createElement('div');
    wrap.className = `so-msg so-${role}`;
    if (entry) wrap.dataset.cid = entry.id;
    const icon = role === 'user' ? 'fa-user' : 'fa-moon';
    const label = role === 'user' ? '你' : '神谕';

    const copyBtn = role === 'assistant'
        ? `<button class="so-msg-btn so-copy-btn" type="button" title="复制" aria-label="复制此回复"><i class="fa-solid fa-copy"></i></button>`
        : '';
    // Per-message actions (shown on hover): edit (user) / regenerate (assistant) + delete.
    let actionBtns = '';
    if (entry) {
        if (role === 'user') {
            actionBtns += `<button class="so-msg-btn so-edit-btn" type="button" title="编辑并重新生成"><i class="fa-solid fa-pen"></i></button>`;
        } else {
            actionBtns += `<button class="so-msg-btn so-regen-btn" type="button" title="重新生成（会丢弃其后的内容）"><i class="fa-solid fa-rotate"></i></button>`;
        }
        actionBtns += `<button class="so-msg-btn so-del-btn" type="button" title="删除"><i class="fa-solid fa-trash"></i></button>`;
    }

    wrap.innerHTML =
        `<div class="so-avatar"><i class="fa-solid ${icon}"></i></div>` +
        `<div class="so-bubble"><div class="so-role"><span class="so-role-label">${label}</span>` +
        `<span class="so-actions">${copyBtn}${actionBtns}</span></div><div class="so-content"></div></div>`;
    const contentEl = wrap.querySelector('.so-content');
    contentEl.textContent = content;

    const cBtn = wrap.querySelector('.so-copy-btn');
    if (cBtn) {
        cBtn.addEventListener('click', async () => {
            const ok = await copyTextRobust(contentEl.textContent);
            cBtn.classList.add('so-copied');
            cBtn.innerHTML = ok ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>';
            cBtn.title = ok ? '已复制' : '复制失败 —— 请手动选择文本';
            setTimeout(() => {
                cBtn.classList.remove('so-copied');
                cBtn.innerHTML = '<i class="fa-solid fa-copy"></i>';
                cBtn.title = '复制';
            }, 1200);
        });
    }
    if (entry) {
        const editBtn = wrap.querySelector('.so-edit-btn');
        if (editBtn) editBtn.addEventListener('click', () => editUserMessage(entry));
        const regenBtn = wrap.querySelector('.so-regen-btn');
        if (regenBtn) regenBtn.addEventListener('click', () => regenerateFrom(entry));
        const delBtn = wrap.querySelector('.so-del-btn');
        if (delBtn) delBtn.addEventListener('click', () => deleteMessage(entry));
    }

    messagesEl.appendChild(wrap);
    if (role === 'assistant' && content === '') {
        soFollowStream = false;                  // #1 新流式回复：固定顶部、默认不跟随，让用户从开头读
        scrollBubbleToTop(wrap);
    } else {
        soFollowStream = true;                   // 用户发言 / 有内容的消息：滚到底并恢复跟随
        scrollToBottom();
    }
    return wrap;
}

// Re-show the empty placeholder if no real messages remain.
function maybeRenderEmpty() {
    if (!messagesEl.querySelector('.so-msg')) { messagesEl.innerHTML = ''; renderEmptyState(); }
}

// Delete one message. Deleting a user turn also drops its immediate assistant
// reply so the history stays well-formed; an error bubble (never pushed to convo)
// just drops from the DOM.
function deleteMessage(entry) {
    if (isGenerating) return;
    const i = convo.indexOf(entry);
    if (i === -1) {
        if (entry && entry._el) entry._el.remove();
        maybeRenderEmpty();
        return;
    }
    if (entry.role === 'user' && convo[i + 1] && convo[i + 1].role === 'assistant') {
        const reply = convo[i + 1];
        if (reply._el) reply._el.remove();
        convo.splice(i, 2);
    } else {
        convo.splice(i, 1);
    }
    if (entry._el) entry._el.remove();
    persistConvo();
    maybeRenderEmpty();
}

// Regenerate an assistant reply: drop it (and everything after) and re-run from
// the preceding user turn. The common case (the most recent reply) leaves nothing
// after it, so this is just "re-roll the last answer".
async function regenerateFrom(entry) {
    if (isGenerating) return;
    const el = entry._el;
    const i = convo.indexOf(entry);
    if (i !== -1) convo.splice(i);     // drop this entry and all after (error bubbles aren't in convo)
    if (el) { while (el.nextSibling) el.nextSibling.remove(); el.remove(); }
    persistConvo();
    if (!convo.length || convo[convo.length - 1].role !== 'user') { maybeRenderEmpty(); return; }
    await generateReply();
}

// Inline-edit a user message, then truncate everything after it and regenerate.
function editUserMessage(entry) {
    if (isGenerating) return;
    const el = entry._el;
    if (!el) return;
    const bubble = el.querySelector('.so-bubble');
    const contentEl = bubble.querySelector('.so-content');
    if (bubble.querySelector('.so-edit-box')) return; // already editing

    const box = document.createElement('div');
    box.className = 'so-edit-box';
    const ta = document.createElement('textarea');
    ta.className = 'so-edit-ta';
    ta.value = entry.content;
    ta.rows = Math.min(12, Math.max(2, entry.content.split('\n').length));
    const actions = document.createElement('div');
    actions.className = 'so-edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'so-edit-save'; saveBtn.textContent = '保存并重新生成';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'so-edit-cancel'; cancelBtn.textContent = '取消';
    actions.appendChild(saveBtn); actions.appendChild(cancelBtn);
    box.appendChild(ta); box.appendChild(actions);
    contentEl.style.display = 'none';
    bubble.appendChild(box);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);

    const close = () => { box.remove(); contentEl.style.display = ''; };
    cancelBtn.addEventListener('click', close);
    const commit = async () => {
        const newText = ta.value.trim();
        const i = convo.indexOf(entry);
        if (!newText || i === -1) { close(); return; }
        entry.content = newText;
        contentEl.textContent = newText;
        convo.splice(i + 1);                                   // drop later turns
        persistConvo();
        close();
        while (el.nextSibling) el.nextSibling.remove();        // drop their DOM
        await generateReply();
    };
    saveBtn.addEventListener('click', commit);
    ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); close(); }
        else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commit(); }
    });
}

// 失败回复气泡上的【常显】「↻ 重试」按钮（用户功能请求）。.so-actions 里的 regen 按钮只在 hover 时出现，
// 手机上够不着；这里显式加一个一直可见的按钮。点它 = regenerateFrom(entry)：去掉这条失败气泡，对当前侧聊尾部
// （刚发的那条用户消息还在）重新生成——不用重打。复用 .so-apply-bar/.so-apply-btn 样式（零新 CSS）。
function addRetryControl(assistantEl, entry) {
    if (!assistantEl) return;
    const bubble = assistantEl.querySelector('.so-bubble');
    if (!bubble || bubble.querySelector('.so-retry-btn')) return;   // 防重复添加
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar so-retry-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'so-apply-btn so-retry-btn';
    btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> 重试';
    bar.appendChild(btn);
    bubble.appendChild(bar);
    scrollToBottom();
    btn.addEventListener('click', () => {
        if (isGenerating) return;
        regenerateFrom(entry);
    });
}

// Apply / Undo bar appended to a diagnose reply that contains a corrective patch.
function addApplyControls(assistantEl, patchBlock) {
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 将修复应用到状态';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
    bar.appendChild(btn);
    bar.appendChild(status);
    assistantEl.querySelector('.so-bubble').appendChild(bar);
    scrollToBottom();

    let snapshot = null;
    btn.addEventListener('click', async () => {
        status.classList.remove('so-hint-error');
        if (snapshot) {
            // currently applied -> undo
            btn.disabled = true;
            status.textContent = '正在还原…';
            try {
                await undoFix(snapshot);
                snapshot = null;
                btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 将修复应用到状态';
                status.textContent = '已还原到之前的状态。';
            } catch (e) {
                status.textContent = '还原失败：' + (e?.message || e);
                status.classList.add('so-hint-error');
            }
            btn.disabled = false;
            return;
        }
        btn.disabled = true;
        status.textContent = '正在应用…';
        try {
            snapshot = await applyFix(patchBlock, status);
            if (snapshot) {
                btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 撤销';
                status.textContent = '已应用 —— 状态已更新。';
            }
        } catch (e) {
            status.textContent = '应用失败：' + (e?.message || e);
            status.classList.add('so-hint-error');
        }
        btn.disabled = false;
    });
}

// 校正卡的「应用到回复」按钮条（仿 addApplyControls）。应用 = 把校正稿（接回原文机制块后）作为新
// swipe 写入目标消息；原文留在左滑。Phase 1 只做应用（撤销 = 左滑回 swipe 0）。
// ✨ Phase 4：校正「应用」被陈旧守卫拦下时给手动卡片 status span 的人话文案（P-CORRUPT 切聊天 / 内容变更 / 换 swipe / 目标消失）。
function staleMsg(reason) {
    if (reason === 'chatSwitched') return '聊天已切换，未把校正写入这条回复（避免写到别的对话）。';
    if (reason === 'contentChanged') return '这条回复已发生变化，未应用（避免覆盖新内容）。请重新校正。';
    if (reason === 'swipeChanged') return '这条回复已切到别的 swipe，未应用。请切回后重新校正。';
    return '目标回复已不在了，未应用。';   // gone（含未知原因兜底）
}

function addFixApplyControls(assistantEl, parsed, originalReply, targetIdx, keepSections, scope, captured) {
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 应用到回复';
    // 「看改动」：原文（去机制块，prose↔prose）→ 校正稿的内联差异卡，懒构建一次后切 hidden 复用。
    const diffBtn = document.createElement('button');
    diffBtn.className = 'so-apply-btn';
    diffBtn.innerHTML = '<i class="fa-solid fa-eye"></i> 看改动';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
    bar.appendChild(btn);
    bar.appendChild(diffBtn);
    bar.appendChild(status);
    const bubble = assistantEl.querySelector('.so-bubble');
    bubble.appendChild(bar);
    scrollToBottom();

    let diffCard = null;
    diffBtn.addEventListener('click', () => {
        if (!diffCard) {
            // 看改动 = 原文 ↔【实际会应用的结果】。after 用 composeFixedReply（把保留区块 + 机制块接回原位）而非
            // 裸 parsed.fixed——否则「保留区块」在 after 里是被抹掉的占位标记，会被【误标成大段删除】（用户报的
            // 「<branches> 放进保留区还是被删」其实是这个 diff 假象：块并没送模型、应用后也在，只是看改动显示错了）。
            // 两侧都 stripMechanismBlocks，让 <UpdateVariable> 不在差异里刷屏；真正被删的【未保留】块仍会如实标红。
            const appliedPreview = stripMechanismBlocks(composeFixedReply(parsed.fixed, originalReply, keepSections));
            diffCard = renderDiffCard(stripMechanismBlocks(String(originalReply || '')), appliedPreview);
            bubble.appendChild(diffCard);
        } else {
            diffCard.hidden = !diffCard.hidden;
        }
        scrollToBottom();
    });

    let applied = false;
    btn.addEventListener('click', async () => {
        if (applied) return;
        status.classList.remove('so-hint-error');
        btn.disabled = true;
        status.textContent = '正在应用…';
        try {
            // P-CORRUPT（主要面 = 延迟点击「应用」）：写入前再核对捕获快照。这段时间里可能切了聊天、划了 swipe、
            // 或编辑了这条回复——失效则不写、给人话原因、把按钮放回去让用户重新校正（绝不写到别的对话 / 覆盖新内容）。
            const st = fixTargetStale(captured, fixCurrentSnapshot(targetIdx));
            if (st.stale) {
                status.textContent = staleMsg(st.reason);
                status.classList.add('so-hint-error');
                btn.disabled = false;
                return;
            }
            // P-TRUNC 廉价复检：成品（parsed.fixed）像是半句且明显短于原文 → 不写入（半句稿会腰斩回复）。
            if (fixOutputTruncated(parsed.fixed, undefined, captured && captured.prose).truncated) {
                status.textContent = '校正稿似乎被截断了，未应用。请点 ↻ 重试或调大「最大 token 数」后重新校正。';
                status.classList.add('so-hint-error');
                btn.disabled = false;
                return;
            }
            const innerFixed = composeFixedReply(parsed.fixed, originalReply, keepSections);
            const finalText = wrapContentScope(scope, innerFixed);   // ✨ 作用域：校正稿回插信封原位（inactive 时为无操作）
            const ok = await applyFixAsSwipe(targetIdx, finalText);
            if (ok) {
                applied = true;
                btn.innerHTML = '<i class="fa-solid fa-check"></i> 已应用（左滑看原文）';
                status.textContent = '已作为新 swipe 写入这条回复。';
            } else {
                status.textContent = '应用失败：没找到目标消息或保存失败。';
                status.classList.add('so-hint-error');
                btn.disabled = false;
            }
        } catch (e) {
            status.textContent = '应用失败：' + (e?.message || e);
            status.classList.add('so-hint-error');
            btn.disabled = false;
        }
    });
}

// Apply / Undo bar appended to a lorebook reply that contains a <LorebookEdit>
// block. Mirrors addApplyControls, but writes through saveWorldInfo and snapshots
// every touched book for a one-click revert.
function addLorebookApplyControls(assistantEl, parsed) {
    const ops = (parsed && parsed.ops) || [];
    const errors = (parsed && parsed.errors) || [];
    const bubble = assistantEl.querySelector('.so-bubble');

    const bar = document.createElement('div');
    bar.className = 'so-apply-bar';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 将改动应用到世界书';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
    bar.appendChild(btn);
    bar.appendChild(status);
    bubble.appendChild(bar);

    // Per-op outcomes, rendered after Apply.
    const resultsEl = document.createElement('div');
    resultsEl.className = 'so-lb-results';
    bubble.appendChild(resultsEl);

    // Surface any blocks we couldn't parse — never silently drop them.
    if (errors.length) {
        const e = document.createElement('div');
        e.className = 'so-lb-parse-errors so-hint-error';
        e.textContent = `另有 ${errors.length} 处改动无法解析（已忽略）：` + errors.map((x) => x.error).join('；');
        bubble.appendChild(e);
    }

    if (!ops.length) {
        btn.disabled = true;
        status.classList.add('so-hint-error');
        status.textContent = errors.length
            ? '这次的改动没能解析出来。让我「把刚才的改动严格按格式重发一次」即可，或把改动拆小一点再试。'
            : '没有检测到可应用的改动。';
        scrollToBottom();
        return;
    }

    status.textContent = `待应用：${lbSummaryOf(ops)}`;
    scrollToBottom();

    const renderResults = (results) => {
        resultsEl.innerHTML = '';
        for (const r of results) {
            const line = document.createElement('div');
            line.className = 'so-lb-result ' + (r.ok ? 'so-lb-ok' : 'so-lb-skip');
            line.textContent = (r.ok ? '✓ ' : '⤫ ') + r.label + (r.ok ? '' : `（跳过：${r.reason}）`);
            resultsEl.appendChild(line);
        }
    };

    let snapshots = null;
    btn.addEventListener('click', async () => {
        status.classList.remove('so-hint-error');
        if (snapshots) {
            // currently applied -> undo
            btn.disabled = true;
            status.textContent = '正在还原…';
            try {
                await undoLorebookOps(snapshots);
                snapshots = null;
                resultsEl.innerHTML = '';
                btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 将改动应用到世界书';
                status.textContent = `已还原。待应用：${lbSummaryOf(ops)}`;
            } catch (e) {
                status.textContent = '还原失败：' + (e?.message || e);
                status.classList.add('so-hint-error');
            }
            btn.disabled = false;
            return;
        }
        btn.disabled = true;
        status.textContent = '正在应用…';
        try {
            const res = await applyLorebookOps(ops);
            renderResults(res.results);
            if (res.applied > 0) {
                snapshots = res.snapshots;
                btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 撤销';
                status.textContent = `已应用：${res.summary}。世界书已保存。`;
            } else {
                snapshots = null;
                status.textContent = '没有任何改动被应用（全部跳过，见下方原因）。';
                status.classList.add('so-hint-error');
            }
        } catch (e) {
            status.textContent = '应用失败：' + (e?.message || e);
            status.classList.add('so-hint-error');
        }
        btn.disabled = false;
        scrollToBottom();
    });
}

// 纯函数：解析两段式校正输出。<problems>（违规片段定位，可在前、可缺闭合）+ <FixedReply>（修正稿，容忍缺闭合）。
// 无 <FixedReply> 或正文为空 → null。可单测。
function parseFixedReply(text) {
    const src = String(text || '');
    const open = src.match(/<FixedReply\b[^>]*>/i);
    if (!open) return null;
    const rest = src.slice(open.index + open[0].length);
    const close = rest.match(/<\/FixedReply\s*>/i);
    const fixed = (close ? rest.slice(0, close.index) : rest).trim();
    if (!fixed) return null;
    let problems = '';
    const po = src.match(/<problems\b[^>]*>/i);
    if (po) {
        const after = src.slice(po.index + po[0].length);
        const pc = after.match(/<\/problems\s*>/i);
        if (pc) problems = after.slice(0, pc.index).trim();
        else { const fr = after.match(/<FixedReply\b[^>]*>/i); problems = (fr ? after.slice(0, fr.index) : after).trim(); }
    }
    return { fixed, problems };
}

// 纯函数：手动校正的宽容解析（recovery + 截断守卫）。仅手动模式用；自动仍用严格 parseFixedReply。
// 恢复顺序（先命中先返回）：① 有 <FixedReply> → parseFixedReply（干净两端定界，向后兼容/容忍缺闭合）；
// ② 无可用 <FixedReply> 但有【闭合的】<fix_think>…</fix_think> → </fix_think> 之后的正文；③ 连 <fix_think>
// 都没有 → 整条回复即答案；④ <fix_think> 开了没闭 + 无 <FixedReply> → 判【截断】。剥思维链标签 + 抠掉残留
// 结构标记（<fix_think>/<FixedReply>），避免它们混进被应用的正文。<fix_think> 标签名须与 FIX_SYSTEM_PROMPT_MANUAL 同步。可单测。
function parseManualFix(text) {
    const src = String(text || '');
    const strip = (s) => stripReasoningTags(s)
        .replace(/<\/?fix_think\b[^>]*>/gi, '')
        .replace(/<\/?FixedReply\b[^>]*>/gi, '')
        .trim();
    // ① 显式 <FixedReply>（干净路径，向后兼容）
    const strict = parseFixedReply(src);
    if (strict && strict.fixed) return { fixed: strict.fixed };
    // ②/④ 看 <fix_think>
    const open = src.match(/<fix_think\b[^>]*>/i);
    if (open) {
        const rest = src.slice(open.index + open[0].length);
        const close = rest.match(/<\/fix_think\s*>/i);
        if (!close) return { truncated: true };                 // ④ 开了没闭 + 无 FixedReply → 截断
        const after = strip(rest.slice(close.index + close[0].length));
        return after ? { fixed: after } : { truncated: true };  // ② 闭合后的正文；空 → 也当截断
    }
    // ③ 无 fix_think、无 FixedReply → 整条即答案
    const whole = strip(src);
    return whole ? { fixed: whole } : null;
}

// 纯函数：按模式选解析器 + 归一成状态。手动 → parseManualFix（宽容 + 截断守卫）；其余（自动）→ parseFixedReply（严格）。
// 返回 { status, fixed, problems }：status ∈ 'ok'|'truncated'|'unparseable'。renderFixCard 据 status 分派 DOM。可单测。
function parseFixReply(text, mode) {
    if (mode === 'manual') {
        const r = parseManualFix(text);
        if (!r) return { status: 'unparseable', fixed: '', problems: '' };
        if (r.truncated) return { status: 'truncated', fixed: '', problems: '' };
        return { status: 'ok', fixed: r.fixed, problems: '' };
    }
    const parsed = parseFixedReply(text);
    if (!parsed) return { status: 'unparseable', fixed: '', problems: '' };
    return { status: 'ok', fixed: parsed.fixed, problems: parsed.problems };
}

/* ------------------------------------------------------------------ *
 * 参谋方案区块的解析与「开始引导」卡片。
 * <StoryPlan> 用「键: 值」逐行解析（容错中英文键名与全角冒号）；解析不出 goal
 * 的区块直接忽略——卡片是加分项而非硬依赖，模型不出区块时回复照常显示。
 * ------------------------------------------------------------------ */
function parseStoryPlans(text) {
    const out = [];
    const re = /<StoryPlan>([\s\S]*?)<\/StoryPlan>/gi;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
        const inner = m[1];
        const get = (keys) => {
            for (const k of keys) {
                const r = new RegExp('^\\s*' + k + '\\s*[:：]\\s*(.+)$', 'mi');
                const mm = inner.match(r);
                if (mm && mm[1].trim()) return mm[1].trim();
            }
            return '';
        };
        const goal = get(['goal', '目标']);
        if (!goal) continue;
        out.push({
            goal,
            title: get(['title', '标题', '方案']),
            seed: get(['seed', '起始迹象', '种子']),
            why: get(['why', '契合点', '理由']),
        });
    }
    return out;
}

// Render one adopt card per parsed plan under the advisor reply. Third instance
// of the parse-block -> action-button pattern (after Diagnose / Lorebook), and
// the simplest: adoption is metadata + one setExtensionPrompt call, no ST write
// APIs with failure modes.
function addPlanControls(assistantEl, plans) {
    const bubble = assistantEl.querySelector('.so-bubble');
    const wrap = document.createElement('div');
    wrap.className = 'so-plan-cards';

    for (const p of plans) {
        const card = document.createElement('div');
        card.className = 'so-plan-card';
        let intensity = 'normal';

        const head = document.createElement('div');
        head.className = 'so-plan-card-title';
        head.textContent = p.title || p.goal;
        card.appendChild(head);

        if (p.title) {
            const goalEl = document.createElement('div');
            goalEl.className = 'so-plan-card-line';
            goalEl.textContent = '目标：' + p.goal;
            card.appendChild(goalEl);
        }
        if (p.why) {
            const whyEl = document.createElement('div');
            whyEl.className = 'so-plan-card-line so-plan-card-dim';
            whyEl.textContent = '契合点：' + p.why;
            card.appendChild(whyEl);
        }
        if (p.seed) {
            const seedEl = document.createElement('div');
            seedEl.className = 'so-plan-card-line so-plan-card-dim';
            seedEl.textContent = '起始迹象：' + p.seed;
            card.appendChild(seedEl);
        }

        const seg = document.createElement('div');
        seg.className = 'so-plan-intensity';
        const caption = document.createElement('div');
        caption.className = 'so-hint so-plan-card-caption';
        const renderSeg = () => {
            seg.innerHTML = '';
            for (const [key, I] of Object.entries(ADVISOR_INTENSITIES)) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'so-plan-int' + (intensity === key ? ' active' : '');
                b.textContent = I.label;
                b.addEventListener('click', () => { intensity = key; renderSeg(); });
                seg.appendChild(b);
            }
            caption.textContent = (ADVISOR_INTENSITIES[intensity] || ADVISOR_INTENSITIES.normal).caption;
        };
        renderSeg();
        card.appendChild(seg);
        card.appendChild(caption);

        const actions = document.createElement('div');
        actions.className = 'so-plan-card-actions';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'so-apply-btn';
        btn.innerHTML = '<i class="fa-solid fa-compass"></i> 开始引导';
        btn.addEventListener('click', () => {
            adoptPlan(p, intensity);
            // Mark this card as the adopted one; others stay usable (clicking
            // another replaces the plan, with an explicit note — single-goal rule).
            wrap.querySelectorAll('.so-plan-card').forEach((c) => c.classList.remove('so-plan-adopted'));
            card.classList.add('so-plan-adopted');
        });
        actions.appendChild(btn);
        card.appendChild(actions);

        wrap.appendChild(card);
    }

    bubble.appendChild(wrap);
    scrollToBottom();
}

// Typing-dots indicator placed inside an assistant bubble until the first token.
function showTyping(contentEl) {
    const dots = document.createElement('span');
    dots.className = 'so-typing';
    dots.innerHTML = '<i></i><i></i><i></i>';
    contentEl.appendChild(dots);
    let cleared = false;
    return () => {
        if (cleared) return;
        cleared = true;
        dots.remove();
    };
}

function addSystemNote(text) {
    const wrap = document.createElement('div');
    wrap.className = 'so-note';
    wrap.textContent = text;
    messagesEl.appendChild(wrap);
    scrollToBottom();
}

// 模式进入 / 退出 / 自动开关的说明：仅在侧聊已有内容时才作为系统记录追加。侧聊为空时，落地模式
// 专属的空状态（引导语 + 示例 chip）已充当介绍，再叠一段说明反而冗余（用户选择方案 A）。
function modeEntryNote(text) {
    if (convo.length) addSystemNote(text);
}

// 持久化的「系统记录」气泡（目前用于自动诊断的修复记录）。带 entry（写进 convo → 持久化 → 重载可
// 重建），左对齐、补丁可滚动。opts.{snapshot,patch} 提供时挂一个「撤销 / 重新应用」按钮（仅改动型记录、
// 仅本会话）——重载后 loadConvoForChat 不传 opts，记录变只读（重放旧补丁不安全，与手动诊断回复重载后
// 失去按钮一致）。
function addNoteMessage(entry, opts) {
    const empty = messagesEl.querySelector('.so-empty');
    if (empty) empty.remove();
    const wrap = document.createElement('div');
    wrap.className = 'so-note so-note-record';
    if (entry) wrap.dataset.cid = entry.id;
    const txt = document.createElement('div');
    txt.className = 'so-note-record-text';
    txt.textContent = entry ? entry.content : '';
    wrap.appendChild(txt);
    if (opts && opts.snapshot && opts.patch) addNoteUndoControls(wrap, opts.snapshot, opts.patch);
    else if (opts && opts.fix) addAutoFixControls(wrap, opts.fix);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return wrap;
}

function renderEmptyState() {
    if (convo.length || messagesEl.children.length) return;
    const m = MODE_EMPTY[currentOracleMode()] || MODE_EMPTY.chat;
    const wrap = document.createElement('div');
    wrap.className = 'so-empty';
    let html = `<i class="fa-solid ${m.icon} so-empty-icon"></i>` +
        `<div class="so-empty-line">${m.lead}</div>`;
    if (m.sub) html += `<div class="so-empty-sub">${m.sub}</div>`;
    wrap.innerHTML = html;
    // 示例问题 chip：每种模式一组（见 MODE_EMPTY）。点一下把问题填进输入框并聚焦，直接回车即可
    // 发送，由该模式的发送管线处理。chip 是真正的 <button>，键盘可达（与 Tier 1 一致）。
    const chips = document.createElement('div');
    chips.className = 'so-empty-chips';
    for (const q of m.chips) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'so-empty-chip';
        chip.textContent = q;
        chip.addEventListener('click', () => {
            inputEl.value = q;
            inputEl.dispatchEvent(new Event('input'));   // 触发自动高度 / 发送键状态
            inputEl.focus();
        });
        chips.appendChild(chip);
    }
    wrap.appendChild(chips);
    messagesEl.appendChild(wrap);
}

async function clearConversation() {
    // 清空会连带删除本聊天已保存的侧聊历史（含自动诊断记录），无法撤销——与本扩展其它破坏性
    // 操作（清空概要 / 重置提示词 / 退出弧线）保持一致，先确认再执行。空对话则无需打扰直接返回。
    if (convo.length && !(await uiConfirm('确定清空本聊天的侧聊历史吗？此操作会删除已保存的记录，无法撤销。'))) return;
    convo = [];
    persistConvo();   // 用户功能请求：手动清空也清掉本聊天保存的历史（删元数据键）
    messagesEl.innerHTML = '';
    renderEmptyState();
}

/* ------------------------------------------------------------------ *
 * 用户功能请求：per-chat 侧聊历史的载入端 + 运行概要编辑器的 UI 刷新。
 * ------------------------------------------------------------------ */
// 从本聊天的元数据重建侧聊窗口。chat 切换 / 首次载入时调用（onChatChanged）。先中止任何在途
// 生成，避免流式气泡继续写到被清掉的 DOM 上。
function loadConvoForChat() {
    if (!messagesEl) return;                       // 窗口还没建好（极早期）——略过，init 末尾会再调一次
    if (isGenerating && abortCtl) { try { abortCtl.abort(); } catch (e) { /* ignore */ } }
    const saved = getConvoMeta();
    convo = saved
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'note') && typeof m.content === 'string')
        .map((m) => ({ id: m.id, role: m.role, content: m.content }));
    cidSeq = convo.reduce((mx, m) => Math.max(mx, Number(m.id) || 0), cidSeq);
    messagesEl.innerHTML = '';
    if (!convo.length) { renderEmptyState(); return; }
    for (const m of convo) { m._el = (m.role === 'note') ? addNoteMessage(m) : addMessage(m.role, m.content, m); }
    scrollToBottom();
}

// 打开运行概要编辑器（叠层，仿 openDebug）。
function openSummary() {
    if (!win) return;
    const ta = win.querySelector('#so-summary-text');
    if (ta) ta.value = getSummary();
    updateSummaryIndicator(ta ? ta.value : getSummary());
    win.querySelector('#so-summary').classList.add('open');
    if (ta) ta.focus();
}

// 把本聊天的运行概要载入文本框 + 刷新字数 / 图标小红点。切换聊天 / 首次载入时调用。
function refreshSummaryUI() {
    if (!win) return;
    const ta = win.querySelector('#so-summary-text');
    const text = getSummary();
    if (ta && document.activeElement !== ta) ta.value = text;   // 别在用户正打字时覆盖
    updateSummaryIndicator(text);
}

// 概要图标的「有内容」小红点 + 编辑器底部字数。text 传 null 时现读元数据。
function updateSummaryIndicator(text) {
    if (!win) return;
    const t = String(text == null ? getSummary() : text);
    const btn = win.querySelector('#so-summary-btn');
    if (btn) btn.classList.toggle('so-has-summary', !!t.trim());
    const count = win.querySelector('#so-summary-count');
    if (count) count.textContent = t.trim() ? `${t.length} 字` : '（空——不会注入）';
}

// 流式滚动策略（用户反馈：流式时被一直拽到底、读不了开头）：新回复气泡出现时把它的【顶部】对到可视区顶部，
// 让用户从头读；流式过程中默认【不】跟随，只有当用户自己滚到底部（soFollowStream=true）时才跟随最新输出。
// soProgScroll 标记「我们自己触发的滚动」，避免被 scroll 监听器误当成用户操作。
let soFollowStream = false;
let soProgScroll = false;
function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
}
function scrollToBottom() {
    soProgScroll = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    try { requestAnimationFrame(() => { soProgScroll = false; }); } catch (e) { soProgScroll = false; }
}
// 把某条气泡的顶部对到消息区顶部（留 6px），让流式回复从开头开始读。
function scrollBubbleToTop(el) {
    if (!el) return;
    soProgScroll = true;
    const cRect = messagesEl.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    messagesEl.scrollTop = Math.max(0, messagesEl.scrollTop + (eRect.top - cRect.top) - 6);
    try { requestAnimationFrame(() => { soProgScroll = false; }); } catch (e) { soProgScroll = false; }
}
// 输入框自动增高（用户反馈：粘贴大段文字时输入框太小）：高度随内容增长，最多到神谕窗口高度的一半，再内部滚动。
function computeInputHeight(scrollH, winH, minH = 46) {
    const cap = Math.max(minH, Math.round((Number(winH) || 0) * 0.5));
    return Math.max(minH, Math.min(Number(scrollH) || minH, cap));
}
function autoGrowInput() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    const winH = (win && win.clientHeight) || window.innerHeight || 540;
    inputEl.style.height = computeInputHeight(inputEl.scrollHeight, winH) + 'px';
}

/* ------------------------------------------------------------------ *
 * Window dragging + resize persistence
 * ------------------------------------------------------------------ */
// Clamp the window into the viewport on first open, sized so it always fits the
// screen (so phones never get a window wider/taller than the display). On a small
// screen with no saved position, drop it near the top, horizontally centered.
function applyInitialGeometry(s) {
    const margin = 8;
    const w = Math.max(300, Math.min(s.winWidth || 380, window.innerWidth - margin * 2));
    const h = Math.max(320, Math.min(s.winHeight || 540, window.innerHeight - margin * 2));
    win.style.width = `${w}px`;
    win.style.height = `${h}px`;
    if (s.winLeft != null && s.winTop != null) {
        win.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, s.winLeft))}px`;
        win.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, s.winTop))}px`;
        win.style.right = 'auto';
    } else if (window.innerWidth < 600) {
        // 手机首次开窗（无存档几何）：居中（含纵向），标题栏不再贴顶被状态栏 / 刘海挡住
        //（用户反馈：手机版按钮挤在最顶上、不好戳）。仅无存档几何时；用户拖过就尊重其位置。
        const vv = window.visualViewport;
        const c = centeredWindowBox(
            { w: (vv && vv.width) || window.innerWidth, h: (vv && vv.height) || window.innerHeight, offX: (vv && vv.offsetLeft) || 0, offY: (vv && vv.offsetTop) || 0 },
            { width: w, height: h },
        );
        win.style.left = `${c.left}px`;
        win.style.top = `${c.top}px`;
        win.style.width = `${c.width}px`;
        win.style.height = `${c.height}px`;
        win.style.right = 'auto';
    } // else: desktop keeps the CSS default (top:70px right:20px)
}

// 把一个窗口盒子夹进【可见】视口（visualViewport），保证整窗——尤其顶部带 ✕ 关闭 / 拖动把手的
// 标题栏——始终在屏内。纯函数、可单测：box={left,top,width,height}（CSS 像素），view={w,h,offX,offY}
//（offX/offY 是手机键盘弹出时 visualViewport 的偏移，桌面为 0）。先按可见区给宽高封顶，再夹 left/top。
function clampWindowBox(box, view) {
    const margin = 8, minW = 300, minH = 320;
    const offX = view.offX || 0, offY = view.offY || 0;
    const width = Math.max(minW, Math.min(box.width, view.w - margin * 2));
    const height = Math.max(minH, Math.min(box.height, view.h - margin * 2));
    const left = Math.max(offX + margin, Math.min(box.left, offX + view.w - width - margin));
    const top = Math.max(offY + margin, Math.min(box.top, offY + view.h - height - margin));
    return { left, top, width, height };
}

// 纯函数：把一个盒子【居中】进【可见】视口并把尺寸夹进视口，返回 {left,top,width,height}（CSS 像素）。
// clampWindowBox 的姊妹（同 margin/minW/minH），但这里是【主动居中到默认几何】而非就地夹取：用于手机
// 首次开窗居中（applyInitialGeometry）与魔棒菜单「窗口归位」一键复位（recenterWindow）。view={w,h,offX,offY}
//（offX/offY = 软键盘弹出时 visualViewport 偏移，缺省 0）；opts.width/height 缺省 380×540（与初始默认一致）。
// 单测 window-recenter.test.mjs。
function centeredWindowBox(view, opts) {
    const margin = 8, minW = 300, minH = 320;
    const v = view || {};
    const vw = v.w || 0, vh = v.h || 0, offX = v.offX || 0, offY = v.offY || 0;
    const width = Math.max(minW, Math.min((opts && opts.width) || 380, vw - margin * 2));
    const height = Math.max(minH, Math.min((opts && opts.height) || 540, vh - margin * 2));
    const left = offX + Math.max(margin, Math.round((vw - width) / 2));
    const top = offY + Math.max(margin, Math.round((vh - height) / 2));
    return { left, top, width, height };
}

// 把当前窗口重新夹回可见视口（开窗 / 旋屏 / 键盘弹收时调用）。宽高基准取「用户存的几何」或与
// applyInitialGeometry 一致的默认（380×540），这样键盘压扁后收起还能长回原尺寸。【不 save()】——
// 这只是临时贴合显示，不覆盖用户拖 / 拽存下来的几何。
function ensureWindowInView() {
    if (!win || win.style.display === 'none') return;
    autoGrowInput();                                        // #4 窗口尺寸变化时重算输入框高度上限（上限=窗口高度一半）
    const s = getSettings();
    const vv = window.visualViewport;
    const view = {
        w: (vv && vv.width) || window.innerWidth,
        h: (vv && vv.height) || window.innerHeight,
        offX: (vv && vv.offsetLeft) || 0,
        offY: (vv && vv.offsetTop) || 0,
    };
    const r = win.getBoundingClientRect();
    const box = {
        left: (s.winLeft != null) ? s.winLeft : r.left,
        top: (s.winTop != null) ? s.winTop : r.top,
        width: s.winWidth || 380,
        height: s.winHeight || 540,
    };
    const c = clampWindowBox(box, view);
    win.style.width = `${c.width}px`;
    win.style.height = `${c.height}px`;
    win.style.left = `${c.left}px`;
    win.style.top = `${c.top}px`;
    win.style.right = 'auto';
}

// 视口变化会连发很多次（键盘动画 / 旋屏过渡）——合并到下一帧只夹一次，避免抖动。
let _ensureInViewPending = false;
function scheduleEnsureInView() {
    if (_ensureInViewPending) return;
    _ensureInViewPending = true;
    requestAnimationFrame(() => { _ensureInViewPending = false; ensureWindowInView(); });
}

// Drag the window by its header. Pointer events cover mouse + touch + pen in one
// path; pointer capture keeps tracking even when the finger leaves the header.
// 拖动 vs 轻点判定（纯函数，单测钉 plan-float-drag.test.mjs）：
// dragShouldBegin —— 一次 pointerdown 该不该开始拖动。落在按钮 / .so-iconbtn 上时默认不拖（让它响应点击）；
//   但折叠态的「指南针小药丸」整张可点面就是那颗罗盘按钮（#so-plan-float-collapse），靠 dragFromButtons=true
//   放行「在按钮上也能起拖」，再用下面的位移阈值区分轻点（展开）/拖动（移动）。真机 bug 修复点（Discord 白鳥三津枝）。
// dragExceededThreshold —— 指针自按下点的位移是否已超过「这是拖动而非轻点」的阈值（按 hypot 距离，避免手指微抖被当拖动）。
const DRAG_THRESHOLD = 6;  // 像素：超过它，一次按压才从「轻点」升级为「拖动」
function dragShouldBegin({ onButton, secondaryButton, dragFromButtons }) {
    if (secondaryButton) return false;               // 鼠标右键 / 中键不拖
    if (onButton && !dragFromButtons) return false;  // 普通：让按钮自己响应点击
    return true;
}
function dragExceededThreshold(dx, dy) {
    return (dx * dx + dy * dy) > (DRAG_THRESHOLD * DRAG_THRESHOLD);
}
// 一次性吞掉「拖动后浏览器仍会补发的那一下 click」—— 否则在按钮上拖完会顺带触发它
// （如把折叠药丸拖一下，松手又被那颗罗盘的 click 展开）。捕获阶段挂在把手（按钮的祖先）上抢先拦下；
// 300ms 后自动撤除，绝不误吞之后一次正经的轻点。
function suppressNextClick(el) {
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    el.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 300);
}

function makeDraggable(panel, handle, keys = { left: 'winLeft', top: 'winTop' }, opts = {}) {
    // opts.dragFromButtons: () => boolean —— pointerdown 时若为 true，落在按钮上也可起拖（折叠药丸专用，
    //   它整张面就是那颗按钮）；配合位移阈值，没动够阈值仍算轻点，按钮自己的 click 照常触发。
    let sx, sy, sl, st, pid = null, moved = false, fromButton = false;
    handle.style.touchAction = 'none';   // stop the page scrolling under a drag
    handle.addEventListener('pointerdown', (e) => {
        const onButton = !!(e.target.closest('button') || e.target.closest('.so-iconbtn'));
        const dragFromButtons = typeof opts.dragFromButtons === 'function' && opts.dragFromButtons();
        if (!dragShouldBegin({ onButton, secondaryButton: e.button != null && e.button > 0, dragFromButtons })) return;
        pid = e.pointerId;
        moved = false;
        fromButton = onButton;            // 起手就在按钮上 → 真拖完要吞那下补发的 click
        const r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        panel.style.right = 'auto';
        document.body.style.userSelect = 'none';
        try { handle.setPointerCapture(pid); } catch (_) { /* ignore */ }
    });
    handle.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pid) return;
        if (!moved && !dragExceededThreshold(e.clientX - sx, e.clientY - sy)) return; // 阈值内仍算轻点，先不动
        moved = true;
        const nl = Math.max(0, Math.min(window.innerWidth - 60, sl + e.clientX - sx));
        const nt = Math.max(0, Math.min(window.innerHeight - 40, st + e.clientY - sy));
        panel.style.left = `${nl}px`;
        panel.style.top = `${nt}px`;
    });
    const end = (e) => {
        if (pid == null || (e && e.pointerId !== pid)) return;
        try { handle.releasePointerCapture(pid); } catch (_) { /* ignore */ }
        pid = null;
        document.body.style.userSelect = '';
        if (!moved) { fromButton = false; return; }  // 只是轻点：放行 click（如展开），位置没变就不保存
        if (fromButton) { suppressNextClick(handle); fromButton = false; } // 拖动起于按钮 → 吞掉补发的 click
        const s = getSettings();
        s[keys.left] = parseInt(panel.style.left, 10);
        s[keys.top] = parseInt(panel.style.top, 10);
        save();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
}

// Resize the window by dragging the bottom-right grip — same pointer-capture
// approach, so it works with a finger. Clamped to the viewport so the size we
// store never exceeds the screen.
function makeResizable(panel, grip) {
    if (!grip) return;
    let sx, sy, sw, sh, left, top, pid = null;
    grip.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button > 0) return;
        pid = e.pointerId;
        const r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; left = r.left; top = r.top;
        document.body.style.userSelect = 'none';
        try { grip.setPointerCapture(pid); } catch (_) { /* ignore */ }
        e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pid) return;
        const minW = 300, minH = 320;
        const maxW = Math.max(minW, window.innerWidth - left - 6);
        const maxH = Math.max(minH, window.innerHeight - top - 6);
        panel.style.width = `${Math.max(minW, Math.min(maxW, sw + e.clientX - sx))}px`;
        panel.style.height = `${Math.max(minH, Math.min(maxH, sh + e.clientY - sy))}px`;
    });
    const end = (e) => {
        if (pid == null || (e && e.pointerId !== pid)) return;
        try { grip.releasePointerCapture(pid); } catch (_) { /* ignore */ }
        pid = null;
        document.body.style.userSelect = '';
        const s = getSettings();
        s.winWidth = panel.offsetWidth;
        s.winHeight = panel.offsetHeight;
        save();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
}
