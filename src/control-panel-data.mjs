import fs from 'node:fs/promises';
import path from 'node:path';

const PUBLIC_JOB_FIELDS = [
  'id', 'date', 'start', 'end', 'openAt', 'prepareAt', 'latestStart',
  'bookingType', 'participants', 'courtOrder', 'paymentPolicy', 'submit',
];

function pick(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(fields.flatMap((field) => (
    Object.hasOwn(value, field) ? [[field, value[field]]] : []
  )));
}

export function safeErrorCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || /password|token|cookie|secret|credential|card|cvc|api.?key/i.test(normalized)) {
    return 'redacted_error';
  }
  return normalized.slice(0, 160);
}

export function publicJob(job) {
  const safe = pick(job, PUBLIC_JOB_FIELDS);
  if (!safe?.id || !safe.date || !safe.start || !safe.end) return null;
  return safe;
}

export function publicRun(run) {
  const safe = pick(run, [
    'status', 'mode', 'jobId', 'timestamp', 'startedAt', 'firstGridAt', 'finishedAt', 'attempts', 'selection', 'paymentStatus', 'adjacent',
  ]);
  if (!safe?.status || !safe.timestamp) return null;
  if (typeof run.errorCode === 'string') safe.errorCode = safeErrorCode(run.errorCode);
  if (safe.selection && typeof safe.selection === 'object') {
    safe.selection = pick(safe.selection, ['status', 'court', 'checked']);
  }
  if (run.adjacent && typeof run.adjacent === 'object') safe.adjacent = publicAdjacent(run.adjacent);
  return safe;
}

export function publicAdjacent(adjacent) {
  if (!adjacent || typeof adjacent !== 'object') return null;
  const safe = {
    window: pick(adjacent.window, ['start', 'end']),
    runs: Array.isArray(adjacent.runs)
      ? adjacent.runs.slice(0, 30).map((item) => pick(item, ['court', 'start', 'end'])).filter((item) => item?.court && item.start && item.end)
      : [],
  };
  if (typeof adjacent.error === 'string') safe.error = safeErrorCode(adjacent.error);
  return safe;
}

export function publicRecurringReport(report) {
  const safe = pick(report, ['status', 'targetDate', 'court', 'paymentStatus', 'remoteBookingId', 'error', 'verifiedAt', 'adjacent']);
  if (!safe?.status || !['success', 'failed'].includes(safe.status) || !/^\d{4}-\d{2}-\d{2}$/.test(safe.targetDate || '')) return null;
  if (safe.court !== undefined && !/^Court [1-6]$/.test(safe.court)) delete safe.court;
  if (safe.paymentStatus !== undefined && !['free', 'unpaid_hold', 'paid'].includes(safe.paymentStatus)) delete safe.paymentStatus;
  if (typeof safe.remoteBookingId === 'string') safe.remoteBookingId = safe.remoteBookingId.slice(0, 100);
  else delete safe.remoteBookingId;
  if (typeof safe.error === 'string') safe.error = safeErrorCode(safe.error);
  if (safe.adjacent) safe.adjacent = publicAdjacent(safe.adjacent);
  return safe;
}

export const publicWeekendReport = publicRecurringReport;

export function publicDispatch(marker) {
  const safe = pick(marker, ['status', 'jobId', 'timestamp', 'exitCode', 'reason']);
  if (!safe?.status || !safe.timestamp) return null;
  if (typeof safe.reason === 'string') safe.reason = safeErrorCode(safe.reason);
  return safe;
}

