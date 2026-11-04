/** Colour token for recorded channel ``idx`` (0-based). Channels 1–5
 *  use the five user-adjustable trace colours; channels 6–9 use
 *  extra tokens so up to nine channels are told apart before the
 *  palette repeats. Shared by the viewer and the Traces dropdown. */
export const CHANNEL_COLOR_VARS = [
  '--trace-color-1', '--trace-color-2', '--trace-color-3', '--trace-color-4',
  '--trace-color-5', '--trace-color-6', '--trace-color-7', '--trace-color-8',
  '--trace-color-9',
]

export function channelColorVar(idx: number): string {
  const n = CHANNEL_COLOR_VARS.length
  return CHANNEL_COLOR_VARS[((idx % n) + n) % n]
}
