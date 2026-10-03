import type { Account, SourceType } from '../../shared/domain';

export function selectContentMode(account: Account, recentTypes: SourceType[], promotionAvailable: boolean): 'DAILY' | 'PROMOTION' | undefined {
  if (account.dailyEnabled && !account.promotionEnabled) return 'DAILY';
  if (!account.dailyEnabled && account.promotionEnabled) return promotionAvailable ? 'PROMOTION' : undefined;
  if (!promotionAvailable) return 'DAILY';
  const windowSize = Math.max(1, account.dailyRatio + account.promotionRatio);
  const recent = recentTypes.slice(0, windowSize);
  const dailyCount = recent.filter((type) => type === 'DAILY').length;
  const promotionCount = recent.length - dailyCount;
  const dailyDeficit = account.dailyRatio / windowSize - dailyCount / Math.max(1, recent.length);
  const promotionDeficit = account.promotionRatio / windowSize - promotionCount / Math.max(1, recent.length);
  return promotionDeficit > dailyDeficit ? 'PROMOTION' : 'DAILY';
}
