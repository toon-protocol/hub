export const DEFAULT_REFRESH_INTERVAL_MS = 2_000;
export const DEFAULT_API_URL = 'http://127.0.0.1:28090';

/**
 * How many consecutive failed fetches to treat as "still starting up" before a
 * node has ever responded. During this grace window the dashboard shows a calm
 * "Starting up…" banner (a fresh node's API takes a few seconds to come up);
 * after it, persistent failure escalates to the louder "Last refresh failed"
 * so a genuinely-broken/crash-looping API doesn't masquerade as "starting" forever.
 * At the 2s refresh interval, 3 ≈ a ~6s grace.
 */
export const STARTING_UP_GRACE_FETCHES = 3;
