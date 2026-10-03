import type { SourceCandidate } from '../../shared/domain';

// Only content facts belong in model context. Queue IDs, image lists and research
// bookkeeping remain in storage; repeating them across every stage costs tokens.
export function sourceMetadataForPrompt(metadata: Record<string, unknown>): Record<string, unknown> {
  const keys = ['channelId', 'durationSeconds', 'format', 'productName', 'categoryName', 'categoryId', 'brandId',
    'price', 'isRocket', 'isFreeShipping', 'isRocketFresh', 'isGoldBox', 'isCategoryBest', 'isCoupangPl'];
  return Object.fromEntries(keys.flatMap<[string, unknown]>((key) => {
    const value = metadata[key];
    if (typeof value === 'string') return [[key, value.slice(0, 500)]];
    return typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : [];
  }));
}

export function sourceForAgent(source?: SourceCandidate) {
  if (!source) return undefined;
  const facts = Array.isArray(source.metadata.productFacts)
    ? [...new Set(source.metadata.productFacts.filter((fact): fact is string => typeof fact === 'string').map((fact) => fact.trim()).filter(Boolean))]
    : [];
  const note = typeof source.metadata.productNote === 'string' ? source.metadata.productNote.trim() : '';
  const evidenceLines = new Set([...facts, note].flatMap((value) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
  const summaryLines = source.summary?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
  const repeatedSummary = summaryLines.length > 0 && summaryLines.every((line) => evidenceLines.has(line));
  return {
    sourceType: source.sourceType,
    sourceKey: source.sourceKey.slice(0, 500),
    sourceUrl: source.sourceUrl,
    publishedAt: source.publishedAt,
    title: source.title.slice(0, 500),
    summary: repeatedSummary ? undefined : source.summary?.slice(0, 4_000),
    productFacts: facts.length ? facts.slice(0, 60).map((fact) => fact.slice(0, 500)) : undefined,
    productNote: repeatedSummary && note ? note.slice(0, 2_000) : undefined,
    metadata: sourceMetadataForPrompt(source.metadata),
    imageUrl: source.imageUrl,
    imageCount: source.imageUrls?.length ?? (source.imageUrl ? 1 : 0),
    reviewEvidence: source.reviewEvidence?.slice(0, 8).map((review) => ({
      text: review.text.slice(0, 1_000), option: review.option?.slice(0, 500), rating: review.rating,
    })),
  };
}
