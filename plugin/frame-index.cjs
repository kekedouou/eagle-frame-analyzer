'use strict';

// Pure source-frame mapping. No files, Eagle calls, average-FPS inference or I/O.
// Persist integer timestamps as decimal strings; subtract rational timestamps
// before converting their short relative interval to a JavaScript Number.
function ticks(value, label) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error((label || 'PTS') + ' must be an integer decimal string.');
  }
  return BigInt(value);
}

function timeBase(value) {
  if (!Array.isArray(value) || value.length !== 2 || value.some(part => !Number.isSafeInteger(part) || part <= 0)) {
    throw new Error('timeBase must contain two positive safe integers.');
  }
  return [value[0], value[1]];
}

function stamp(value, base, label) {
  const tb = timeBase(base);
  return { ticks: ticks(value, label), numerator: BigInt(tb[0]), denominator: BigInt(tb[1]), timeBase: tb };
}

function difference(left, right) {
  return {
    numerator: left.ticks * left.numerator * right.denominator - right.ticks * right.numerator * left.denominator,
    denominator: left.denominator * right.denominator
  };
}

function secondsBetween(left, right) {
  const value = difference(left, right);
  const whole = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  const seconds = Number(whole) + Number(remainder) / Number(value.denominator);
  if (!Number.isFinite(seconds)) throw new Error('Relative timestamp cannot be represented as finite seconds.');
  return seconds;
}

function sameSeconds(left, right) {
  return Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(1, Math.abs(left), Math.abs(right));
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(label + ' must be a positive safe integer.');
}

function resource(entry, label) {
  if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string' || !entry.file.trim()) {
    throw new Error(label + ' must name a cache resource.');
  }
  positiveInteger(entry.bytes, label + '.bytes');
  // Cache ownership/path/hash verification belongs to the cache layer. A valid
  // index alone never grants permission to read the named resource.
}

function frameResource(frame, seen) {
  resource(frame, 'frame');
  if (!Number.isSafeInteger(frame.id) || frame.id < 0 || seen.has(frame.id)) {
    throw new Error('Every presented frame must have its own nonnegative safe-integer id.');
  }
  seen.add(frame.id);
}

function frameList(frames) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('A nonempty presented-frame list is required.');
}

/**
 * rows: presented order, each {id, ptsTicks:string, file, bytes, timeBase?}.
 * options.timeBase supplies the default base. lastFrameEndTicks is mandatory;
 * options.endTimeBase may differ from the decoded frames' timestamp base.
 * Duplicate PTS retain separate frames and zero-length intervals. Time seek
 * chooses the last frame at that timestamp; ordinal stepping visits them all.
 */
function buildIndex(rows, options) {
  frameList(rows);
  if (!options || typeof options !== 'object') throw new Error('Explicit last-frame end information is required.');
  const defaultBase = options.timeBase === undefined ? undefined : timeBase(options.timeBase);
  const seen = new Set();
  const stamps = rows.map(row => {
    frameResource(row, seen);
    return stamp(row.ptsTicks, row.timeBase === undefined ? defaultBase : row.timeBase);
  });
  const origin = stamps[0];
  const endsAt = stamp(options.lastFrameEndTicks,
    options.endTimeBase === undefined ? (defaultBase || origin.timeBase) : options.endTimeBase,
    'lastFrameEndTicks');
  if (difference(endsAt, stamps[stamps.length - 1]).numerator <= 0n) {
    throw new Error('Explicit last-frame end must be later than the final source PTS.');
  }
  const times = stamps.map((value, index) => {
    if (index && difference(value, stamps[index - 1]).numerator < 0n) {
      throw new Error('Presented source PTS must not move backwards.');
    }
    const time = secondsBetween(value, origin);
    if (index && difference(value, stamps[index - 1]).numerator > 0n && time <= secondsBetween(stamps[index - 1], origin)) {
      throw new Error('Distinct source times collapse at the available seconds precision.');
    }
    return time;
  });
  const videoDuration = secondsBetween(endsAt, origin);
  if (!(videoDuration > times[times.length - 1])) {
    throw new Error('The final display interval cannot be represented reliably.');
  }
  const frames = rows.map((row, index) => Object.assign({}, row, {
    ptsTicks: stamps[index].ticks.toString(), timeBase: stamps[index].timeBase,
    time: times[index], end: index + 1 < rows.length ? times[index + 1] : videoDuration
  }));
  return { frames: frames, videoDuration: videoDuration, originPtsTicks: origin.ticks.toString(), timeBase: origin.timeBase.slice() };
}

