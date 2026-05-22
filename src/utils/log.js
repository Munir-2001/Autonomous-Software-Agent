import { CONFIG } from '../config.js';

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const current = levels[CONFIG.LOG_LEVEL] ?? 1;

function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export const log = {
  debug: (...a) => current <= 0 && console.log(`[${ts()}]`, ...a),
  info:  (...a) => current <= 1 && console.log(`[${ts()}]`, ...a),
  warn:  (...a) => current <= 2 && console.warn(`[${ts()}]`, ...a),
  error: (...a) => current <= 3 && console.error(`[${ts()}]`, ...a),
};