export function explainRunFailure(run, job = null) {
  if (run?.status !== 'failed') return null;
  const code = safeErrorCode(run.errorCode) || '';
  const windowText = job?.start && job?.end ? `${job.start}–${job.end}` : null;
  const windowPhrase = windowText ? `完整的 ${windowText} 时段` : '完整的请求时段';
  const base = {
    code,
    attemptedAt: typeof run.timestamp === 'string' ? run.timestamp : null,
    job: job ? pick(job, ['id', 'date', 'start', 'end']) : (run.jobId ? { id: run.jobId } : null),
    adjacent: Array.isArray(run.adjacent?.runs) ? run.adjacent.runs : [],
    adjacentWindow: run.adjacent?.window || null,
  };
  if (/Opening grid was not ready with a complete permitted interval/i.test(code)) {
    return {
      ...base,
      title: '上次预约未成功',
      reason: `开放时，所有允许球场都没有${windowPhrase}。`,
      detail: '网格已正常加载，但所有允许球场都缺少完整请求时段，通常说明开放后瞬间被订走。',
      action: '未创建预约。请检查当前余位或重新安排一次预约。',
    };
  }
  if (/peak boundary|peak time|crosses the .*peak/i.test(code)) {
    return {
      ...base,
      title: '时段跨越 peak 边界',
      reason: '预约区间跨越了普通时段和 peak time 的分界点。工作日 17:00 起为 peak，周末 13:00 起为 peak；同一个预约不能跨两段。',
      detail: '场地不允许一个预约同时包含普通时段和 peak 时段。结束时间正好在 peak 开始前，或从 peak 开始单独预约，都是允许的。',
      action: '未提交预约。请把结束时间放在 peak 开始前，或从 peak 开始单独预约；系统不会自动拆分或改订。',
    };
  }
  if (/modal-wrapper|waitFor[^\n]*modal/i.test(code)) {
    return {
      ...base,
      title: '上次预约未成功',
      reason: '选择时段后没有出现预约弹窗，所选时长或时段可能不可用。',
      detail: '页面已加载，但点击开始/结束时段后未弹出预约确认框。2 小时连续时段可能超过该账户或场地允许的单次时长；1.5 小时可以正常选择。',
      action: '未创建预约。请尝试较短的完整时段，系统不会自动改订其他时段。',
    };
  }
  if (/latest start deadline|latest_start_passed|late_start/i.test(code)) {
    return {
      ...base,
      title: '上次预约错过了时间窗口',
      reason: '在允许的最晚开始时间前仍未完成提交。',
      detail: '观察器没有及时获得完整可订时段，运行器选择停止，而不是延迟提交。',
      action: '未创建预约。请重新安排开放时间或选择其他时段。',
    };
  }
  if (/slot_not_actionable|intercepts pointer events|hover/i.test(code)) {
    return {
      ...base,
      title: '上次预约无法选择场地',
      reason: '时段已渲染，但无法安全点击。',
      detail: '运行器拒绝强制点击被遮挡、禁用或仍在动画中的时段。',
      action: '未创建预约。请等网格稳定后重试，或换一个球场。',
    };
  }
  if (/payment/i.test(code)) {
    return {
      ...base,
      title: '支付页身份未通过验证',
      reason: '支付页未通过严格的身份校验。',
      detail: '运行器只允许在已验证的账户支付页点击 CANCEL，不会批准支付或推断成功。',
      action: '未批准任何支付。如果已创建预约，请先完成对账再重试。',
    };
  }
  if (/Remote calendar/i.test(code)) {
    return {
      ...base,
      title: '远端预约核验失败',
      reason: 'Hello Club 未及时返回新建的精确预约记录。',
      detail: '可能已经提交，但远端日历没有确认；未核验的本地记录不会显示为成功。',
      action: '可能已存在预约。重试前请先核对 Hello Club 日历。',
    };
  }
  if (/duplicate|already exists remotely/i.test(code)) {
    return {
      ...base,
      title: '已拒绝重复提交',
      reason: '远端日历中已存在相同的预约。',
      detail: '运行器拒绝为同一预约意图提交第二次。',
      action: '未创建新预约。请检查远端日历。',
    };
  }
  return {
    ...base,
    title: '上次预约未成功',
    reason: '运行器在记录到已核验预约前停止。',
    detail: code || '没有具体错误码。',
    action: '只有远端日历确认后才算预约成功。重试前请先查看活动记录。',
  };
}

export function publicBooking(record) {
  const safe = pick(record, [
    'id', 'date', 'start', 'end', 'court', 'bookingType', 'participants', 'paymentStatus', 'verifiedAt', 'source',
  ]);
  const valid = safe && typeof safe.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(safe.date)
    && typeof safe.start === 'string' && typeof safe.end === 'string'
    && /^Court [1-6]$/.test(safe.court)
    && Array.isArray(safe.participants) && safe.participants.length >= 1
    && ['free', 'unpaid_hold', 'paid'].includes(safe.paymentStatus)
    && typeof safe.verifiedAt === 'string';
  return valid ? safe : null;
}

export function parseJsonLines(text, mapper) {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const mapped = mapper(JSON.parse(line));
      return mapped ? [mapped] : [];
    } catch {
      return [];
    }
  });
}

export async function readJsonLines(directory, mapper, { limit = 50 } = {}) {
  let entries;
  try {
    const metadata = await fs.stat(directory);
    if (metadata.isFile()) {
      const content = await fs.readFile(directory, 'utf8');
      return parseJsonLines(content, mapper)
        .sort((a, b) => String(b.timestamp || b.verifiedAt).localeCompare(String(a.timestamp || a.verifiedAt)))
        .slice(0, limit);
    }
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const values = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(directory, file), 'utf8');
    values.push(...parseJsonLines(content, mapper));
  }
  return values.sort((a, b) => String(b.timestamp || b.verifiedAt).localeCompare(String(a.timestamp || a.verifiedAt))).slice(0, limit);
}

export function presentActivity({ dispatches = [], runs = [] }) {
  return [
    ...dispatches.map((event) => ({ ...event, kind: 'dispatcher' })),
    ...runs.map((event) => ({ ...event, kind: 'runner' })),
  ].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 24);
}
