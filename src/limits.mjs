// Rate limits: a user's commands beyond 10 in 60 s of message.date get one slow-down notice, then are ignored
// until the window passes. Only the dates of the last minute are kept, by user id, never a name.
const WINDOW = 60, MOST = 10;

/** 'answer', 'notice' (the one slow-down notice) or 'ignore', for a command `user` sent at `date`. */
export function admit(state, user, date) {
  if (!Number.isSafeInteger(user) || !Number.isSafeInteger(date)) return 'answer';
  for (const [id, entry] of Object.entries(state.users)) if (entry.dates.at(-1) <= date - WINDOW) delete state.users[id];
  const entry = state.users[user] ??= { dates: [], noticed: false };
  entry.dates = entry.dates.filter((d) => d > date - WINDOW);
  if (entry.dates.length < MOST) {
    entry.dates.push(date);
    entry.noticed = false;
    return 'answer';
  }
  if (entry.noticed) return 'ignore';
  entry.noticed = true;
  return 'notice';
}

/** Drops the users whose last command is over a minute old (`now`: chain time, which message dates follow). */
export function forgetIdle(state, now) {
  for (const [id, entry] of Object.entries(state.users)) if (entry.dates.at(-1) <= now - WINDOW) delete state.users[id];
}
