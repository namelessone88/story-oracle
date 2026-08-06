/**
 * LangBridge — translation prompt (PURE: string building only).
 *
 * The model has ONE job: for each entry, translate its existing Chinese trigger
 * words into the English a user would actually type. No classification, no
 * display decisions — those features were cut (v0.5.0); the worldbook's own
 * keys are the complete requirement.
 */

/**
 * Pinned renderings for the closed jargon sets. These become the user's
 * PERMANENT typing vocabulary, so they are fixed rather than re-invented per
 * batch — a model asked twice will happily produce "Foundation Building" the
 * second time, and then that phrasing never fires. Edit here once if you want
 * different wording; re-running the pass will append the new renderings.
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
    丹药: ['elixir'],
};

export const SYSTEM_PROMPT = `你是一个世界书触发词翻译器。用户用英文打字，但世界书的触发词全是中文——所以他打英文时，条目永远不会触发。

你的任务：把每个条目【现有的中文触发词】逐个翻成【用户实际会打出来的英文】。这些英文会被追加为额外触发词（原有中文词一个不删、一个不改）。

规则：
- 【逐词对应，不要发明】：触发词是「传送阵、传送费用、灵石价格」，就翻这三个词，不要自己想别的说法
- 一个中文词可以给 1~3 个英文说法（用户可能有几种打法）："传送阵" → "teleport array" / "teleportation"
- 【人名】给标准拼音（姓前名后、每段首字母大写），并另给一个不含姓的形式："沈慕微" → "Shen Muwei" 和 "Muwei"。称号也要翻："无情道首座" → "Merciless Path First Seat"
- 【多词短语优先】。单个英文词只在它足够具体、不会撞上日常英文时才给（"tribulation"、"cultivator" 可以；"price"、"fight" 不行）
- 【绝对不要】给这类通用词：level、status、value、name、time、type、data、text、color、hp、exp、info、panel、system、user、item、state——它们出现在状态栏和变量块里，一给就每回合乱触发
- 触发词已经是英文的，跳过；实在没法翻好的，跳过——宁缺毋滥
- 正文摘录只是帮你理解词义的背景，不要从里面提取新触发词

输出：只输出一个 JSON 数组，别的什么都不要。每个给你的条目都必须出现一次，uid 原样照抄；没有可翻的就给空数组：
[
  {"uid": 8, "key_en": ["Shen Muwei", "Muwei", "Merciless Path First Seat"]},
  {"uid": 32, "key_en": ["teleport array", "teleportation", "teleport fee", "spirit stone price"]},
  {"uid": 70, "key_en": []}
]`;

/** User message for one batch of entries. */
export function buildBatchPrompt(entries) {
    const blocks = (entries || []).map((entry) => {
        const keys = (entry.keys || []).slice(0, 16).join('、');
        const excerpt = String(entry.content || '').replace(/\s+/g, ' ').slice(0, 150);
        return [
            `uid: ${entry.uid}`,
            `标题: ${entry.comment || '(无标题)'}`,
            `触发词: ${keys || '(无)'}`,
            excerpt ? `正文摘录（仅供理解词义）: ${excerpt}` : '',
        ].filter(Boolean).join('\n');
    });

    const jargon = Object.entries(FIXED_JARGON)
        .map(([zh, en]) => `${zh} → ${en.join(' / ')}`)
        .join('；');

    return `【固定译法·必须照用】遇到这些词时用给定的英文，不要另行发挥：\n${jargon}\n\n` +
        `【本批条目 ${blocks.length} 条】\n\n${blocks.join('\n\n---\n\n')}`;
}

/** Messages array for one translation call. */
export function buildBatchMessages(entries) {
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildBatchPrompt(entries) },
    ];
}
