const FILE_TYPES: Record<string, number> = {
  document: 2 * 1024 * 1024 * 1024, // 2GB
  photo: 10 * 1024 * 1024, // 10MB
  video: 2 * 1024 * 1024 * 1024, // 2GB
  audio: 200 * 1024 * 1024, // 200MB
  voice: 200 * 1024 * 1024, // 200MB
  animation: 2 * 1024 * 1024 * 1024, // 2GB
  sticker: 10 * 1024 * 1024, // 10MB
  video_note: 2 * 1024 * 1024 * 1024, // 2GB
};

export const getFileType = (mime: string | null, caption?: string): string => {
  const mimeUpper = mime?.split('/')[0]?.toLowerCase();
  const captionLower = caption?.toLowerCase();

  if (mime?.toLowerCase() === 'image/webp' || captionLower?.includes('sticker')) return 'sticker';
  if (captionLower?.includes('video_note')) return 'video_note';
  if (mimeUpper === 'video') return 'video';
  if (mimeUpper === 'audio') return 'audio';
  if (mimeUpper === 'document') return 'document';
  if (mimeUpper === 'image') return captionLower?.includes('gif') ? 'animation' : 'photo';
  if (captionLower?.includes('voice')) return 'voice';
  if (captionLower?.includes('animation')) return 'animation';

  return mimeUpper === 'application' ? 'application' : 'document';
};

export const checkFileSize = (sizeBytes: number, fileType: string): boolean => {
  const limit = FILE_TYPES[fileType] || FILE_TYPES.document;
  return sizeBytes <= limit;
};

export const ensureExtension = (
  fileName: string,
  buffer: Buffer,
  detectedMime?: string,
): { fileName: string; mimeType: string } => {
  const mimeMap: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'text/plain': 'txt',
    'application/zip': 'zip',
  };

  let ext: string | null = null;
  if (buffer.subarray(0, 4).toString() === '%PDF') {
    ext = 'pdf';
  } else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    ext = 'png';
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    ext = 'jpg';
  } else if (buffer.subarray(0, 4).toString() === 'GIF8') {
    ext = 'gif';
  } else if (detectedMime) {
    ext = mimeMap[detectedMime.toLowerCase()] || null;
  }

  let finalFileName = fileName;
  const hasExtension = fileName.includes('.') && fileName.split('.').pop()!.length >= 2;
  if (!hasExtension && ext) {
    finalFileName = `${fileName}.${ext}`;
  }

  const mimeType = ext
    ? Object.keys(mimeMap).find((k) => mimeMap[k] === ext) ||
      detectedMime ||
      'application/octet-stream'
    : detectedMime || 'application/octet-stream';

  return { fileName: finalFileName, mimeType };
};

export const extractFileName = (msg: any, request: any): string => {
  if (request?.headers?.['x-file-name']) {
    return request.headers['x-file-name'];
  }
  return (
    msg.document?.fileName ||
    msg.photo?.slice(-1)[0]?.fileName ||
    msg.audio?.fileName ||
    msg.voice?.fileName ||
    msg.animation?.fileName ||
    'file'
  );
};

export const extractMimeType = (msg: any, request: any): string => {
  if (request?.headers?.['x-mime-type']) {
    return request.headers['x-mime-type'];
  }
  return (
    msg.document?.mimeType ||
    msg.photo?.slice(-1)[0]?.mimeType ||
    msg.audio?.mimeType ||
    msg.voice?.mimeType ||
    msg.animation?.mimeType ||
    'application/octet-stream'
  );
};

export const computeHash = (buffer: Buffer): string => {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(buffer);
  return hasher.digest('hex');
};
