/** Một dòng trong danh sách quét: mã duy nhất + số lần đọc (trùng mã thì cộng). */
export type ScanListEntry = {
  text: string
  count: number
  format?: string | null
}

export function addScanToList(
  prev: ScanListEntry[],
  text: string,
  format?: string | null,
): ScanListEntry[] {
  const trimmed = text.trim()
  if (!trimmed) return prev
  const i = prev.findIndex((e) => e.text === trimmed)
  if (i >= 0) {
    const next = [...prev]
    const cur = next[i]
    next[i] = {
      ...cur,
      count: cur.count + 1,
      format:
        format != null && String(format).length > 0 ? String(format) : cur.format,
    }
    return next
  }
  return [...prev, { text: trimmed, count: 1, format: format ?? null }]
}

/** Tổng số lượt quét (cộng dồn mọi dòng). */
export function totalScanCount(entries: ScanListEntry[]): number {
  return entries.reduce((s, e) => s + e.count, 0)
}

export function formatScanListForClipboard(entries: ScanListEntry[]): string {
  return entries.map((e) => `${e.text}\t×${e.count}`).join('\n')
}
