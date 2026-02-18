function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const next = new Date(date);
  next.setDate(next.getDate() + n);
  return next;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function usableMinutesForDay(profile, date) {
  const weekday = date.getDay();
  const offDays = profile.settings?.offDays || [];
  if (offDays.includes(weekday)) return 0;

  const configured = Number(profile.settings?.weekdayHours?.[weekday] || 0);
  const bufferRatio = clamp(Number(profile.settings?.bufferRatio ?? 0.2), 0.05, 0.4);
  return Math.floor(configured * (1 - bufferRatio));
}

function dateRange(start, end) {
  const list = [];
  let cur = new Date(start);
  while (cur <= end) {
    list.push(new Date(cur));
    cur = addDays(cur, 1);
  }
  return list;
}

function pickLastDate(taskType, dueDate) {
  const end = new Date(dueDate);
  if (taskType === 'exam_prep') {
    end.setDate(end.getDate() - 3);
  }
  return end;
}

export function evaluatePlanFeasibility(input, profile) {
  const now = new Date();
  const startDate = input?.startDate ? new Date(input.startDate) : now;
  const finishBy = pickLastDate(input?.taskType, input?.dueDate);
  const totalPages = Math.max(0, Number(input?.totalPages || 0));
  const pageMinutes = Math.max(1, Number(input?.minutesPerPage || 1));
  const requiredMinutes = totalPages * pageMinutes;

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(finishBy.getTime())) {
    return {
      feasible: false,
      reason: 'invalid_date',
      message: '시작일/마감일 형식이 올바르지 않습니다.'
    };
  }

  if (finishBy < startDate) {
    return {
      feasible: false,
      reason: 'invalid_range',
      message: '시작일 이후에 배정 가능한 날짜가 없습니다. 마감일 또는 유형을 확인하세요.'
    };
  }

  if (totalPages <= 0) {
    return {
      feasible: false,
      reason: 'invalid_pages',
      message: '전체 페이지는 1 이상이어야 합니다.'
    };
  }

  const days = dateRange(startDate, finishBy);
  const dailyCaps = days.map((date) => ({
    date: toDateKey(date),
    usableMinutes: usableMinutesForDay(profile, date)
  }));
  const availableDays = dailyCaps.filter((d) => d.usableMinutes > 0).length;
  const availableMinutes = dailyCaps.reduce((acc, d) => acc + d.usableMinutes, 0);

  if (availableDays <= 0 || availableMinutes <= 0) {
    return {
      feasible: false,
      reason: 'no_capacity',
      message: '오프데이/요일별 가능 시간 설정으로 인해 배정 가능한 시간이 없습니다.',
      requiredMinutes,
      availableMinutes,
      availableDays
    };
  }

  if (requiredMinutes > availableMinutes) {
    const shortage = requiredMinutes - availableMinutes;
    return {
      feasible: false,
      reason: 'capacity_shortage',
      message: `현재 설정/마감일로는 불가능합니다. 필요 ${requiredMinutes}분, 가능 ${availableMinutes}분, 부족 ${shortage}분입니다.`,
      requiredMinutes,
      availableMinutes,
      shortageMinutes: shortage,
      availableDays
    };
  }

  return {
    feasible: true,
    reason: 'ok',
    requiredMinutes,
    availableMinutes,
    availableDays
  };
}

function buildSimplePlan(input, profile) {
  const today = new Date();
  const startDate = input.startDate ? new Date(input.startDate) : today;
  const finishBy = pickLastDate(input.taskType, input.dueDate);
  const totalPages = Math.max(0, Number(input.totalPages || 0));
  const startPage = Math.max(1, Number(input.startPage || 1));
  const pageMinutes = Math.max(1, Number(input.minutesPerPage || 1));

  const days = dateRange(startDate, finishBy).filter((d) => usableMinutesForDay(profile, d) > 0);
  if (!days.length) {
    throw new Error('오프데이를 제외한 할당 가능한 날짜가 없습니다. 설정에서 요일별 시간을 확인하세요.');
  }

  const totalMinutes = totalPages * pageMinutes;
  const perDayBase = Math.ceil(totalMinutes / days.length);

  let remainingPages = totalPages;
  let nextPage = startPage;
  const scheduled = [];

  for (const day of days) {
    const key = toDateKey(day);
    const maxMinutes = usableMinutesForDay(profile, day);
    const allocMinutes = Math.min(maxMinutes, perDayBase);
    const allocPages = Math.max(0, Math.min(remainingPages, Math.ceil(allocMinutes / pageMinutes)));
    const trueMinutes = allocPages * pageMinutes;

    if (allocPages > 0) {
      scheduled.push({
        date: key,
        minutes: trueMinutes,
        pages: allocPages,
        pageFrom: nextPage,
        pageTo: nextPage + allocPages - 1,
        status: 'pending'
      });
      remainingPages -= allocPages;
      nextPage += allocPages;
    }

    if (remainingPages <= 0) break;
  }

  if (remainingPages > 0) {
    const remainingMinutes = remainingPages * pageMinutes;
    throw new Error(
      `현재 설정/마감일로는 불가능합니다. ${remainingPages}페이지(${remainingMinutes}분)가 마감 전까지 배정되지 않습니다.`
    );
  }

  return {
    planName: input.bookName,
    subject: input.subject,
    taskType: input.taskType,
    dueDate: input.dueDate,
    pressureMode: Boolean(input.pressureMode),
    notes: input.notes || '',
    createdAt: new Date().toISOString(),
    schedule: scheduled
  };
}

