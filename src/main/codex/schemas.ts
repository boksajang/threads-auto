import { z } from 'zod';
import { QUALITY_VETOES } from '../../shared/domain';

export const agentResultSchema = z.object({
  decision: z.enum(['PASS', 'REJECT', 'SKIP']),
  reason: z.string().max(500),
  vetoes: z.array(z.enum(QUALITY_VETOES)).max(12).default([]),
  content: z.string().max(5000).nullish().transform((value) => value ?? undefined),
  topic: z.string().max(500).nullish().transform((value) => value ?? undefined),
  angle: z.string().max(500).nullish().transform((value) => value ?? undefined),
  sourceUrls: z.array(z.string().url()).max(20).default([]),
  imageUrl: z.string().url().max(2000).nullish().transform((value) => value ?? undefined),
  sameMeaningAs: z.string().max(200).nullish().transform((value) => value ?? undefined),
});

export const agentResultJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason', 'vetoes', 'content', 'topic', 'angle', 'sourceUrls', 'imageUrl', 'sameMeaningAs'],
  properties: {
    decision: { type: 'string', enum: ['PASS', 'REJECT', 'SKIP'] },
    reason: { type: 'string', maxLength: 500 },
    vetoes: { type: 'array', maxItems: 12, items: { type: 'string', enum: QUALITY_VETOES } },
    content: { type: ['string', 'null'], maxLength: 5000 },
    topic: { type: ['string', 'null'], maxLength: 500 },
    angle: { type: ['string', 'null'], maxLength: 500 },
    sourceUrls: { type: 'array', maxItems: 20, items: { type: 'string' } },
    imageUrl: { type: ['string', 'null'], maxLength: 2000 },
    sameMeaningAs: { type: ['string', 'null'], maxLength: 200 },
  },
} as const;