/** Validate once on load; query functions below then use this presented order. */
function validateIndex(info) {
  if (!info || typeof info !== 'object') throw new Error('Media index is required.');
  positiveInteger(info.width, 'width'); positiveInteger(info.height, 'height');
  if (!Number.isSafeInteger(info.width * info.height * 4)) throw new Error('Decoded frame byte size cannot be represented safely.');
  if (!Number.isFinite(info.duration) || info.duration <= 0) throw new Error('Media duration must be positive finite seconds.');
  frameList(info.frames);
  const seen = new Set();
  let origin = null, previous = null;
  info.frames.forEach((frame, index) => {
    frameResource(frame, seen);
    const value = stamp(frame.ptsTicks, frame.timeBase);
    if (origin === null) origin = value;
    if (previous && difference(value, previous).numerator < 0n) throw new Error('Presented source PTS must not move backwards.');
    if (!Number.isFinite(frame.time) || frame.time < 0 || !Number.isFinite(frame.end) || frame.end < frame.time) {
      throw new Error('Frame display interval is invalid.');
    }
    if (!sameSeconds(frame.time, secondsBetween(value, origin))) throw new Error('Frame seconds do not match the original integer PTS.');
    if (index === 0 && frame.time !== 0) throw new Error('The first source frame defines video time zero.');
    if (index && frame.time < info.frames[index - 1].time) throw new Error('Frame seconds must not move backwards.');
    if (previous && difference(value, previous).numerator > 0n && frame.time <= info.frames[index - 1].time) {
      throw new Error('Distinct source times collapse at the available seconds precision.');
    }
    if (index && !sameSeconds(info.frames[index - 1].end, frame.time)) {
      throw new Error('Frame display intervals must follow the next presented PTS.');
    }
    previous = value;
  });
  const last = info.frames[info.frames.length - 1];
  if (!(last.end > last.time)) throw new Error('The final frame needs an explicit positive display interval.');
  if (info.duration < last.end && !sameSeconds(info.duration, last.end)) throw new Error('Media duration does not contain the video end.');
  if (info.audio !== undefined && info.audio !== null) {
    const audio = info.audio;
    resource(audio, 'audio');
    if (!Number.isFinite(audio.start) || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      throw new Error('Audio start must be finite and audio duration positive.');
    }
    positiveInteger(audio.channels, 'audio.channels'); positiveInteger(audio.sampleRate, 'audio.sampleRate');
    const audioEnd = audio.start + audio.duration;
    if (!Number.isFinite(audioEnd) || info.duration < audioEnd && !sameSeconds(info.duration, audioEnd)) {
      throw new Error('Media duration does not contain the audio end.');
    }
  }
  return info;
}

function frameAt(frames, time) {
  frameList(frames);
  if (!Number.isFinite(time)) throw new Error('Seek time must be finite.');
  let low = 0, high = frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle].time <= time) low = middle + 1; else high = middle;
  }
  return Math.max(0, low - 1);
}

function stepIndex(frames, currentIndex, delta) {
  frameList(frames);
  if (!Number.isSafeInteger(currentIndex) || currentIndex < 0 || currentIndex >= frames.length || !Number.isSafeInteger(delta)) {
    throw new Error('Step requires a current ordinal and a safe-integer delta.');
  }
  if (delta <= -currentIndex) return 0;
  if (delta >= frames.length - 1 - currentIndex) return frames.length - 1;
  return currentIndex + delta;
}

function audioStartPlan(mediaTime, audioStart, audioDuration, contextTime) {
  if (!Number.isFinite(mediaTime) || mediaTime < 0 || !Number.isFinite(audioStart)
    || !Number.isFinite(audioDuration) || audioDuration <= 0 || !Number.isFinite(contextTime) || contextTime < 0) {
    throw new Error('Audio planning needs finite media/context times and positive duration.');
  }
  const offset = Math.max(0, mediaTime - audioStart);
  if (offset >= audioDuration) return null;
  const when = contextTime + Math.max(0, audioStart - mediaTime);
  if (!Number.isFinite(when)) throw new Error('Scheduled audio time is not finite.');
  return { when: when, offset: offset };
}

module.exports = { buildIndex, validateIndex, frameAt, stepIndex, audioStartPlan };
