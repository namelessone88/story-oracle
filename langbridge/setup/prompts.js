/**
 * LangBridge — Setup Pass prompts (PURE: string building only).
 *
 * ONE call shape does all the LLM work: classify an entry, romanize its name,
 * decide whether the Chinese or English form should be displayed, and (for
 * concepts) propose English trigger phrases. Doing it in one pass keeps the
 * setup cheap — this is the only place LangBridge ever calls a model.
 */

/**
 * Fixed renderings for the closed jargon sets. These become the user's PERMANENT
 * typing vocabulary, so they are pinned rather than re-invented per batch (a
 * model asked twice will happily produce "Foundation Building" the second time,
 * and then that phrasing never fires).
 *
 * Spec §11: confirm these with the user once and freeze. Editable here.
 */
export const FIXED_JARGON = {
    炼气: ['qi condensation'],
    筑基: ['foundation establishment'],
    金丹: ['golden core'],
    元婴: ['nascent soul'],
    化神: ['spirit severing', 'deity transformation'],
    合体: ['integration'],
    渡劫: ['tribulation'],
    灵石: ['spirit stones'],
    灵根: ['spirit root'],
    修士: ['cultivator'],
    法宝: ['magic treasure'],
    丹药: ['elixir', 'pill'],
};

export const SYSTEM_PROMPT = `你是一个中文角色扮演世界书的整理助手。你的任务是把世界书条目分类，并为其中的名字给出【拼音罗马化】和英文触发短语。

【重要背景】用户用英文打字，但故事本身是中文的。你产出的英文会被写进世界书当作【额外触发词】，和作者原有的中文触发词并存——原有中文词一个都不会被删。所以英文词要贴近【用户实际会打出来的说法】。

【分类】每个条目归入四类之一：
- character：具体的人物
- location：地点、区域、场所
- faction：宗门、势力、组织、家族
- concept：其余一切——规则、设定、机制、物品类别、修炼体系、货币、状态栏说明等

【display_en】只给 character / location / faction：
- 人名用标准拼音，姓在前，每段首字母大写，中间空格。例：沈慕微 → "Shen Muwei"；林雪鹿 → "Lin Xuelu"
- 地名 / 势力名若是【音译式】的专有名词，也用拼音。例：归墟 → "Guixu"
- 地名 / 势力名若是【有含义的普通词】，用意译。例：圣所 → "Sanctuary"；天剑宗 → "Heavenly Sword Sect"
- concept 类不要填 display_en，留空字符串

【displayPolicy】只给 character / location / faction，决定屏幕上显示中文还是英文：
- "en"：名字是【音译】的（沈慕微、归墟、阿德森帝国这类）——显示英文更好读
- "zh"：名字是【有含义的中文词】（天剑宗、圣所、大教堂这类）——这些中文本身就好懂，翻成英文反而丢味道
- 拿不准就填 "en"，【并且把 policy_uncertain 设为 true】——见下

【policy_uncertain】只给 character / location / faction。当这个名字【两种做法都说得通】时设为 true：
- 典型情况：它既是一个专有名词，字面又确实有含义。例：归墟——它是个地名（音译 "Guixu" 合理），但字面意思又是「万物归于虚无之处」（意译 "The Return to Void" 也合理）
- 这种名字不要替用户拍板：填上你倾向的 displayPolicy，同时把 policy_uncertain 设为 true，交给用户决定
- 明显的情况就设 false：沈慕微（纯人名音译）false；天剑宗（含义清楚）false
- 宁可多标几个 true，也不要悄悄替用户定下一个他不同意的显示方式

【aliases_en】该名字用户还可能怎么打（不含姓的名、常见简称）。不确定就给空数组。

【key_en】所有类别都要给。这是【把该条目"现有触发词"里的中文词，逐个翻成用户会打的英文】——不是另起炉灶想新词：
- 逐条对应：条目的现有触发词是「传送阵、传送费用、购买力、灵石价格、跨域传送、路费」，就给
  ["teleport array", "teleport fee", "purchasing power", "spirit stone price", "cross-region teleport", "travel cost"]
- 【优先多词短语】，单个词只在它足够具体、不会撞上普通英文时才给（"tribulation"、"cultivator" 可以）
- 【绝对不要】给这类通用词：level、status、value、name、time、type、data、text、color、hp、exp、info、panel、system、user、item、state——它们会出现在状态栏和变量块里，一给就会每回合乱触发
- 已经是英文的触发词、或翻出来会撞上通用词的，直接跳过不给
- 人名条目的称号类触发词（无情道首座、谷主）也要翻

【输出】只输出一个 JSON 数组，不要任何解释、不要代码块以外的文字：
[
  {"uid": 8, "category": "character", "display_en": "Shen Muwei", "displayPolicy": "en", "policy_uncertain": false, "aliases_en": ["Muwei"], "key_en": ["Merciless Path First Seat"]},
  {"uid": 41, "category": "location", "display_en": "Guixu", "displayPolicy": "en", "policy_uncertain": true, "aliases_en": [], "key_en": []},
  {"uid": 32, "category": "concept", "display_en": "", "displayPolicy": "en", "policy_uncertain": false, "aliases_en": [], "key_en": ["teleport array", "teleport fee", "spirit stone price"]}
]

每个给你的条目都必须在数组里出现一次，uid 必须原样照抄。`;

/** Build the user message for one batch of entries. */
export function buildBatchPrompt(entries) {
    const blocks = (entries || []).map((entry) => {
        const keys = (entry.keys || []).slice(0, 12).join('、');
        const excerpt = String(entry.content || '').replace(/\s+/g, ' ').slice(0, 300);
        return [
            `uid: ${entry.uid}`,
            `标题: ${entry.comment || '(无标题)'}`,
            keys ? `现有触发词: ${keys}` : '',
            excerpt ? `正文摘录: ${excerpt}` : '',
        ].filter(Boolean).join('\n');
    });

    const jargon = Object.entries(FIXED_JARGON)
        .map(([zh, en]) => `${zh} → ${en.join(' / ')}`)
        .join('；');

    return `【固定译法·必须照用】遇到这些词时，key_en 必须使用下面给定的英文，不要另行发挥：\n${jargon}\n\n` +
        `【本批条目 ${blocks.length} 条】\n\n${blocks.join('\n\n---\n\n')}`;
}

/** Messages array for one classification call. */
export function buildBatchMessages(entries) {
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildBatchPrompt(entries) },
    ];
}
