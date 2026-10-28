// Import-free so the client component can use it without bundling server code.
// Engaging is an emergency stop: one click, no prompt. Only releasing asks.
export function nextKillSwitch(
  engaged: boolean,
  confirm: (msg: string) => boolean,
): boolean | null {
  if (!engaged) return true;
  return confirm('Release the kill switch? The engine may resume trading.') ? false : null;
}
