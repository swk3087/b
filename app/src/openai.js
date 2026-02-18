import { keys, hasOpenAIConfig } from './config.js';
import { generatePlan } from './planner.js';

function extractJson(text) {
  const clean = text.trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('AI 응답 JSON 파싱 실패');
  return JSON.parse(clean.slice(start, end + 1));
}

function extractResponseText(data) {
  const direct = String(data?.output_text || '').trim();
  if (direct) return direct;

  const out = data?.output;
  if (!Array.isArray(out)) return '';

  const chunks = [];
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const type = String(part?.type || '');
      if (type === 'output_text' || type === 'text') {
        const text = String(part?.text || '').trim();
        if (text) chunks.push(text);
      }
    }
  }
  return chunks.join('\n').trim();
}

function buildPrompt(input, profile) {
  return [
    '너는 일정 분배 코치다. 반드시 JSON만 반환한다.',
    '규칙:',
    '- 오프데이 제외',
    '- 사용 가능 시간의 80%만 사용(버퍼)',
    '- 날짜별 분/페이지 단위 배분',
    '- 응답 스키마: {"planName":"","subject":"","taskType":"","dueDate":"YYYY-MM-DD","schedule":[{"date":"YYYY-MM-DD","minutes":120,"pages":10,"pageFrom":1,"pageTo":10,"status":"pending"}],"notes":""}',
    `사용자 설정: ${JSON.stringify(profile.settings)}`,
    `요청: ${JSON.stringify(input)}`
  ].join('\n');
}

function shortText(value, max = 220) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function parseErrorPayload(res) {
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    const err = json?.error || {};
    return {
      httpStatus: res.status,
      errorType: err.type || 'openai_error',
      errorCode: err.code || null,
      errorMessage: shortText(err.message || text || `HTTP ${res.status}`)
    };
  } catch {
    return {
      httpStatus: res.status,
      errorType: 'http_error',
      errorCode: null,
      errorMessage: shortText(text || `HTTP ${res.status}`)
    };
  }
}

function fallbackPlan(input, profile, detail) {
  return {
    plan: generatePlan(input, profile),
    source: 'fallback',
    detail
  };
}

export async function generatePlanWithAI(input, profile) {
  if (!hasOpenAIConfig()) {
    return fallbackPlan(input, profile, {
      reason: 'missing_api_key',
      httpStatus: null,
      errorType: 'config',
      errorCode: null,
      errorMessage: 'openai.apiKey가 설정되지 않았습니다.'
    });
  }

  const apiKey = keys.openai.apiKey;
  const model = keys.openai.model || 'gpt-4o-mini';

  const body = {
    model,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: buildPrompt(input, profile) }]
      }
    ]
  };

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await parseErrorPayload(res);
      return fallbackPlan(input, profile, { reason: 'http_error', ...detail });
    }

    const data = await res.json();
    const text = extractResponseText(data);
    if (!text) {
      return fallbackPlan(input, profile, {
        reason: 'empty_output_text',
        httpStatus: 200,
        errorType: 'response_format',
        errorCode: null,
        errorMessage: 'output_text가 비어 있습니다.'
      });
    }

    const plan = extractJson(text);
    if (!Array.isArray(plan.schedule)) throw new Error('invalid');
    return {
      plan,
      source: 'openai',
      detail: {
        reason: 'ok',
        httpStatus: 200,
        errorType: null,
        errorCode: null,
        errorMessage: null
      }
    };
  } catch (error) {
    return fallbackPlan(input, profile, {
      reason: 'parse_or_network_error',
      httpStatus: null,
      errorType: 'exception',
      errorCode: null,
      errorMessage: shortText(error?.message || 'unknown error')
    });
  }
}

export async function generateCheerMessageWithAI(context = {}) {
  const fallback = '작게 해도, 오늘 해낸 것이 이긴 것입니다.';
  if (!hasOpenAIConfig()) {
    return {
      message: fallback,
      source: 'fallback',
      detail: {
        reason: 'missing_api_key',
        httpStatus: null,
        errorType: 'config',
        errorCode: null,
        errorMessage: 'openai.apiKey가 설정되지 않았습니다.'
      }
    };
  }

  const apiKey = keys.openai.apiKey;
  const model = keys.openai.model || 'gpt-4o-mini';
  const body = {
    model,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '당신은 학습 코치입니다.',
              '한국어로 짧은 응원 문구 1개만 작성하세요.',
              '조건: 25자 이내, 과장/이모지 금지, 실천 중심 톤.',
              `컨텍스트: ${JSON.stringify(context)}`
            ].join('\n')
          }
        ]
      }
    ]
  };

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await parseErrorPayload(res);
      return { message: fallback, source: 'fallback', detail: { reason: 'http_error', ...detail } };
    }

    const data = await res.json();
    const text = extractResponseText(data);
    if (!text) {
      return {
        message: fallback,
        source: 'fallback',
        detail: {
          reason: 'empty_output_text',
          httpStatus: 200,
          errorType: 'response_format',
          errorCode: null,
          errorMessage: 'output_text가 비어 있습니다.'
        }
      };
    }

    const oneLine = text.split('\n')[0].trim();
    return {
      message: oneLine || fallback,
      source: 'openai',
      detail: { reason: 'ok', httpStatus: 200, errorType: null, errorCode: null, errorMessage: null }
    };
  } catch (error) {
    return {
      message: fallback,
      source: 'fallback',
      detail: {
        reason: 'network_or_exception',
        httpStatus: null,
        errorType: 'exception',
        errorCode: null,
        errorMessage: shortText(error?.message || 'unknown error')
      }
    };
  }
}
