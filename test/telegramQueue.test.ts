import { describe, expect, it } from 'bun:test';
import { enqueueUpload } from '../src/utils/telegramQueue';

describe('Telegram Queue', () => {
  it('should process tasks in order and limit concurrency', async () => {
    let activeTasks = 0;
    let maxActiveTasks = 0;
    const executionOrder: number[] = [];

    const createTask = (id: number, delayMs: number) => {
      return async () => {
        activeTasks++;
        if (activeTasks > maxActiveTasks) {
          maxActiveTasks = activeTasks;
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        executionOrder.push(id);
        activeTasks--;
        return id;
      };
    };

    // Enqueue 4 tasks with delays
    const promises = [
      enqueueUpload(createTask(1, 50)),
      enqueueUpload(createTask(2, 20)),
      enqueueUpload(createTask(3, 10)),
      enqueueUpload(createTask(4, 5)),
    ];

    const results = await Promise.all(promises);

    expect(results).toEqual([1, 2, 3, 4]);
    // Concurrency limit is 2, so maximum active tasks at any time should be <= 2
    expect(maxActiveTasks).toBeLessThanOrEqual(2);
  });
});
