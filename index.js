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

四种 action：

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

· patch（局部修改已有条目）—— 修改已有条目时【优先用它】，不必重发整条：
用 anchor 圈出要替换的范围：开头 3-4 个字 +「 || 」+ 结尾 3-4 个字；新文本放进 <<<replace … replace>>>。要在某处「插入」而非整段覆盖，就把锚定的那一小段连同新内容一起写进 replace（即在新文本里把开头、结尾那几个字也照抄上）。
<LorebookEdit>
action: patch
book: 世界书名
uid: 12
anchor: 开头几个字 || 结尾几个字
<<<replace
（用来替换 anchor 所圈范围的新文本）
replace>>>
</LorebookEdit>

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

· delete（删除条目）：
<LorebookEdit>
action: delete
book: 世界书名
uid: 7
</LorebookEdit>

可用的元信息键：comment（标题）、key / keysecondary（关键词，用逗号分隔）、constant（常驻，true/false）、disable（禁用，true/false）、selective（关键词触发，true/false）、excludeRecursion（非递归，true/false）、preventRecursion（不触发后续递归，true/false）、order（顺序，数字）、position（位置，数字）、depth（深度，数字）。其它键会被忽略。

规则：
- book 与 uid 必须照抄上面列出的条目，绝不要自己编造，也绝不要去动没有列出的条目。书名里若带《》「」【】<> 等符号，请连同符号一字不差地照抄（这些最容易被漏写）。
- 新建条目默认就是「非递归 + 不触发后续递归」；若没给 key 且没显式写 constant，则默认设为常驻。需要让新条目参与递归时，自己写 excludeRecursion: false / preventRecursion: false。
- 写新建或编辑的正文时，请沿用这本世界书现有条目的格式与风格（缩进、<scene_xxx> 包裹、「键: 值」式的层级），让新内容与周围保持一致。
- 正文会原样保存、不做任何宏替换：{{user}} 之类、人物本名、缩进结构都会原封不动地写进条目。
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

// 剧情参谋总开关（v1.14.2）：false = 完全隐藏参谋模式——🧭 按钮、注入深度设置
// 项不显示，注入与方案条、提醒一律停用；代码全部保留。要启用：把它改成 true
// 即可，无其它步骤。当前关闭：先自测，再放给社区。
const ENABLE_ADVISOR_MODE = false;

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
    applyRegex: true,          // run ST's prompt-altering regex (thinking strip, summaries, etc.)
    worldInfoMode: 'off',      // 'off' | 'st' (constant + keyword) | 'all' (every entry)
    sendTemperature: true,     // include temperature in the request (some models reject it)
    // Lorebook mode: which book(s) to load. '' = every currently-active book;
    // otherwise the exact name of a single world book.
    lorebookTarget: '',
    // Whether lorebook mode also feeds the recent story transcript as context
    // (off by default — lorebook mode focuses on the books, not the RP).
    lorebookIncludeStory: false,
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
let advStatData = '';       // stringified current MVU stat_data for advisor sends
                            // (computed fresh in generateReply, '' when no MVU)
let planBarEl = null;       // the ONE plan strip element — lives inside the window
                            // OR reparented into the floating container (never both)
let planFloat = null;       // floating container shown when window closed + plan active
let planFloatSlot = null;
// Per-entry selection for a single targeted book: { [bookName]: Set<uid> }.
// A book absent here (or null) means "send every entry" (the default).
let lbEntryFilter = {};
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

function getSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[MODULE] || typeof ctx.extensionSettings[MODULE] !== 'object') {
        ctx.extensionSettings[MODULE] = {};
    }
    const s = ctx.extensionSettings[MODULE];
    // Fill in any missing defaults IN PLACE so the reference stays stable.
    // (Rebuilding the object here would orphan the values written by event handlers.)
    for (const [k, v] of Object.entries(defaults)) {
        if (!(k in s)) s[k] = v;
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

/**
 * Build the world-info / lorebook block for the system prompt.
 *   'st'  -> faithful ST scan: constant (blue) entries always, keyword (green)
 *            entries only when their keys match the chat/card. Uses a dry run so
 *            it never disturbs the main chat's sticky/cooldown state.
 *   'all' -> every non-disabled entry from the active books, regardless of keys.
 */
async function buildWorldInfo(forceMode) {
    const ctx = getCtx();
    const s = getSettings();
    const mode = forceMode || s.worldInfoMode;
    if (mode === 'off') return '';

    try {
        if (mode === 'all') {
            const mod = await loadWorldInfoModule();
            if (!mod || !mod.getSortedEntries) return '';
            const entries = await mod.getSortedEntries();
            return (entries || [])
                .filter((e) => e && !e.disable && typeof e.content === 'string' && e.content.trim())
                .map((e) => e.content.trim())
                .join('\n\n');
        }

        // 'st' mode — replicate ST's scan input.
        if (typeof ctx.getWorldInfoPrompt !== 'function') return '';
        const coreChat = (ctx.chat || []).filter((m) => m && !m.is_system && typeof m.mes === 'string');
        const chatForWI = coreChat
            .map((m) => `${m.name || (m.is_user ? ctx.name1 : ctx.name2)}: ${m.mes}`)
            .reverse(); // most-recent first, as ST does

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

        const budget = Number(ctx.maxContext) > 0 ? Number(ctx.maxContext) : 1048576;
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

        return parts.join('\n\n').trim();
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

        const budget = Number(ctx.maxContext) > 0 ? Number(ctx.maxContext) : 1048576;
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

        return { before: beforeParts.join('\n\n').trim(), after: afterParts.join('\n\n').trim() };
    } catch (e) {
        console.warn('[Story Oracle] World info split failed:', e);
        return { before: '', after: '' };
    }
}

/*
 * Collect the card's [mvu_update] rule entries straight from the stored
 * world books, bypassing the live WI scan.
 *
 * Why this is needed: MagVarUpdate, in "extra-model-parsing" update mode,
 * strips pure [mvu_update] entries from the lore arrays on the
 * `worldinfo_entries_loaded` event. That event fires inside getSortedEntries,
 * upstream of BOTH getWorldInfoPrompt ('st') and getSortedEntries ('all'),
 * so neither scan mode can see those entries. loadWorldInfo() reads the raw
 * cached book data, which MVU never mutates, so it always sees them.
 *
 * Matching mirrors MVU's own UPDATE_REGEX exactly: /[mvu_update]/i on the
 * comment. Constant-only and enabled-only, per the Diagnose use case.
 * `existingBlock` is the already-built scan block, used to dedupe so we don't
 * repeat an entry the scan already included (e.g. on a non-extra-parsing card).
 */
const MVU_UPDATE_TAG = /\[mvu_update\]/i;

async function collectMvuUpdateRules(existingBlock) {
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

    const seen = existingBlock || '';
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
            if (seen.includes(content)) continue;                 // already in the scan block
            if (collected.some((c) => c.content === content)) continue; // dupe across books
            collected.push({ order: Number(e.order) || 0, content });
        }
    }

    collected.sort((a, b) => a.order - b.order);
    return collected.map((c) => c.content);
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

    let names;
    if (s.lorebookTarget) {
        const all = await getAllBookNames();
        names = all.includes(s.lorebookTarget) ? [s.lorebookTarget] : [];
        if (!names.length) {
            lbContextText = `（找不到名为「${s.lorebookTarget}」的世界书。请在上方重新选择，或点刷新。）`;
            return;
        }
    } else {
        names = await getActiveBookNames();
        if (!names.length) {
            lbContextText = '（当前没有激活任何世界书。可在上方下拉里直接选择某一本来编辑。）';
            return;
        }
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
        // Per-entry selection only applies to a single targeted book. A Set (even
        // empty) means "send exactly these"; null/absent means "send all". Apply
        // still re-reads the whole book, so editing any uid keeps working.
        const sel = s.lorebookTarget ? lbEntryFilter[name] : null;
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
    // Macros inside entry content (e.g. {{user}}) — resolve for readability.
    try { lbContextText = ctx.substituteParams(lbContextText); } catch (e) { /* leave raw */ }
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
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const mm = line.match(/^([A-Za-z_]+)\s*[:：]\s*(.*)$/);
        if (mm) headers[mm[1]] = mm[2];
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

    const ALLOWED = ['create', 'edit', 'patch', 'delete'];
    if (!ALLOWED.includes(action)) return { error: `未知或缺失的 action：「${(headers.action || '').trim()}」` };
    // book is resolved at apply time (against the books actually in scope), so a
    // mangled or omitted name no longer hard-fails here.
    if (action === 'create') {
        if (op.fields.content == null || !String(op.fields.content).trim()) return { error: 'create 缺少 content 正文' };
    } else if (op.uid == null || Number.isNaN(op.uid)) {
        return { error: `${action} 缺少有效的 uid` };
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
                const eM = norm.slice(afterIdx).match(lbFuzzyRegex(endA));
                if (!eM) return { result: src, matched: false };
                const end = afterIdx + eM.index + eM[0].length;
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
    const a = ({ create: '新增', edit: '改', patch: '补丁', delete: '删除' })[op.action] || op.action || '?';
    if (op.action === 'create') return `${a}「${(op.fields && op.fields.comment) || '(无标题)'}」`;
    return `${a} uid=${op.uid}`;
}
function lbSummaryOf(list) {
    const c = { create: 0, edit: 0, patch: 0, delete: 0 };
    for (const x of list) if (x && x.action in c) c[x.action]++;
    const bits = [];
    if (c.create) bits.push(`新增 ${c.create}`);
    if (c.edit) bits.push(`改 ${c.edit}`);
    if (c.patch) bits.push(`补丁 ${c.patch}`);
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

// Non-system message count of the MAIN chat — used to derive "messages since
// adoption" without keeping a counter in sync.
function chatMsgCount() {
    try {
        return (getCtx().chat || []).filter((m) => m && !m.is_system).length;
    } catch (e) { return 0; }
}

// Build the directive injected into the main chat. Derived ONLY from the plan.
// 用户优先条款是承重墙：没有它，模型会把目标当成硬性指标、跟用户抢方向盘。
function buildDirective(plan) {
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
        `节奏：${I.directive}`,
    );
    const text = lines.join('\n');
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
    const plan = getPlan();
    const s = getSettings();
    const pos = (ctx.extension_prompt_types && ctx.extension_prompt_types.IN_CHAT != null)
        ? ctx.extension_prompt_types.IN_CHAT : 1;                    // IN_CHAT
    const role = (ctx.extension_prompt_roles && ctx.extension_prompt_roles.SYSTEM != null)
        ? ctx.extension_prompt_roles.SYSTEM : 0;                     // SYSTEM
    const depth = Number.isFinite(s.advisorDepth) ? Math.max(0, s.advisorDepth) : 4;
    try {
        ctx.setExtensionPrompt(ADVISOR_PROMPT_KEY, plan ? buildDirective(plan) : '', pos, depth, false, role);
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
    const plan = getPlan();
    if (!plan || plan.reminded) return;
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
    applyPlanInjection();
    if (win) renderPlanBar();
    checkPlanReminder();
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

function getLatestAiMessageText() {
    const chat = getCtx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) return m.mes;
    }
    return '';
}

function extractUpdateBlock(text) {
    const m = (text || '').match(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i);
    return m ? m[0] : '';
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
    return snapshot;
}

async function undoFix(snapshot) {
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.replaceMvuData !== 'function') throw new Error('MVU not available');
    await Mvu.replaceMvuData(snapshot, { type: 'message', message_id: 'latest' });
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

    win.innerHTML = `
        <div id="so-header">
            <div id="so-title"><i class="fa-solid fa-moon"></i> 故事神谕 <span id="so-mode-badge"></span><span id="so-diag-pill">诊断</span><span id="so-lb-pill">世界书</span><span id="so-adv-pill">参谋</span></div>
            <div id="so-header-btns">
                <div class="so-iconbtn" id="so-advisor-btn" title="剧情参谋（实验性）—— 构思新剧情走向，并引导主线靠近它"><i class="fa-solid fa-compass"></i></div>
                <div class="so-iconbtn" id="so-lorebook-btn" title="世界书模式 —— 聊聊或修改世界书"><i class="fa-solid fa-book"></i></div>
                <div class="so-iconbtn" id="so-diagnose-btn" title="诊断模式 —— 修复 MVU 状态变量"><i class="fa-solid fa-stethoscope"></i></div>
                <div class="so-iconbtn" id="so-debug-btn" title="查看上一次发送的提示词"><i class="fa-solid fa-bug"></i></div>
                <div class="so-iconbtn" id="so-settings-btn" title="设置"><i class="fa-solid fa-gear"></i></div>
                <div class="so-iconbtn" id="so-clear-btn" title="清空对话"><i class="fa-solid fa-trash-can"></i></div>
                <div class="so-iconbtn" id="so-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>
        </div>

        <div id="so-settings">
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

            <div class="so-grid2">
                <label class="so-field"><span>温度</span>
                    <input id="so-temp" type="number" step="0.05" min="0" max="2">
                </label>
                <label class="so-field"><span>最大 token 数</span>
                    <input id="so-maxtok" type="number" step="50" min="1">
                </label>
            </div>

            <label class="so-check"><input id="so-stream" type="checkbox"><span>流式输出</span></label>

            <label class="so-field"><span>上下文深度（消息条数，-1 = 全部，0 = 不带）</span>
                <input id="so-depth" type="number" step="1" min="-1">
            </label>
            <label class="so-field"><span>剧情引导注入深度（参谋模式：方案指令插入主聊天的深度）</span>
                <input id="so-adv-depth" type="number" step="1" min="0">
            </label>
            <label class="so-check"><input id="so-card" type="checkbox"><span>包含角色卡（描述 / 性格 / 场景）</span></label>
            <label class="so-check"><input id="so-regex" type="checkbox"><span>应用剧情正则（剥离思维链 / 状态栏、使用总结）—— 与主聊天保持一致</span></label>

            <label class="so-row"><span>世界书 / 知识库</span>
                <select id="so-wi">
                    <option value="off">关闭</option>
                    <option value="st">常驻 + 关键词匹配（ST 默认行为）</option>
                    <option value="all">全部条目（规划用 —— 忽略关键词）</option>
                </select>
            </label>
            <div class="so-hint" id="so-wi-hint"></div>

            <label class="so-check"><input id="so-sendtemp" type="checkbox"><span>发送温度参数（部分拒收该参数的模型请关闭）</span></label>

            <label class="so-row"><span>说话人格</span>
                <select id="so-persona"></select>
            </label>
            <div class="so-hint">给神谕套一层“说话腔调”，只改变语气与文采，不改变其分析职责。选「普通」即关闭人格（默认）。使用预设时，人格默认关闭、以免与预设自带的角色声线冲突；若选择某个人格，它会叠加在预设之上。参谋 / 世界书模式下同样叠加（人格只改语气，方案与条目正文的格式不受影响）。诊断模式下不生效。</div>

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

            <label class="so-field"><span>系统提示词</span>
                <textarea id="so-sysprompt" rows="5"></textarea>
            </label>
        </div>

        <div id="so-lb-bar">
            <div class="so-lb-row">
                <i class="fa-solid fa-book so-lb-icon"></i>
                <select id="so-lb-book" title="选择要聊 / 编辑的世界书"></select>
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
                    <button type="button" class="so-lb-mini so-lb-mini-blue" id="so-lb-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button>
                    <button type="button" class="so-lb-mini so-lb-mini-green" id="so-lb-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button>
                    <button type="button" class="so-lb-mini so-lb-mini-off" id="so-lb-disabled" title="只选已禁用条目">仅禁用</button>
                </div>
                <input type="text" id="so-lb-entries-filter" class="so-lb-entries-filter" placeholder="筛选条目（标题 / 关键词 / uid）…">
                <div id="so-lb-entries-list" class="so-lb-entries-list"></div>
            </div>
            <div class="so-hint" id="so-lb-hint"></div>
        </div>

        <div id="so-adv-bar">
            <label class="so-check so-adv-check"><input id="so-adv-preset" type="checkbox"><span>套用我的补全预设（参谋指令叠加其上）</span></label>
            <div class="so-hint so-adv-preset-warn">⚠ 仅在确实需要预设里的越狱时才勾选：预设的额外内容会分散模型注意力。未整理过预设时勾它不报错，会自动退回内置参谋提示词。</div>
        </div>

        <div id="so-plan-bar">
            <div class="so-plan-head">
                <i class="fa-solid fa-compass so-plan-icon"></i>
                <span class="so-plan-label">引导中</span>
                <span id="so-plan-goal"></span>
            </div>
            <div class="so-plan-intensity" id="so-plan-intensity"></div>
            <div class="so-hint" id="so-plan-caption"></div>
            <div class="so-plan-actions">
                <button type="button" class="so-plan-mini" id="so-plan-show">▸ 查看注入内容</button>
                <span class="so-plan-spacer"></span>
                <button type="button" class="so-plan-mini so-plan-done" id="so-plan-done" title="目标已达成，停止引导">完成</button>
                <button type="button" class="so-plan-mini so-plan-drop" id="so-plan-drop" title="不再需要，停止引导">放弃</button>
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
        <div id="so-resize-grip" title="拖动调整大小" aria-label="调整窗口大小"></div>
    `;
    document.body.appendChild(win);

    messagesEl = win.querySelector('#so-messages');
    inputEl = win.querySelector('#so-input');
    sendBtn = win.querySelector('#so-send');
    modeBadge = win.querySelector('#so-mode-badge');

    bindControls();
    loadSettingsIntoForm();
    planBarEl = win.querySelector('#so-plan-bar');
    makeDraggable(win, win.querySelector('#so-header'));
    makeResizable(win, win.querySelector('#so-resize-grip'));
    renderEmptyState();
    renderPlanBar();
}

