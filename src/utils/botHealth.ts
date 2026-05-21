import logger from './logger';

interface BotHealth {
  index: number;
  isHealthy: boolean;
  rateLimitedUntil: number;
  failureCount: number;
  successCount: number;
  lastUsed: number;
}

class BotHealthTracker {
  private botHealth: Map<number, BotHealth> = new Map();
  private totalBots: number;

  constructor(totalBots: number) {
    this.totalBots = totalBots;
    for (let i = 0; i < totalBots; i++) {
      this.botHealth.set(i, {
        index: i,
        isHealthy: true,
        rateLimitedUntil: 0,
        failureCount: 0,
        successCount: 0,
        lastUsed: 0,
      });
    }
  }

  recordSuccess(botIndex: number): void {
    const health = this.botHealth.get(botIndex);
    if (health) {
      health.successCount++;
      health.failureCount = 0;
      health.isHealthy = true;
      health.lastUsed = Date.now();
    }
  }

  recordFailure(botIndex: number, retryAfterSeconds?: number): void {
    const health = this.botHealth.get(botIndex);
    if (health) {
      health.failureCount++;
      health.lastUsed = Date.now();

      if (retryAfterSeconds) {
        health.rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;
        health.isHealthy = false;
        logger.warn('Bot rate limited', {
          botIndex,
          retryAfter: retryAfterSeconds,
        });
      } else if (health.failureCount >= 3) {
        health.isHealthy = false;
        logger.warn('Bot marked unhealthy', { botIndex, failures: health.failureCount });
      }
    }
  }

  getHealthiestBot(): number {
    const now = Date.now();
    let bestBot = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < this.totalBots; i++) {
      const health = this.botHealth.get(i)!;

      // Skip rate-limited bots
      if (health.rateLimitedUntil > now) {
        continue;
      }

      // Calculate score: prefer healthy bots with fewer failures and more successes
      const score =
        (health.isHealthy ? 100 : 0) +
        health.successCount -
        health.failureCount * 10 -
        (now - health.lastUsed) / 1000;

      if (score > bestScore) {
        bestScore = score;
        bestBot = i;
      }
    }

    return bestBot;
  }

  getStats() {
    const stats = {
      healthy: 0,
      rateLimited: 0,
      unhealthy: 0,
      bots: [] as any[],
    };

    const now = Date.now();
    for (const health of this.botHealth.values()) {
      if (health.rateLimitedUntil > now) {
        stats.rateLimited++;
      } else if (health.isHealthy) {
        stats.healthy++;
      } else {
        stats.unhealthy++;
      }

      stats.bots.push({
        index: health.index,
        healthy: health.isHealthy,
        rateLimitedUntil: health.rateLimitedUntil > now ? health.rateLimitedUntil - now : 0,
        failures: health.failureCount,
        successes: health.successCount,
      });
    }

    return stats;
  }

  reset(): void {
    for (const health of this.botHealth.values()) {
      health.isHealthy = true;
      health.rateLimitedUntil = 0;
      health.failureCount = 0;
      health.successCount = 0;
    }
  }
}

export { BotHealthTracker };
