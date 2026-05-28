import { config } from '../env';

export const extractClientIp = (req: Request): string => {
  if (!config.trustProxy) return '127.0.0.1';

  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const firstIp = forwardedFor.split(',')[0]?.trim();
    if (firstIp) return firstIp;
  }

  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  return '127.0.0.1';
};
