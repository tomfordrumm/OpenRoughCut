const normalize = (text) => String(text ?? '').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function wordDiff(text, reference) {
  const words = String(text).match(/\s+|[^\s]+/gu) ?? [];
  const a = words.map((word, index) => ({ word: normalize(word), index })).filter(x => x.word);
  const b = normalize(reference).split(' ').filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i].word === b[j] ? 1 + dp[i+1][j+1] : Math.max(dp[i+1][j], dp[i][j+1]);
  const common = new Set(); let i = 0, j = 0;
  while (i < a.length && j < b.length) { if (a[i].word === b[j]) { common.add(a[i++].index); j++; } else if (dp[i+1][j] >= dp[i][j+1]) i++; else j++; }
  return words.map((text, index) => ({ text, changed: Boolean(normalize(text)) && !common.has(index) }));
}
export function reviewChains(segments, candidates) {
  const grouped = new Map();
  for (const c of candidates.filter(c => c.groupId)) {
    if (!grouped.has(c.groupId)) grouped.set(c.groupId, { takes: [], candidates: [] });
    const group = grouped.get(c.groupId); group.candidates.push(c);
    const existing = group.takes.find(t => t.attemptId === c.attemptId);
    if (existing) { existing.start = Math.min(existing.start, c.start); existing.end = Math.max(existing.end, c.end); existing.candidate = { ...existing.candidate, canApply: existing.candidate.canApply !== false && c.canApply !== false }; }
    else group.takes.push({ start: c.start, end: c.end, text: c.removedText, candidate: c, attemptId: c.attemptId, segmentIndex: segments.findIndex(s => c.start < s.end && c.end > s.start) });
    if (!group.takes.some(t => t.attemptId === c.winnerId)) {
      const ranges = c.keptRanges;
      const start = ranges?.length ? Math.min(...ranges.map(r => r.start)) : null, end = ranges?.length ? Math.max(...ranges.map(r => r.end)) : null;
      group.takes.push({ start, end, text: c.keptText, attemptId: c.winnerId, selected: true, segmentIndex: segments.findIndex(s => start != null && start < s.end && end > s.start) });
    }
  }
  const groups = [...grouped.values()];
  for (const c of candidates.filter(x => !x.groupId && x.keptText && x.reason !== 'non-verbal')) {
    const source = segments.findIndex(s => c.start < s.end && c.end > s.start);
    if (source < 0) continue;
    const targetText = normalize(c.keptText);
    let target = null, bestExtra = Infinity;
    for (let i = source; i < segments.length; i++) {
      for (let count = 1; count <= 5 && i + count <= segments.length; count++) {
        const slice = segments.slice(i, i+count);
        const joined = normalize(slice.map(s => s.text).join(' '));
        if (joined.includes(targetText) && joined.length-targetText.length < bestExtra) {
          bestExtra = joined.length-targetText.length;
          target = { start: slice[0].start, end: slice.at(-1).end, text: c.keptText, segmentIndex: i };
          // A phrase inside a larger block has no editable bounds until aligned to words.
          if (bestExtra > 2) target = { ...target, start: null, end: null };
        }
      }
    }
    const earlier = { start: c.start, end: c.end, text: c.removedText, candidate: c, segmentIndex: source };
    const later = target ?? { start: null, end: null, text: c.keptText, segmentIndex: null };
    const connected = groups.filter(g => g.takes.some(t => [earlier,later].some(n => n.start != null && t.start != null && Math.abs(t.start-n.start) < .05 && Math.abs(t.end-n.end) < .05)));
    const group = connected.shift() ?? { takes: [], candidates: [] };
    for (const g of connected) { group.takes.push(...g.takes); group.candidates.push(...g.candidates); groups.splice(groups.indexOf(g),1); }
    if (!groups.includes(group)) groups.push(group);
    for (const take of [earlier,later]) {
      const existing = group.takes.find(t => t.start === take.start && t.end === take.end && (t.start != null || t.text === take.text));
      if (!existing) group.takes.push(take); else if (take.candidate) Object.assign(existing, take);
    }
    group.candidates.push(c);
  }
  return groups.map(g => ({ ...g, takes: g.takes.sort((a,b) => (a.start ?? Infinity)-(b.start ?? Infinity)), start: Math.min(...g.takes.filter(t=>t.start!=null).map(t=>t.start)) })).sort((a,b)=>a.start-b.start);
}
