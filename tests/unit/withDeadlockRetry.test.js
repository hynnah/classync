const { withDeadlockRetry } = require('../../server/src/db/pool');

function deadlockError() {
  return Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), {
    code: 'ER_LOCK_DEADLOCK',
  });
}

describe('withDeadlockRetry', () => {
  test('returns the result on a first-try success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withDeadlockRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on ER_LOCK_DEADLOCK and succeeds once the retry clears', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(deadlockError())
      .mockResolvedValueOnce('recovered');
    const result = await withDeadlockRetry(fn);
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('gives up and rethrows after exhausting all attempts', async () => {
    const fn = jest.fn().mockRejectedValue(deadlockError());
    await expect(withDeadlockRetry(fn, 3)).rejects.toThrow(/deadlock/i);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('a non-retryable error is thrown immediately, with no retry at all', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('something unrelated'));
    await expect(withDeadlockRetry(fn, 3)).rejects.toThrow('something unrelated');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
