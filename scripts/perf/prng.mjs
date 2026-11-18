function toUint32(value) {
  const mod = value % 4_294_967_296;
  return mod < 0 ? mod + 4_294_967_296 : Math.trunc(mod);
}

export function parseSeed(rawSeed) {
  if (rawSeed === undefined || rawSeed === null || rawSeed === '') {
    return toUint32(Date.now() ^ Math.trunc(Math.random() * 0x1_0000_0000));
  }
  const numeric = Number(rawSeed);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 0xffff_ffff) {
    return toUint32(numeric);
  }
  let hash = 2_166_136_261;
  const text = String(rawSeed);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return toUint32(hash);
}

export function createMulberry32(seed) {
  let state = toUint32(seed);
  return () => {
    state = toUint32(state + 0x6d2b79f5);
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return toUint32(t ^ (t >>> 14)) / 4_294_967_296;
  };
}

export function seededSample(items, count, rng) {
  const copy = [...items];
  const take = Math.min(Math.max(0, count), copy.length);
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(rng() * (copy.length - i));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, take);
}
