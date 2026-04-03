/**
 * Classic / POS-style beep — Web Audio (không cần file .mp3).
 * Dùng khi API scanner không phát âm (vd. Scanbot Classic view bỏ qua `Sound` trong config;
 * chỉ RTU `ScanbotSDK.UI.createBarcodeScanner` mới gắn SoundManager).
 */
let audioCtx: AudioContext | null = null

export function playClassicPosBeep(): void {
  if (typeof window === 'undefined') return
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    if (!AC) return
    if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AC()
    void audioCtx.resume()
    const t0 = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(1850, t0)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.072)
    osc.connect(g)
    g.connect(audioCtx.destination)
    osc.start(t0)
    osc.stop(t0 + 0.085)
  } catch {
    /* ignore */
  }
}
