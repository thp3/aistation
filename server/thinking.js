/**
 * Resolve per-request reasoning controls without guessing actual token consumption.
 * A third-party proxy may reject parameters a specific model does not support;
 * that error is surfaced to the user rather than silently dropping the setting.
 */
export const OPENAI_EFFORTS = Object.freeze(['none','minimal','low','medium','high','xhigh','max']);
export const CLAUDE_EFFORTS = Object.freeze(['low','medium','high','xhigh','max']);

export function isLegacyClaudeModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  return /^claude-3(?:[-.]|$)/.test(id)
    || /^claude-(?:opus|sonnet|haiku)-4[-.][0-5](?:[-.]|$)/.test(id);
}

const LEGACY_BUDGETS = Object.freeze({
  low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768
});

/** Validate an untrusted browser payload before storing a user message. */
export function resolveThinking(protocol, modelId, requested) {
  if (requested == null) return {mode:'default',effort:null,budget_tokens:null,params:{}};
  if (!requested || typeof requested !== 'object' || Array.isArray(requested))
    throw new Error('思考額度格式不正確');
  const mode = requested.mode ?? 'default';
  if (mode === 'default') return {mode:'default',effort:null,budget_tokens:null,params:{}};
  if (!['openai','claude'].includes(protocol)) throw new Error('不支援的 API 協定');
  if (mode === 'budget') {
    if (protocol !== 'claude') throw new Error('OpenAI 相容 API 不支援以 Token 數指定思考預算');
    const tokens = requested.budget_tokens;
    if (!Number.isSafeInteger(tokens) || tokens < 1024 || tokens > 32768)
      throw new Error('Claude 自訂思考額度必須為 1,024 至 32,768 的整數 Token');
    return {
      mode:'budget',effort:null,budget_tokens:tokens,
      params:{thinking:{type:'enabled',display:'summarized',budget_tokens:tokens},max_tokens:Math.max(4096,tokens+2048)}
    };
  }
  if (mode !== 'effort') throw new Error('無效的思考額度模式');
  const effort=requested.effort;
  const allowed=protocol==='openai'?OPENAI_EFFORTS:CLAUDE_EFFORTS;
  if (!allowed.includes(effort)) throw new Error('此 API 協定不支援所選的思考等級');

  if (protocol === 'openai')
    return {mode:'effort',effort,budget_tokens:null,params:{reasoning_effort:effort}};

  // Claude 4.5 and earlier use manual budget_tokens; 4.6+ use adaptive thinking.
  if (isLegacyClaudeModel(modelId)) {
    const budget_tokens=LEGACY_BUDGETS[effort];
    return {mode:'effort',effort,budget_tokens,params:{
      thinking:{type:'enabled',display:'summarized',budget_tokens},
      max_tokens:Math.max(4096,budget_tokens+2048)
    }};
  }
  return {mode:'effort',effort,budget_tokens:null,params:{
    thinking:{type:'adaptive',display:'summarized'},output_config:{effort},
    max_tokens:16384
  }};
}
