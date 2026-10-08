/**
 * Resolve per-request reasoning controls without guessing actual token consumption.
 * A third-party proxy may reject parameters a specific model does not support;
 * that error is surfaced to the user rather than silently dropping the setting.
 */
export const OPENAI_EFFORTS = Object.freeze(['none','minimal','low','medium','high','xhigh','max']);
export const CLAUDE_EFFORTS = Object.freeze(['low','medium','high','xhigh','max']);
export const GEMINI_EFFORTS = Object.freeze(['minimal','low','medium','high']);

function geminiThinking(modelId,requested,mode){
  const model=String(modelId||'').replace(/^models\//,'').toLowerCase();
  const legacy=/^gemini-2\.5(?:[-.]|$)/.test(model);
  const levelModel=/^gemini-([3-9]|[1-9]\d)(?:[-.]|$)/.test(model);
  let effort=null,budget_tokens=null;
  if(mode==='budget'){
    if(levelModel)throw Error('Gemini 3 及更新模型請使用思考等級，而非自訂 Token 預算');
    budget_tokens=requested.budget_tokens;
  }else if(mode==='effort'){
    effort=requested.effort;
    if(!GEMINI_EFFORTS.includes(effort)&&!(legacy&&effort==='none'))throw Error('Gemini 不支援所選的思考等級');
    if(!legacy)return {mode,effort,budget_tokens:null,params:{generationConfig:{thinkingConfig:{includeThoughts:true,thinkingLevel:effort}}}};
    budget_tokens={none:0,minimal:512,low:1024,medium:4096,high:8192}[effort];
  }else throw Error('無效的思考額度模式');
  const max=legacy&&model.includes('flash')?24576:32768;
  const min=legacy&&model.includes('pro')?128:legacy&&model.includes('lite')?512:0;
  if(!Number.isSafeInteger(budget_tokens)||budget_tokens<0||budget_tokens>max||
    (budget_tokens===0&&legacy&&model.includes('pro'))||(budget_tokens>0&&budget_tokens<min))
    throw Error(`Gemini 思考預算必須為模型支援的整數 Token（上限 ${max}，Pro 不可關閉思考）`);
  return {mode,effort,budget_tokens,params:{generationConfig:{thinkingConfig:{includeThoughts:true,thinkingBudget:budget_tokens}}}};
}

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
  if (!['openai','claude','gemini'].includes(protocol)) throw new Error('不支援的 API 協定');
  if (protocol === 'gemini') return geminiThinking(modelId,requested,mode);
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
