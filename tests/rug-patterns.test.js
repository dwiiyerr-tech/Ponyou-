import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { approvePattern, learnPatterns, matchPatterns } from '../tools/rug-patterns.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUG_MEMORY = path.join(ROOT, 'rug-memory.json');
const LEARNED = path.join(ROOT, 'rug-patterns-learned.json');

const backups = new Map();

function backup(file) {
  if (!backups.has(file)) {
    backups.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  }
}

function restore(file) {
  const original = backups.get(file);
  if (original == null) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } else {
    fs.writeFileSync(file, original);
  }
}

afterEach(() => {
  restore(RUG_MEMORY);
  restore(LEARNED);
  backups.clear();
});

describe('rug pattern learning', () => {
  it('stores provenance and keeps learned patterns soft until reviewed', () => {
    backup(RUG_MEMORY);
    backup(LEARNED);

    fs.writeFileSync(RUG_MEMORY, JSON.stringify({
      patterns: [
        { symbol: 'AAA', rug_signals: { top10_concentration_pct: 80, fresh_funded_holders: 5, bundle_buyers_pct: 40, lp_locked: false } },
        { symbol: 'BBB', rug_signals: { top10_concentration_pct: 80, fresh_funded_holders: 5, bundle_buyers_pct: 40, lp_locked: false } },
        { symbol: 'CCC', rug_signals: { top10_concentration_pct: 80, fresh_funded_holders: 5, bundle_buyers_pct: 40, lp_locked: false } },
      ],
    }, null, 2));

    const result = learnPatterns();
    expect(result.learned).toBeGreaterThan(0);

    const file = JSON.parse(fs.readFileSync(LEARNED, 'utf8'));
    const learned = file.patterns[0];
    expect(learned.provenance.sample_count).toBe(3);
    expect(learned.provenance.source_file).toBe('rug-memory.json');
    expect(learned.review_status).toBe('pending');

    const matchedBeforeReview = matchPatterns({ top10_concentration_pct: 80, fresh_funded_holders: 5, bundle_buyers_pct: 40, lp_locked: false });
    expect(matchedBeforeReview[0].soft_only).toBe(true);
    expect(matchedBeforeReview[0].effective_weight).toBeLessThanOrEqual(18);

    const approval = approvePattern(learned.pattern_id, { approvedBy: 'tester', note: 'verified manually' });
    expect(approval.approved).toBe(true);

    const matchedAfterReview = matchPatterns({ top10_concentration_pct: 80, fresh_funded_holders: 5, bundle_buyers_pct: 40, lp_locked: false });
    expect(matchedAfterReview[0].soft_only).toBe(false);
    expect(matchedAfterReview[0].review_status).toBe('approved');
  });
});
