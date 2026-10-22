// Two quiet sounds, made on the spot with Web Audio (no audio files), used sparingly: a soft tick when a run
// starts and two rising notes when its result lands. Browsers only allow sound after a click, and every run
// starts with one.
let ctx = null;
const audio = () => {
  try { ctx ||= new AudioContext(); if (ctx.state === 'suspended') ctx.resume(); return ctx; } catch { return null; }
};
function tone(freq, at, length, gain, type = 'sine') {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at, osc = a.createOscillator(), env = a.createGain();
  osc.type = type; osc.frequency.value = freq;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(env).connect(a.destination);
  osc.start(t); osc.stop(t + length + 0.05);
}
export const tick = () => tone(880, 0, 0.09, 0.03, 'triangle');
export const chime = () => { tone(659.25, 0, 0.5, 0.045); tone(987.77, 0.12, 0.7, 0.04); };
