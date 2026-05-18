function isOptOut(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === '' || value === '0' || value.toLowerCase() === 'false')
    return false;
  return true;
}

export function shouldRenderInk(): boolean {
  if (process.stdout.isTTY !== true) return false;
  if (process.env['CI'] === 'true') return false;
  if (isOptOut(process.env['NO_TUI'])) return false;
  if ((process.env['TERM'] ?? '') === 'dumb') return false;
  return true;
}

export function isTmux(): boolean {
  if (process.env['TMUX'] !== undefined && process.env['TMUX'] !== '')
    return true;
  const term = process.env['TERM'] ?? '';
  return /^screen|^tmux/.test(term);
}
