import { z } from 'zod';

const issueContentSchema = z.object({
  __typename: z.literal('Issue'),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  repository: z.object({
    nameWithOwner: z.string(),
  }),
});

const otherContentSchema = z.object({
  __typename: z.string(),
});

const itemContentSchema = z.union([issueContentSchema, otherContentSchema]).nullable();

export type IssueContent = z.infer<typeof issueContentSchema>;

const singleSelectFieldValueSchema = z.object({
  __typename: z.literal('ProjectV2ItemFieldSingleSelectValue'),
  name: z.string().nullable(),
  field: z.object({
    __typename: z.string(),
    name: z.string().optional(),
  }),
});

const otherFieldValueSchema = z.object({
  __typename: z.string(),
});

const fieldValueSchema = z.union([singleSelectFieldValueSchema, otherFieldValueSchema]);

const projectItemSchema = z.object({
  id: z.string(),
  content: itemContentSchema,
  fieldValues: z.object({
    nodes: z.array(fieldValueSchema),
  }),
});

const projectV2Schema = z.object({
  id: z.string(),
  title: z.string(),
  items: z.object({
    nodes: z.array(projectItemSchema),
  }),
});

const projectOwnerSchema = z
  .object({
    __typename: z.string(),
    projectV2: projectV2Schema.nullable(),
  })
  .nullable();

export const projectItemsResponseSchema = z.object({
  repositoryOwner: projectOwnerSchema,
});

export type ProjectItemsResponse = z.infer<typeof projectItemsResponseSchema>;
export type ProjectItem = z.infer<typeof projectItemSchema>;
export type ProjectItemContent = z.infer<typeof itemContentSchema>;
export type ProjectItemFieldValue = z.infer<typeof fieldValueSchema>;

export type Candidate = {
  itemId: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueState: 'OPEN' | 'CLOSED';
  repositoryNameWithOwner: string;
  status: string | null;
};
