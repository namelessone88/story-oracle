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

/* ------------------------------------------------------------------ *
 * 说话人格（voice personas）。
 *
 * 这些只是叠加在系统提示词之上的"语气皮肤"，不替换它、也不改变神谕的职责。
 * PERSONA_FRAME 一次性声明守则（默认仍是戏外分析者、谈剧情时须准确有据、不杜
 * 撰、不代入剧情角色；但用户只想和人格闲聊时不必拉回剧情；并放开"简明直接"以允
 * 许文采），每个 persona.voice
 * 只需描述说话风格本身。仅在普通模式生效——诊断模式始终保持冷静精确，不套人格。
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

function buildPersonaBlock(personaId) {
    const p = PERSONAS.find((x) => x.id === personaId);
    if (!p || !p.voice) return '';
    let block = PERSONA_FRAME + '\n' + p.voice;
    if (p.example) {
        block += '\n\n下面是这种腔调的对话示例（仅供学习语气与行文结构，不要照搬其中的具体内容）：\n' + p.example;
    }
    return block;
}

// Chat Completion preset as system-prompt source.
// When a preset is selected, the user curates which of its blocks to keep
// (manual checklist + drag-reorder), and Story Oracle assembles a faithful,
// role-preserving, marker-aware prompt from that frozen curated copy.
const ENABLE_SYSPROMPT_PRESET = true;

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
    maxTokens: 800,
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
    // window geometry
    winLeft: null,
    winTop: null,
    winWidth: 380,
    winHeight: 540,
};

// In-memory side-chat history (cleared on page reload or via the Clear button).
let convo = [];
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
 * MVU (MagVarUpdate via JS-Slash-Runner) integration for Diagnose mode
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
    win.style.width = `${s.winWidth}px`;
    win.style.height = `${s.winHeight}px`;
    if (s.winLeft != null && s.winTop != null) {
        win.style.left = `${s.winLeft}px`;
        win.style.top = `${s.winTop}px`;
        win.style.right = 'auto';
    }

    win.innerHTML = `
        <div id="so-header">
            <div id="so-title"><i class="fa-solid fa-moon"></i> 故事神谕 <span id="so-mode-badge"></span><span id="so-diag-pill">诊断</span></div>
            <div id="so-header-btns">
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
            <div class="so-hint">给神谕套一层“说话腔调”，只改变语气与文采，不改变其分析职责。选「普通」即关闭人格（默认）。使用预设时，人格默认关闭、以免与预设自带的角色声线冲突；若选择某个人格，它会叠加在预设之上。诊断模式下不生效。</div>

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
    `;
    document.body.appendChild(win);

    messagesEl = win.querySelector('#so-messages');
    inputEl = win.querySelector('#so-input');
    sendBtn = win.querySelector('#so-send');
    modeBadge = win.querySelector('#so-mode-badge');

    bindControls();
    loadSettingsIntoForm();
    makeDraggable(win, win.querySelector('#so-header'));
    observeResize();
    renderEmptyState();
}

function bindControls() {
    const s = getSettings();

    win.querySelector('#so-close-btn').addEventListener('click', () => toggleWindow(false));
    win.querySelector('#so-clear-btn').addEventListener('click', clearConversation);
    win.querySelector('#so-diagnose-btn').addEventListener('click', toggleDiagnose);
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
    win.querySelector('#so-card').checked = !!s.includeCard;
    win.querySelector('#so-regex').checked = !!s.applyRegex;
    win.querySelector('#so-wi').value = s.worldInfoMode;
    win.querySelector('#so-sendtemp').checked = !!s.sendTemperature;
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
    }
}

function toggleDiagnose() {
    diagnoseMode = !diagnoseMode;
    win.classList.toggle('so-diag-on', diagnoseMode);
    win.querySelector('#so-diagnose-btn').classList.toggle('so-diag-active', diagnoseMode);
    inputEl.placeholder = diagnoseMode
        ? '描述哪里看起来不对，或让我检查最新一次更新 / 审计当前状态…'
        : '就当前剧情提问…（Enter 发送，Shift+Enter 换行）';
    if (diagnoseMode) {
        addSystemNote('诊断模式已开启。我会把最新一条 AI 回复中的变量更新，对照本角色卡的 MVU 规则与当前状态进行检查，然后给出一份你可以一键应用的纠正补丁。可以让我检查它、指出哪里看起来不对，或者直接说“审计整个状态”。');
    } else {
        addSystemNote('已返回普通聊天模式。');
    }
    inputEl.focus();
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
            text,
        };
    });

    processed = processed.filter((l) => l.text && l.text.trim() !== '');
    if (s.contextDepth > 0) processed = processed.slice(-s.contextDepth);
    return processed;
}

function buildTranscript(ctx, s) {
    return buildTranscriptTurns(ctx, s).map((l) => `${l.name}: ${l.text}`).join('\n\n');
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
    if (!diagnoseMode && presetCurationActive(s)) {
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
    convo.push({ role: 'user', content: text });
    addMessage('user', text);

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
        mode: diagnoseMode ? '诊断' : '聊天',
        target: s.mode === 'direct' ? (s.model || '直连') : '配置文件',
        chars: lastPrompt.reduce((n, m) => n + (m.content ? m.content.length : 0), 0),
        time: new Date().toLocaleTimeString(),
    };
    const assistantEl = addMessage('assistant', '');
    const contentEl = assistantEl.querySelector('.so-content');
    const clearTyping = showTyping(contentEl);
    setGenerating(true);
    abortCtl = new AbortController();

    try {
        let finalText = '';
        if (s.mode === 'direct') {
            const url = normalizeUrl(s.endpoint);
            const body = {
                model: s.model,
                messages,
                max_tokens: s.maxTokens,
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
                finalText = await callProfileStream(s.profileId, messages, s.maxTokens, override, abortCtl.signal, (full) => {
                    clearTyping();
                    contentEl.textContent = full;
                    scrollToBottom();
                });
                contentEl.classList.remove('so-streaming');
            } else {
                finalText = await callProfile(s.profileId, messages, s.maxTokens, override, abortCtl.signal);
                clearTyping();
                contentEl.textContent = finalText;
            }
        }

        clearTyping();
        if (!finalText) {
            contentEl.textContent = '(空回复)';
            contentEl.classList.add('so-error');
        } else {
            // When a curated preset drives the output AND regex is on, mirror main
            // chat: RENDER the reply through ST's own formatter (so display-stage
            // regex, markdown, and HTML/CSS widgets actually render instead of
            // showing as raw text), and STORE the prompt-stage regex'd copy in
            // history (clean text for re-feeding — no widget markup looping back).
            // Never for the plain textarea prompt, never in Diagnose mode (which
            // needs the raw <UpdateVariable> block intact).
            const useOutputRegex = !diagnoseMode && presetCurationActive(s) && s.applyRegex;
            let historyText = finalText;
            if (useOutputRegex) {
                historyText = applyOutputRegex(finalText, /*forPrompt*/ true);
                const html = renderReplyHtml(finalText);
                if (html != null) {
                    contentEl.innerHTML = html;
                    contentEl.classList.add('so-rendered');
                    contentEl.style.whiteSpace = 'normal';
                } else {
                    contentEl.textContent = finalText;
                }
            }
            convo.push({ role: 'assistant', content: historyText });
            if (diagnoseMode) {
                const block = extractUpdateBlock(finalText);
                if (block) addApplyControls(assistantEl, block);
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

function addMessage(role, content) {
    const wrap = document.createElement('div');
    wrap.className = `so-msg so-${role}`;
    const icon = role === 'user' ? 'fa-user' : 'fa-moon';
    const label = role === 'user' ? '你' : '神谕';
    const copyBtn = role === 'assistant'
        ? `<button class="so-copy-btn" type="button" title="复制" aria-label="复制此回复"><i class="fa-solid fa-copy"></i></button>`
        : '';
    wrap.innerHTML =
        `<div class="so-avatar"><i class="fa-solid ${icon}"></i></div>` +
        `<div class="so-bubble"><div class="so-role"><span class="so-role-label">${label}</span>${copyBtn}</div><div class="so-content"></div></div>`;
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

    messagesEl.appendChild(wrap);
    scrollToBottom();
    return wrap;
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
function makeDraggable(panel, handle) {
    let sx, sy, sl, st, dragging = false;
    handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('.so-iconbtn')) return;
        dragging = true;
        const r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        panel.style.right = 'auto';
        document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const nl = Math.max(0, Math.min(window.innerWidth - 60, sl + e.clientX - sx));
        const nt = Math.max(0, Math.min(window.innerHeight - 40, st + e.clientY - sy));
        panel.style.left = `${nl}px`;
        panel.style.top = `${nt}px`;
    });
    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        const s = getSettings();
        s.winLeft = parseInt(panel.style.left, 10);
        s.winTop = parseInt(panel.style.top, 10);
        save();
    });
}

function observeResize() {
    let t;
    const ro = new ResizeObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
            const s = getSettings();
            s.winWidth = win.offsetWidth;
            s.winHeight = win.offsetHeight;
            save();
        }, 400);
    });
    ro.observe(win);
}
