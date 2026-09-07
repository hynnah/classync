const { activityRangeClause } = require('../../server/src/db/repositories/AdminRepo');

describe('AdminRepo.activityRangeClause', () => {
  test('"today" filters from local midnight, no bound parameter needed', () => {
    const { clause, param } = activityRangeClause('today');
    expect(clause).toContain('CURDATE()');
    expect(param).toBeNull();
  });

  test('a bare number of days filters from that many days back, as a bound parameter', () => {
    for (const range of ['7', '30', '90']) {
      const { clause, param } = activityRangeClause(range);
      expect(clause).toContain('DATE_SUB(NOW(), INTERVAL ? DAY)');
      expect(param).toBe(Number(range));
    }
  });

  test('"all", missing, or a non-numeric range applies no filter', () => {
    for (const range of ['all', undefined, '', 'not-a-number']) {
      const { clause, param } = activityRangeClause(range);
      expect(clause).toBe('');
      expect(param).toBeNull();
    }
  });

  test('a zero or negative day count is treated as no filter, not an always-false one', () => {
    for (const range of ['0', '-5']) {
      const { clause, param } = activityRangeClause(range);
      expect(clause).toBe('');
      expect(param).toBeNull();
    }
  });
});
