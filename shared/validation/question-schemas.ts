import { z } from "zod/v4";

// Codes mirror the qf_kind / qf_status / qf_owner LOV sets seeded in
// drizzle/0004_curvy_dakota_north.sql. LOV is the source of truth for
// display labels (pt-BR); these enums are the source of truth for which
// codes are valid. Keep them in sync when adding new codes.

export const QuestionKind = z.enum(["question", "bug", "feedback"]);
export const QuestionStatus = z.enum(["open", "answered", "closed", "wont_fix"]);
export const QuestionRole = z.enum(["po", "se", "dev", "ai"]);

// `feature` is a free-text tag (lowercase slug) — not a closed enum, since
// the set grows as the product evolves. The UI auto-suggests existing values
// via a distinct-values query.
export const QuestionFeature = z.string().trim().min(1).max(50);

export const CreateQuestionInput = z.object({
  kind: QuestionKind,
  feature: QuestionFeature.optional(),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  owner: QuestionRole,
  author: QuestionRole,
});

export const UpdateQuestionInput = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(10_000).optional(),
  feature: QuestionFeature.nullable().optional(),
  owner: QuestionRole.optional(),
  status: QuestionStatus.optional(),
});

export const AnswerQuestionInput = z.object({
  id: z.string().uuid(),
  answer: z.string().trim().min(1).max(10_000),
  answeredBy: QuestionRole,
  status: QuestionStatus.default("answered"),
});

export const ListQuestionsInput = z
  .object({
    status: QuestionStatus.optional(),
    kind: QuestionKind.optional(),
    owner: QuestionRole.optional(),
    feature: QuestionFeature.optional(),
  })
  .optional();