function bindControls() {
    const s = getSettings();

    win.querySelector('#so-close-btn').addEventListener('click', () => toggleWindow(false));
    win.querySelector('#so-clear-btn').addEventListener('click', clearConversation);
    win.querySelector('#so-diagnose-btn').addEventListener('click', toggleDiagnose);
    win.querySelector('#so-lorebook-btn').addEventListener('click', toggleLorebook);
    win.querySelector('#so-advisor-btn').addEventListener('click', toggleAdvisor);
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
        if (open) {
            const plan = getPlan();
            pre.textContent = plan ? buildDirective(plan) : '';
        }
    });
    win.querySelector('#so-plan-done').addEventListener('click', () => endPlan(true));
    win.querySelector('#so-plan-drop').addEventListener('click', () => endPlan(false));
    win.querySelector('#so-lb-refresh').addEventListener('click', () => populateLorebookBooks(true));
    win.querySelector('#so-lb-book').addEventListener('change', (e) => {
        const s2 = getSettings();
        s2.lorebookTarget = e.target.value; // '' = all active
        save();
        updateLbHint();
        populateLorebookEntries();           // refresh the per-entry picker for the new book
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
    win.querySelector('#so-lb-all').addEventListener('click', () => setAllLbEntries(true));
    win.querySelector('#so-lb-none').addEventListener('click', () => setAllLbEntries(false));
    win.querySelector('#so-lb-blue').addEventListener('click', () => setLbEntriesByType('blue'));
    win.querySelector('#so-lb-green').addEventListener('click', () => setLbEntriesByType('green'));
    win.querySelector('#so-lb-disabled').addEventListener('click', () => setLbEntriesByType('off'));
    win.querySelector('#so-lb-entries-filter').addEventListener('input', (e) => filterLbEntries(e.target.value));
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
    bind('#so-profile', 'profileId');
    bind('#so-temp', 'temperature', (v) => parseFloat(v));
    bind('#so-maxtok', 'maxTokens', (v) => parseInt(v, 10));
    bind('#so-depth', 'contextDepth', (v) => parseInt(v, 10));
    bind('#so-adv-depth', 'advisorDepth', (v) => parseInt(v, 10));
    // After bind() has written the new depth, re-register the active injection —
    // otherwise the setting silently applies only on the next chat switch.
    win.querySelector('#so-adv-depth').addEventListener('input', () => applyPlanInjection());
    bind('#so-card', 'includeCard');
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
    bind('#so-sysprompt', 'systemPrompt');

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
    win.querySelector('#so-regex').checked = !!s.applyRegex;
    win.querySelector('#so-wi').value = s.worldInfoMode;
    win.querySelector('#so-sendtemp').checked = !!s.sendTemperature;
    win.querySelector('#so-lb-story').checked = !!s.lorebookIncludeStory;
    win.querySelector('#so-lb-preset').checked = !!s.lorebookUsePreset;
    win.querySelector('#so-adv-preset').checked = !!s.advisorUsePreset;
    updateWiHint();
    populatePersonas();
    win.querySelector('#so-sysprompt').value = s.systemPrompt;
    populateSysPromptPresets();
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
    applySysPromptPresetUiState();
}

function applySysPromptPresetUiState() {
    const s = getSettings();
    const ta = win.querySelector('#so-sysprompt');
    const hint = win.querySelector('#so-sysprompt-preset-hint');
    const recurate = win.querySelector('#so-sysprompt-preset-recurate');
    const active = !!s.sysPromptPresetName;
    // When a preset is selected, the textarea (and the built-in short prompt it
    // holds) is fully disabled — no fallback, per design.
    if (ta) ta.disabled = active;
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
        inputEl.focus();
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
};

function currentOracleMode() {
    return diagnoseMode ? 'diagnose' : (lorebookMode ? 'lorebook' : (advisorMode ? 'advisor' : 'chat'));
}

function setOracleMode(target) {
    diagnoseMode = target === 'diagnose';
    lorebookMode = target === 'lorebook';
    advisorMode = target === 'advisor';
    win.classList.toggle('so-diag-on', diagnoseMode);
    win.classList.toggle('so-lb-on', lorebookMode);
    win.classList.toggle('so-adv-on', advisorMode);
    win.querySelector('#so-diagnose-btn').classList.toggle('so-diag-active', diagnoseMode);
    win.querySelector('#so-lorebook-btn').classList.toggle('so-lb-active', lorebookMode);
    win.querySelector('#so-advisor-btn').classList.toggle('so-adv-active', advisorMode);
    inputEl.placeholder = MODE_PLACEHOLDERS[target] || MODE_PLACEHOLDERS.chat;
}

function toggleDiagnose() {
    const entering = !diagnoseMode;
    setOracleMode(entering ? 'diagnose' : 'chat');
    if (entering) {
        addSystemNote('诊断模式已开启。我会把最新一条 AI 回复中的变量更新，对照本角色卡的 MVU 规则与当前状态进行检查，然后给出一份你可以一键应用的纠正补丁。可以让我检查它、指出哪里看起来不对，或者直接说“审计整个状态”。');
    } else {
        addSystemNote('已返回普通聊天模式。');
    }
    inputEl.focus();
}

function toggleLorebook() {
    const entering = !lorebookMode;
    setOracleMode(entering ? 'lorebook' : 'chat');
    if (entering) {
        populateLorebookBooks();
        addSystemNote('世界书模式已开启。我已读取选定世界书的全部条目——你可以问里面写了什么、找矛盾、聊扩写思路；也可以让我改写、新增或删除条目，我会给出一份你能一键应用（并可撤销）的改动。上方可切换要处理哪一本。');
    } else {
        addSystemNote('已返回普通聊天模式。');
    }
    inputEl.focus();
}

function toggleAdvisor() {
    const entering = !advisorMode;
    setOracleMode(entering ? 'advisor' : 'chat');
    if (entering) {
        addSystemNote('⚠️ 剧情参谋是实验性功能，行为可能随版本调整。\n剧情参谋模式已开启。我会通读整段对话，和你一起构思剧情接下来可以怎么走。讨论出具体方案后，我会把它列成卡片——点「开始引导」并选择强度（只铺垫 / 自然推进 / 尽快引爆），主聊天的 AI 就会被悄悄引导着把剧情推向那个方向。引导随时可在上方的方案条里查看、调整或停止。'
            + (getPlan() ? '\n当前已有一个方案在引导中——可以问我「检查进度」。' : ''));
        // 桥接：从普通模式聊到一半切过来时（侧聊有内容、且还没有方案在引导），
        // 给一个一键把刚才的讨论正式化成方案的入口。出现时机是确定性的——
        // 只在这一刻、只在这个条件下，绝不靠关键词探测。
        if (convo.length > 0 && !getPlan()) addBridgeChip();
    } else {
        addSystemNote('已返回普通聊天模式。');
    }
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
    const plan = getPlan();
    if (win) win.classList.toggle('so-plan-on', !!plan);
    if (!plan) {
        const pre0 = planBarEl.querySelector('#so-plan-directive');
        pre0.classList.remove('open');
        planBarEl.querySelector('#so-plan-show').textContent = '▸ 查看注入内容';
        placePlanBar();
        return;
    }
    planBarEl.querySelector('#so-plan-goal').textContent = plan.title ? `${plan.title}：${plan.goal}` : plan.goal;
    // Intensity segmented control — rebuilt each render; label IS the compressed
    // directive, the caption underneath is its one-line expansion.
    const seg = planBarEl.querySelector('#so-plan-intensity');
    seg.innerHTML = '';
    for (const [key, I] of Object.entries(ADVISOR_INTENSITIES)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'so-plan-int' + (plan.intensity === key ? ' active' : '');
        b.textContent = I.label;
        b.addEventListener('click', () => setPlanIntensity(key));
        seg.appendChild(b);
    }
    const I = ADVISOR_INTENSITIES[plan.intensity] || ADVISOR_INTENSITIES.normal;
    planBarEl.querySelector('#so-plan-caption').textContent = I.caption;
    const pre = planBarEl.querySelector('#so-plan-directive');
    if (pre.classList.contains('open')) pre.textContent = buildDirective(plan);
    placePlanBar();
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
    makeDraggable(planFloat, planFloat.querySelector('#so-plan-float-head'),
        { left: 'planFloatLeft', top: 'planFloatTop' });
    // Restore the saved position, clamped to the current viewport.
    const s = getSettings();
    if (Number.isFinite(s.planFloatLeft) && Number.isFinite(s.planFloatTop)) {
        planFloat.style.left = Math.max(0, Math.min(window.innerWidth - 60, s.planFloatLeft)) + 'px';
        planFloat.style.top = Math.max(0, Math.min(window.innerHeight - 40, s.planFloatTop)) + 'px';
        planFloat.style.right = 'auto';
    }
    applyPlanFloatCollapsed(); // restore persisted collapsed state
}

// Collapsed = head-only pill 「🧭 引导中」: tiny footprint (mobile!), still an
// unmissable signal that steering is active. Strip stays parented in the hidden
// slot, so expanding is pure CSS — no re-render, no listener churn.
function applyPlanFloatCollapsed() {
    if (!planFloat) return;
    const collapsed = !!getSettings().planFloatCollapsed;
    planFloat.classList.toggle('so-collapsed', collapsed);
    const icon = planFloat.querySelector('#so-plan-float-collapse i');
    icon.className = collapsed ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
    planFloat.querySelector('.so-plan-float-title').textContent = collapsed ? '引导中' : '剧情引导';
    // Collapsed pill: hovering (desktop) shows the goal it stands for.
    const plan = getPlan();
    planFloat.querySelector('#so-plan-float-head').title =
        collapsed && plan ? (plan.title ? `${plan.title}：${plan.goal}` : plan.goal) : '';
}

// Decide where the strip lives right now. Rules: no plan -> hidden (and parked
// back in the window); plan + window visible -> inside the window (the float
// hides); plan + window closed -> inside the float, always on screen.
function placePlanBar() {
    if (!planBarEl || !win) return;
    const plan = getPlan();
    const winVisible = win.style.display !== 'none';
    if (plan && !winVisible) {
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

// Fill the book dropdown: "all active" + every known book (active ones marked).
async function populateLorebookBooks(announce) {
    const sel = win.querySelector('#so-lb-book');
    if (!sel) return;
    const s = getSettings();
    let active = [];
    let all = [];
    try {
        [active, all] = await Promise.all([getActiveBookNames(), getAllBookNames()]);
    } catch (e) { /* leave empty */ }

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

    // Restore selection if it still exists; otherwise fall back to "all active".
    if (s.lorebookTarget && all.includes(s.lorebookTarget)) {
        sel.value = s.lorebookTarget;
    } else {
        if (s.lorebookTarget) { s.lorebookTarget = ''; save(); }
        sel.value = '';
    }
    updateLbHint();
    populateLorebookEntries();
    if (announce) addSystemNote('已刷新世界书列表。');
}

function updateLbHint() {
    const hint = win.querySelector('#so-lb-hint');
    if (!hint) return;
    const s = getSettings();
    hint.textContent = s.lorebookTarget
        ? `将聊 / 编辑：「${s.lorebookTarget}」这一本。`
        : '将聊 / 编辑：当前角色卡 / 聊天 / 全局所激活的全部世界书。整本注入，token 消耗可能较大。';
}

/* ---- per-entry picker (only shown when a single book is targeted) ---- */
function allLbEntryUids() {
    const list = win.querySelector('#so-lb-entries-list');
    return list ? [...list.querySelectorAll('input[type="checkbox"]')].map((b) => Number(b.dataset.uid)) : [];
}

// "all" is represented as null (no filter). Normalize a full set back to null so
// buildLorebookContext takes its untouched "整本" path.
function refreshLbEntriesSummary(name, total) {
    let sel = lbEntryFilter[name];
    if (sel instanceof Set && total > 0 && sel.size >= total) { sel = null; lbEntryFilter[name] = null; }
    const summary = win.querySelector('#so-lb-entries-summary');
    if (!summary) return;
    summary.textContent = (sel instanceof Set) ? `条目：已选 ${sel.size} / ${total}` : `条目：全部（${total}）`;
}

function toggleLbEntry(name, uid, checked, total) {
    let sel = lbEntryFilter[name];
    if (!(sel instanceof Set)) sel = new Set(allLbEntryUids()); // was "all" -> materialize
    if (checked) sel.add(uid); else sel.delete(uid);
    lbEntryFilter[name] = sel;
    refreshLbEntriesSummary(name, total);
}

function setAllLbEntries(on) {
    const name = getSettings().lorebookTarget;
    if (!name) return;
    const boxes = [...win.querySelectorAll('#so-lb-entries-list input[type="checkbox"]')];
    boxes.forEach((b) => { b.checked = on; });
    lbEntryFilter[name] = on ? null : new Set();   // all  |  none
    refreshLbEntriesSummary(name, boxes.length);
}

// Select exactly the entries of one lamp type: 'blue' (常驻), 'green' (关键词触发),
// or 'off' (已禁用). None of these include disabled entries except 'off' itself.
function setLbEntriesByType(type) {
    const name = getSettings().lorebookTarget;
    if (!name) return;
    const rows = [...win.querySelectorAll('#so-lb-entries-list .so-lb-ent')];
    if (!rows.length) return;
    const sel = new Set();
    for (const row of rows) {
        const box = row.querySelector('input[type="checkbox"]');
        const match = row.dataset.type === type;
        box.checked = match;
        if (match) sel.add(Number(box.dataset.uid));
    }
    lbEntryFilter[name] = sel;   // empty Set if none of that type -> sends none
    refreshLbEntriesSummary(name, rows.length);
}

function filterLbEntries(q) {
    const needle = (q || '').trim().toLowerCase();
    const list = win.querySelector('#so-lb-entries-list');
    if (!list) return;
    for (const row of list.querySelectorAll('.so-lb-ent')) {
        row.style.display = (!needle || (row.dataset.hay || '').includes(needle)) ? '' : 'none';
    }
}

// Build / refresh the checklist for the currently targeted single book. Hidden
// entirely when target is "all active books" (selection is per single book).
async function populateLorebookEntries() {
    const box = win.querySelector('#so-lb-entries');
    const list = win.querySelector('#so-lb-entries-list');
    if (!box || !list) return;
    const name = getSettings().lorebookTarget;
    if (!name) { box.classList.remove('shown'); return; }
    box.classList.add('shown');

    list.innerHTML = '<div class="so-lb-ent-empty">读取条目中…</div>';
    let entries = [];
    try {
        const mod = await getWiEditApi();
        const data = mod ? await mod.loadWorldInfo(name) : null;
        if (data && data.entries) {
            entries = Object.values(data.entries)
                .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
        }
    } catch (e) { /* leave empty */ }

    // Drop stale uids from a prior selection (entries may have changed since).
    if (lbEntryFilter[name] instanceof Set) {
        const valid = new Set(entries.map((e) => e.uid));
        const kept = new Set([...lbEntryFilter[name]].filter((u) => valid.has(u)));
        lbEntryFilter[name] = kept;
    }

    list.innerHTML = '';
    if (!entries.length) {
        list.innerHTML = '<div class="so-lb-ent-empty">（此世界书暂无条目。）</div>';
        refreshLbEntriesSummary(name, 0);
        return;
    }
    const sel = lbEntryFilter[name];   // Set | null (= all)
    for (const e of entries) {
        const checked = !(sel instanceof Set) || sel.has(e.uid);
        const title = (e.comment && e.comment.trim()) ? e.comment.trim() : '（无标题）';
        const keys = Array.isArray(e.key) ? e.key.filter(Boolean).join(', ') : '';
        const row = document.createElement('label');
        row.className = 'so-lb-ent';
        row.dataset.hay = `${e.uid} ${title} ${keys}`.toLowerCase();
        row.dataset.type = e.disable ? 'off' : (e.constant ? 'blue' : 'green');
        row.innerHTML = `<input type="checkbox" data-uid="${e.uid}"${checked ? ' checked' : ''}>` +
            `<span class="so-lb-ent-type so-lb-type-${e.disable ? 'off' : (e.constant ? 'blue' : 'green')}"></span>` +
            `<span class="so-lb-ent-uid">#${e.uid}</span><span class="so-lb-ent-title"></span>`;
        row.querySelector('.so-lb-ent-title').textContent = title;
        row.querySelector('input').addEventListener('change', (ev) => toggleLbEntry(name, e.uid, ev.target.checked, entries.length));
        list.appendChild(row);
    }
    const f = win.querySelector('#so-lb-entries-filter');
    if (f && f.value) filterLbEntries(f.value);
    refreshLbEntriesSummary(name, entries.length);
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

    const parts = [resolveSystemPrompt(s)];

    const personaBlock = buildPersonaBlock(s.personaId);
    if (personaBlock) parts.push(personaBlock);

    if (s.includeCard) {
        parts.push(buildCardSection(ctx));
    }

    if (worldInfoBlock) {
        parts.push('=== 世界书 / 设定 ===\n' + worldInfoBlock);
    }

    const transcript = buildTranscript(ctx, s);
    if (transcript) {
        parts.push('=== 故事对话记录（最新的在最后）===\n' + transcript);
    }

    const full = parts.filter(Boolean).join('\n\n');
    try { return ctx.substituteParams(full); } catch (e) { return full; }
}

function buildDiagnosePrompt(ctx, s) {
    const parts = [DIAGNOSE_SYSTEM_PROMPT];

    // World info carries the card's MVU rules (blue/constant entries always fire).
    parts.push('=== 角色卡 MVU 规则（来自世界书）===\n' +
        (worldInfoBlock || '（未找到世界书规则 —— 诊断结果可能不完整）'));

    parts.push('=== 当前变量状态（stat_data）===\n' +
        (diagStatData || '（不可用 —— 未检测到 MVU 框架）'));

    parts.push('=== 最新更新区块（待检查的更新）===\n' +
        (diagLatestUpdate || '（在最新一条 AI 回复中未找到 <UpdateVariable> 区块）'));

    if (s.includeCard) parts.push(buildCardSection(ctx));

    const transcript = buildTranscript(ctx, s);
    if (transcript) parts.push('=== 故事对话记录（最新的在最后）===\n' + transcript);

    const full = parts.filter(Boolean).join('\n\n');
    try { return ctx.substituteParams(full); } catch (e) { return full; }
}

function buildLorebookPrompt(ctx, s) {
    const parts = [LOREBOOK_SYSTEM_PROMPT];

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

// 参谋模式提示词：参谋指令 + 人格（若选）+ 当前引导方案（若有，供“检查进度”
// 用）+ 角色卡 + 世界书 + 【整段】对话记录。无论全局上下文深度设成多少，参谋
// 都看全史——只看最近十几条提出的方案会漏掉长线伏笔。
function buildAdvisorPrompt(ctx, s) {
    const parts = [ADVISOR_SYSTEM_PROMPT];

    // 说话人格（仅当用户主动选了某个人格时）：参谋指令之上叠语气皮肤，附带
    // 职责调整（构思未来剧情正是本职，不算「擅自续写」）+ 结构保护。
    const personaBlock = buildPersonaBlock(s.personaId, 'advisor');
    if (personaBlock) parts.push(personaBlock);

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

    if (s.includeCard) parts.push(buildCardSection(ctx));

    // 变量状态：剧情的硬事实层。有 MVU 时给出，方案必须与数值现状自洽
    //（好感度还没到的别提结婚，钱包空的别提一掷千金）；无 MVU 卡时整段省略，
    // 不显示“不可用”占位——这对参谋是可选情报，不是诊断那样的必需输入。
    if (advStatData) {
        parts.push('=== 当前变量状态（stat_data，来自 MVU —— 剧情推进到此刻的实时数值）===\n' + advStatData);
    }

    if (worldInfoBlock) {
        parts.push('=== 世界书 / 设定 ===\n' + worldInfoBlock);
    }

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

// Story-context turns as role-tagged objects {role:'user'|'assistant', name, text}.
// Mirrors ST's prompt builder: drop system messages, run each through the regex
// engine (isPrompt, depth relative to full chat), trim empties, take last N.
function buildTranscriptTurns(ctx, s) {
    if (s.contextDepth === 0) return [];
    const coreChat = (ctx.chat || []).filter((m) => m && !m.is_system && typeof m.mes === 'string');
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
            text: diagnoseMode ? text : stripMechanismBlocks(text),
        };
    });

    processed = processed.filter((l) => l.text && l.text.trim() !== '');
    if (s.contextDepth > 0) processed = processed.slice(-s.contextDepth);
    return processed;
}

function buildTranscript(ctx, s) {
    return buildTranscriptTurns(ctx, s).map((l) => `${l.name}: ${l.text}`).join('\n\n');
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
    if (!diagnoseMode && !lorebookMode && !advisorMode && presetCurationActive(s)) {
        return buildPresetMessages(s);
    }
    return [{ role: 'system', content: buildSystemPrompt() }, ...convo];
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
            // Story context first, then the Oracle's own Q&A — as real turns.
            for (const t of buildTranscriptTurns(ctx, s)) {
                pushMsg(out, t.role, t.text);
            }
            for (const m of convo) pushMsg(out, m.role, m.content);
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
        for (const t of buildTranscriptTurns(ctx, s)) pushMsg(out, t.role, t.text);
        for (const m of convo) pushMsg(out, m.role, m.content);
    }

    return out.length ? out : [{ role: 'system', content: subst(ctx, '（预设无可用内容）') }, ...convo];
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
        for (const m of convo) pushMsg(out, m.role, m.content);
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

    return out.length ? out : [{ role: 'system', content: loreBlock }, ...convo];
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
        for (const m of convo) pushMsg(out, m.role, m.content);
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

    return out.length ? out : [{ role: 'system', content: advBlock }, ...convo];
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
    const entry = { id: ++cidSeq, role: 'user', content: text };
    convo.push(entry);
    entry._el = addMessage('user', text, entry);
    await generateReply();
}

// Generate one assistant reply for the current tail of `convo` (which must already
// end with the user turn being answered). Shared by send / edit / regenerate.
async function generateReply() {
    if (isGenerating) return;
    const s = getSettings();
    if (s.applyRegex) await loadRegexEngine(); // ensure engine is ready before building context

    if (diagnoseMode) {
        // Force a WI scan so the card's blue rule entries are always present
        // (keep 'all' if the user chose it). Also pull live state + the raw
        // latest <UpdateVariable> block (un-stripped from the stored message).
        worldInfoBlock = await buildWorldInfo(s.worldInfoMode === 'all' ? 'all' : 'st');
        // MVU may strip [mvu_update] rule entries from the scan (extra-model-
        // parsing mode). Recover them from the raw books so Diagnose has the
        // authoritative path/type/check rules it's told to rely on.
        const mvuRules = await collectMvuUpdateRules(worldInfoBlock);
        if (mvuRules.length) {
            worldInfoBlock = [worldInfoBlock, ...mvuRules].filter(Boolean).join('\n\n');
        }
        const stat = await getMvuStatData();
        diagStatData = stat ? JSON.stringify(stat, null, 2) : '';
        diagLatestUpdate = extractUpdateBlock(getLatestAiMessageText());
    } else if (lorebookMode) {
        // Read the selected world book(s) fresh so the model sees the current
        // state, and remember which books are in scope for the apply step.
        await buildLorebookContext();
    } else if (advisorMode) {
        // Advisor sees world info per the user's setting (off by default), and
        // builds its own full-history transcript inside buildAdvisorPrompt.
        worldInfoBlock = await buildWorldInfo();
        // Live MVU variable state (好感度 / 时间 / 资源…) — hard story facts the
        // proposed beats must not contradict. Silently absent for non-MVU cards.
        const stat = await getMvuStatData();
        advStatData = stat ? JSON.stringify(stat, null, 2) : '';
    } else if (presetCurationActive(s)) {
        // Faithful assembly needs WI split into the Before/After-Char-Defs slots.
        const split = await buildWorldInfoSplit();
        wiBefore = split.before;
        wiAfter = split.after;
        worldInfoBlock = ''; // legacy single-block path unused while preset is active
    } else {
        worldInfoBlock = await buildWorldInfo(); // empty string when mode is 'off'
    }

    const messages = buildMessages();
    // Snapshot the exact prompt for the debug viewer (both modes).
    lastPrompt = messages.map((m) => ({ role: m.role, content: m.content }));
    lastPromptMeta = {
        mode: diagnoseMode ? '诊断' : (lorebookMode ? '世界书' : (advisorMode ? '参谋' : '聊天')),
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
        const effMaxTokens = diagnoseMode ? Math.max(s.maxTokens, 4096) : s.maxTokens;
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
                    scrollToBottom();
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
                    scrollToBottom();
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
        } else {
            // Strip main-chat mechanism blocks (<UpdateVariable>) the preset's
            // output contract may have coaxed out of the model — display AND
            // history, chat/advisor modes only (see stripMechanismBlocks).
            const mechStrip = !diagnoseMode && !lorebookMode;
            let cleanText = finalText;
            if (mechStrip) {
                cleanText = stripMechanismBlocks(finalText);
                if (!cleanText) {
                    // The whole reply was mechanism block(s) — show why instead
                    // of a blank bubble, and keep history non-empty (some APIs
                    // reject empty message content on the next turn).
                    cleanText = '（这条回复只包含主聊天的机制区块（如 <UpdateVariable>），已自动隐藏。）';
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
            const useOutputRegex = !diagnoseMode && !lorebookMode && !advisorMode && presetCurationActive(s) && s.applyRegex;
            let historyText = cleanText;
            if (useOutputRegex) {
                historyText = applyOutputRegex(cleanText, /*forPrompt*/ true);
                const html = renderReplyHtml(cleanText);
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
            if (diagnoseMode) {
                const block = extractUpdateBlock(finalText);
                if (block) addApplyControls(assistantEl, block);
            } else if (lorebookMode) {
                const parsed = parseLorebookBlocks(finalText);
                if (parsed.ops.length || parsed.errors.length) addLorebookApplyControls(assistantEl, parsed);
            } else if (advisorMode) {
                const plans = parseStoryPlans(cleanText);
                if (plans.length) addPlanControls(assistantEl, plans);
            }
        }
    } catch (err) {
        clearTyping();
        const aborted = err?.name === 'AbortError';
        contentEl.textContent = aborted ? '(已停止)' : `错误：${err?.message || err}`;
        if (!aborted) contentEl.classList.add('so-error');
        console.error('[Story Oracle]', err);
    } finally {
        setGenerating(false);
        abortCtl = null;
        scrollToBottom();
    }
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
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // keep the (possibly partial) last line
        for (let line of lines) {
            line = line.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') return full;
            try {
                const json = JSON.parse(payload);
                const delta = json?.choices?.[0]?.delta?.content || '';
                if (delta) { full += delta; onDelta(delta); }
            } catch (e) { /* keepalive / non-JSON line */ }
        }
    }
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
    scrollToBottom();
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

function renderEmptyState() {
    if (convo.length || messagesEl.children.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'so-empty';
    wrap.innerHTML =
        `<i class="fa-solid fa-moon so-empty-icon"></i>` +
        `<div>关于当前剧情，尽管问吧。</div>` +
        `<div class="so-empty-sub">此窗口与主聊天相互独立。</div>`;
    messagesEl.appendChild(wrap);
}

function clearConversation() {
    convo = [];
    messagesEl.innerHTML = '';
    renderEmptyState();
}

function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
        win.style.left = `${Math.max(margin, Math.round((window.innerWidth - w) / 2))}px`;
        win.style.top = '56px';
        win.style.right = 'auto';
    } // else: desktop keeps the CSS default (top:70px right:20px)
}

// Drag the window by its header. Pointer events cover mouse + touch + pen in one
// path; pointer capture keeps tracking even when the finger leaves the header.
function makeDraggable(panel, handle, keys = { left: 'winLeft', top: 'winTop' }) {
    let sx, sy, sl, st, pid = null;
    handle.style.touchAction = 'none';   // stop the page scrolling under a drag
    handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button') || e.target.closest('.so-iconbtn')) return; // let buttons tap
        if (e.button != null && e.button > 0) return;       // primary / touch only
        pid = e.pointerId;
        const r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        panel.style.right = 'auto';
        document.body.style.userSelect = 'none';
        try { handle.setPointerCapture(pid); } catch (_) { /* ignore */ }
    });
    handle.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pid) return;
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
