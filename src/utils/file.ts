const FILE_TYPES: Record<string, number> = {
  document: 2 * 1024 * 1024 * 1024, // 2GB
  photo: 10 * 1024 * 1024, // 10MB
  video: 2 * 1024 * 1024 * 1024, // 2GB
  audio: 200 * 1024 * 1024, // 200MB
  voice: 200 * 1024 * 1024, // 200MB
  animation: 2 * 1024 * 1024 * 1024 // 2GB
};

export const getFileType = (mime: string | null, caption?: string): string => {
  const mimeUpper = mime?.split('/')[0]?.toLowerCase();
  const captionLower = caption?.toLowerCase();

  if (mimeUpper === 'video') return 'video';
  if (mimeUpper === 'audio') return 'audio';
  if (mimeUpper === 'document') return 'document';
  if (mimeUpper === 'image') return captionLower?.includes('gif') ? 'animation' : 'photo';
  if (captionLower?.includes('voice')) return 'voice';
  if (captionLower?.includes('animation')) return 'animation';

  return mimeUpper || 'document';
};

export const checkFileSize = (sizeBytes: number, fileType: string): boolean => {
  const limit = FILE_TYPES[fileType] || FILE_TYPES.document;
  return sizeBytes <= limit;
};

export const extractFileName = (msg: any, request: any): string => {
  if (request?.headers?.['x-file-name']) {
    return request.headers['x-file-name'];
  }
  return msg.document?.fileName || msg.photo?.slice(-1)[0]?.fileName || msg.audio?.fileName ||
         msg.voice?.fileName || msg.animation?.fileName || 'file';
};

export const extractMimeType = (msg: any, request: any): string => {
  if (request?.headers?.['x-mime-type']) {
    return request.headers['x-mime-type'];
  }
  return msg.document?.mimeType || msg.photo?.slice(-1)[0]?.mimeType || msg.audio?.mimeType ||
         msg.voice?.mimeType || msg.animation?.mimeType || 'application/octet-stream';
};