function insertTasksByCapacity(profile, startDateKey, tasks) {
  const result = {};
  let queue = [...tasks];
  let cursor = new Date(startDateKey);
  let guard = 0;

  while (queue.length) {
    guard += 1;
    if (guard > 3660) {
      throw new Error('재분배 실패: 할당 가능한 시간 설정이 부족합니다. 설정에서 요일별 시간을 확인하세요.');
    }
    const key = toDateKey(cursor);
    const cap = usableMinutesForDay(profile, cursor);
    if (cap > 0) {
      let used = 0;
      const pack = [];
      while (queue.length && used + queue[0].minutes <= cap) {
        const task = queue.shift();
        pack.push({ ...task, date: key, status: 'pending' });
        used += task.minutes;
      }
      if (!pack.length && queue.length) {
        const forced = queue.shift();
        pack.push({ ...forced, date: key, status: 'pending' });
      }
      result[key] = pack;
    }
    cursor = addDays(cursor, 1);
  }

  return result;
}

function parsePageRange(pages) {
  const text = String(pages || '').trim();
  if (!text) return null;
  const match = text.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start <= 0 || end <= 0) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function planKey(task) {
  return `${task.title || ''}::${task.taskType || ''}`;
}

function sortQueueByPageOrder(tasks) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const aKey = planKey(a.task);
      const bKey = planKey(b.task);
      if (aKey !== bKey) return a.index - b.index;

      const aRange = parsePageRange(a.task.pages);
      const bRange = parsePageRange(b.task.pages);
      if (!aRange && !bRange) return a.index - b.index;
      if (!aRange) return 1;
      if (!bRange) return -1;
      if (aRange.start !== bRange.start) return aRange.start - bRange.start;
      if (aRange.end !== bRange.end) return aRange.end - bRange.end;
      return a.index - b.index;
    })
    .map((wrapped) => wrapped.task);
}

function sortTasksInDate(tasks) {
  return [...tasks].sort((a, b) => {
    const aRange = parsePageRange(a.pages);
    const bRange = parsePageRange(b.pages);
    if (!aRange && !bRange) return 0;
    if (!aRange) return 1;
    if (!bRange) return -1;
    if (aRange.start !== bRange.start) return aRange.start - bRange.start;
    if (aRange.end !== bRange.end) return aRange.end - bRange.end;
    return 0;
  });
}

function collectUndoneTasks(calendar, todayKey) {
  const backlog = [];
  const today = [];
  const future = [];

  const orderedDates = Object.keys(calendar.tasks || {}).sort();
  for (const date of orderedDates) {
    const tasks = calendar.tasks?.[date] || [];
    for (const task of tasks) {
      if (task.status === 'done') continue;
      const item = { ...task, originalDate: date };
      if (date < todayKey) backlog.push(item);
      else if (date === todayKey) today.push(item);
      else future.push(item);
    }
  }

  return { backlog, today, future };
}

export function generatePlan(input, profile) {
  return buildSimplePlan(input, profile);
}

export function planToCalendarPlan(plan, existingCalendar) {
  const calendar = existingCalendar || { tasks: {} };
  for (const item of plan.schedule) {
    calendar.tasks[item.date] = calendar.tasks[item.date] || [];
    const uid = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    calendar.tasks[item.date].push({
      id: `${plan.planName}-${item.date}-${item.pageFrom}-${uid}`,
      title: `${plan.subject} ${plan.planName}`,
      minutes: item.minutes,
      pages: `${item.pageFrom}-${item.pageTo}`,
      taskType: plan.taskType,
      status: item.status,
      source: 'plan'
    });
  }
  return calendar;
}

export function rebalanceFromToday(profile, calendar, todayKey) {
  const { backlog, today, future } = collectUndoneTasks(calendar, todayKey);
  const queue = sortQueueByPageOrder([...backlog, ...today, ...future]);
  if (!queue.length) return calendar;

  // "오늘 할 일 다음으로 미루기" 동작: 오늘 미완료부터 내일 이후로 재배치.
  const startDateKey = toDateKey(addDays(new Date(todayKey), 1));
  const redistributed = insertTasksByCapacity(profile, startDateKey, queue);

  const newTasks = {};
  Object.entries(calendar.tasks || {}).forEach(([date, tasks]) => {
    const doneOnly = tasks.filter((t) => t.status === 'done');
    if (doneOnly.length) newTasks[date] = doneOnly;
  });

  Object.entries(redistributed).forEach(([date, tasks]) => {
    newTasks[date] = sortTasksInDate([...(newTasks[date] || []), ...tasks]);
  });

  return { tasks: newTasks };
}
