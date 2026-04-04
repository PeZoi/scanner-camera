/**
 * Kiểm tra checksum GTIN (GS1) — dùng khi bật chế độ chặt.
 * Lưu ý: một số mã in trên bao bì có thể không theo chuẩn hoặc nhập tay sai.
 */

export function isValidEan13(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) {
    const d = digits.charCodeAt(i) - 48
    sum += d * (i % 2 === 0 ? 1 : 3)
  }
  const check = (10 - (sum % 10)) % 10
  return check === digits.charCodeAt(12) - 48
}

export function isValidEan8(digits: string): boolean {
  if (!/^\d{8}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 7; i++) {
    const d = digits.charCodeAt(i) - 48
    sum += d * (i % 2 === 0 ? 3 : 1)
  }
  const check = (10 - (sum % 10)) % 10
  return check === digits.charCodeAt(7) - 48
}

export function isValidUpcA(digits: string): boolean {
  if (!/^\d{12}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 11; i++) {
    const d = digits.charCodeAt(i) - 48
    sum += d * (i % 2 === 0 ? 3 : 1)
  }
  const check = (10 - (sum % 10)) % 10
  return check === digits.charCodeAt(11) - 48
}

/**
 * Chuỗi chỉ số độ dài 8 / 12 / 13: bắt buộc đúng checksum.
 * Độ dài / ký tự khác: cho qua (CODE128, QR text, v.v.).
 */
export function passesStrictGtinChecksum(text: string): boolean {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return true
  const n = t.length
  if (n === 13) return isValidEan13(t)
  if (n === 8) return isValidEan8(t)
  if (n === 12) return isValidUpcA(t)
  return true
}
