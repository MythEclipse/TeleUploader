type QueueTask<T> = {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
};

class TelegramQueue {
  private activeCount = 0;
  private queue: QueueTask<any>[] = [];
  private concurrency: number;

  constructor(concurrency = 2) {
    this.concurrency = concurrency;
  }

  public enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift()!;
    this.activeCount++;

    try {
      const result = await item.task();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      this.activeCount--;
      this.processNext();
    }
  }
}

const telegramQueue = new TelegramQueue(2);

export const enqueueUpload = <T>(task: () => Promise<T>): Promise<T> => {
  return telegramQueue.enqueue(task);
};
