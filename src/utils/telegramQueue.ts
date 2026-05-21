import PQueue from 'p-queue';
import logger from './logger';

const uploadQueue = new PQueue({
  concurrency: Number.POSITIVE_INFINITY,
});

// Monitor queue events
uploadQueue.on('add', () => {
  const stats = getQueueStats();
  if (stats.size > 5) {
    logger.warn('Upload queue building up', { pending: stats.pending, size: stats.size });
  }
});

uploadQueue.on('next', () => {
  const stats = getQueueStats();
  logger.debug('Processing next upload', { pending: stats.pending, size: stats.size });
});

export const enqueueUpload = <T>(task: () => Promise<T>): Promise<T> => {
  return uploadQueue.add(task);
};

export const getQueueStats = () => ({
  pending: uploadQueue.pending,
  size: uploadQueue.size,
});

export const getQueueSize = (): number => uploadQueue.size;

export const getPendingCount = (): number => uploadQueue.pending;

export const clearQueue = async (): Promise<void> => {
  uploadQueue.clear();
  await uploadQueue.onIdle();
};

export const waitForQueue = async (): Promise<void> => {
  await uploadQueue.onIdle();
};
