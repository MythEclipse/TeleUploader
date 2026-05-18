export const enqueueUpload = <T>(task: () => Promise<T>): Promise<T> => {
  return task();
};
