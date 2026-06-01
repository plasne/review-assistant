import { describe, expect, it } from 'vitest';
import { buildRenderTree, validateRecord } from '../../src/main/schema';

const qaSchema = {
  type: 'object',
  properties: {
    persona: {
      type: 'string',
      description: 'The persona that might ask this question.',
      enum: ['TPM', 'developer', 'SME']
    },
    question: {
      type: 'string',
      description: 'The question that was asked.'
    },
    answer: {
      type: 'string',
      description: 'The answer that the agent gave.'
    },
    evidence: {
      type: 'array',
      description: 'The evidence that was found to support the answer.',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          uri: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['id', 'source', 'uri', 'content']
      }
    }
  },
  required: ['question', 'evidence']
};

const releaseReadinessSchema = {
  type: 'object',
  properties: {
    service: {
      type: 'string',
      description: 'The service being reviewed.'
    },
    rolloutStage: {
      type: 'string',
      enum: ['design', 'canary', 'production']
    },
    checks: {
      type: 'array',
      description: 'Release readiness checks for this project.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'warn', 'fail'] },
          owner: { type: 'string' }
        },
        required: ['name', 'status']
      }
    }
  },
  required: ['service', 'rolloutStage']
};

const evidenceExamples = [
  { id: '1', source: 'docs', uri: 'https://example.com/docs', content: 'primary supporting content' },
  { id: '2', source: 'runbook', uri: 'https://example.com/runbook', content: 'secondary supporting content' }
];

const projectSchemaExamples = [
  {
    name: 'question-answer project',
    schema: qaSchema,
    data: {
      persona: 'developer',
      question: 'What changed?',
      answer: 'The app renders schema fields.',
      evidence: evidenceExamples
    },
    expectedContent: 'secondary supporting content'
  },
  {
    name: 'release-readiness project',
    schema: releaseReadinessSchema,
    data: {
      service: 'Dial Gateway',
      rolloutStage: 'canary',
      checks: [
        { name: 'Dashboards configured', status: 'pass', owner: 'SRE' },
        { name: 'Runbook updated', status: 'warn', owner: 'TPM' }
      ]
    },
    expectedContent: 'Runbook updated'
  }
];

describe('schema validation and rendering', () => {
  it.each(projectSchemaExamples)('renders the $name schema as read-only structured details', ({ schema, data, expectedContent }) => {
    const issues = validateRecord(schema, data);
    const tree = buildRenderTree(schema, data, issues);
    expect(issues).toEqual([]);
    expect(tree.kind).toBe('object');
    expect(JSON.stringify(tree)).toContain(expectedContent);
  });

  it('requires evidence to be an array of evidence objects', () => {
    const issues = validateRecord(qaSchema, {
      question: 'What changed?',
      evidence: { id: '1', source: 'docs', uri: 'https://example.com/docs', content: 'content' }
    });
    expect(issues.map((issue) => issue.keyword)).toContain('type');
  });

  it('validates each evidence example object', () => {
    const issues = validateRecord(qaSchema, {
      question: 'What changed?',
      evidence: [{ id: '1', source: 'docs', uri: 'https://example.com/docs' }]
    });
    expect(issues.map((issue) => issue.keyword)).toContain('required');
    expect(issues.map((issue) => issue.path)).toContain('/evidence/0');
  });

  it('requires between 1 and 10 evidence examples', () => {
    const noEvidenceIssues = validateRecord(qaSchema, {
      question: 'What changed?',
      evidence: []
    });
    const tooMuchEvidenceIssues = validateRecord(qaSchema, {
      question: 'What changed?',
      evidence: Array.from({ length: 11 }, (_, index) => ({
        id: String(index),
        source: 'docs',
        uri: `https://example.com/docs/${index}`,
        content: 'content'
      }))
    });
    expect(noEvidenceIssues.map((issue) => issue.keyword)).toContain('minItems');
    expect(tooMuchEvidenceIssues.map((issue) => issue.keyword)).toContain('maxItems');
  });

  it('surfaces validation issues', () => {
    const issues = validateRecord(qaSchema, { persona: 'analyst' });
    expect(issues.map((issue) => issue.keyword)).toContain('required');
    expect(issues.map((issue) => issue.keyword)).toContain('enum');
  });

  it('falls back to raw read-only rendering for complex constructs while preserving validation', () => {
    const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    const issues = validateRecord(schema, true);
    const tree = buildRenderTree(schema, true, issues);
    expect(tree.kind).toBe('raw');
    expect(issues.length).toBeGreaterThan(0);
  });
});
