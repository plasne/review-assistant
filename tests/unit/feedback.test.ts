import { describe, expect, it } from 'vitest';
import {
  createFeedbackEntry,
  deriveFeedbackTargets,
  extractFeedbackHistory,
  feedbackConfigEntryForPath,
  getProjectUser,
  mergeFeedbackEntries,
  normalizeFeedbackConfig,
  stripFeedbackProperties
} from '../../src/shared/feedback';

const schema = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    answer: { type: 'string' },
    request: {
      type: 'object',
      properties: {
        original_query: { type: 'string' }
      }
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source: { type: 'string' }
        }
      }
    },
    tags: {
      type: 'array',
      items: { type: 'string' }
    }
  }
};

describe('feedback helpers', () => {
  it('derives schema-backed feedback targets and ignores stale config entries', () => {
    expect(deriveFeedbackTargets(schema)).toEqual([
      { path: '/question', target: 'Question', tab: 'Main', editMode: 'none' },
      { path: '/answer', target: 'Answer', tab: 'Main', editMode: 'none' },
      { path: '/request', target: 'Request', tab: 'Main', editMode: 'none' },
      { path: '/request/original_query', target: 'Request > Original Query', tab: 'inherit', editMode: 'none' },
      { path: '/evidence', target: 'Evidence', tab: 'Main' },
      { path: '/evidence/*', target: 'Evidence > *', tab: 'inherit' },
      { path: '/evidence/*/id', target: 'Evidence > Id', tab: 'inherit', editMode: 'none' },
      { path: '/evidence/*/source', target: 'Evidence > Source', tab: 'inherit', editMode: 'none' },
      { path: '/tags', target: 'Tags', tab: 'Main', editMode: 'none' }
    ]);

    expect(
      normalizeFeedbackConfig(schema, {
        properties: {
          '/answer': { path: '/answer', target: 'Answer', tab: 'Review', feedback: 'good_fair_bad', comments: true, editMode: 'logged' },
          '/missing': { path: '/missing', target: 'Missing', tab: 'Main', feedback: 'stars_5', comments: true, editMode: 'logged' }
        }
      })
    ).toEqual({
      properties: expect.objectContaining({
        '/answer': expect.objectContaining({
          path: '/answer',
          target: 'Answer',
          tab: 'Review',
          feedback: 'good_fair_bad',
          comments: true,
          editMode: 'logged'
        })
      })
    });
  });

  it('matches configured array item targets against concrete record paths', () => {
    const config = normalizeFeedbackConfig(schema, {
      properties: {
        '/evidence/*': { path: '/evidence/*', target: 'Evidence > *', tab: 'Main', feedback: 'stars_5', comments: true, editMode: 'none' },
        '/evidence/*/id': { path: '/evidence/*/id', target: 'Evidence > Id', tab: 'Main', feedback: 'thumbs', comments: true, editMode: 'none' }
      }
    });

    expect(feedbackConfigEntryForPath(config, '/evidence/0')).toMatchObject({ path: '/evidence/*', feedback: 'stars_5', comments: true });
    expect(feedbackConfigEntryForPath(config, '/evidence/0/id')).toMatchObject({ path: '/evidence/*/id', feedback: 'thumbs', comments: true });
    expect(feedbackConfigEntryForPath(config, '/evidence/not-a-number')).toBeUndefined();
    expect(feedbackConfigEntryForPath(config, '/evidence/not-a-number/id')).toBeUndefined();
  });

  it('keeps object array containers read-only but allows string arrays to be editable', () => {
    const config = normalizeFeedbackConfig(schema, {
      properties: {
        '/evidence': { path: '/evidence', target: 'Evidence', tab: 'Main', feedback: 'none', comments: false, editMode: 'inline' },
        '/evidence/*': { path: '/evidence/*', target: 'Evidence > *', tab: 'inherit', feedback: 'none', comments: false, editMode: 'inline' },
        '/evidence/*/id': { path: '/evidence/*/id', target: 'Evidence > Id', tab: 'inherit', feedback: 'none', comments: false, editMode: 'inline' },
        '/tags': { path: '/tags', target: 'Tags', tab: 'Main', feedback: 'none', comments: false, editMode: 'inline' }
      }
    });

    expect(config.properties['/evidence'].editMode).toBeUndefined();
    expect(config.properties['/evidence/*'].editMode).toBeUndefined();
    expect(config.properties['/evidence/*/id']).toMatchObject({ editMode: 'inline' });
    expect(config.properties['/tags']).toMatchObject({ editMode: 'inline' });
    expect(config.properties['/tags/*']).toBeUndefined();
  });

  it('allows canonical tags arrays without item schemas to be editable when mapped as tags', () => {
    const config = normalizeFeedbackConfig(
      {
        type: 'object',
        properties: {
          tags: { type: 'array' }
        }
      },
      {
        properties: {
          '/tags': { path: '/tags', target: 'Tags', tab: 'Main', feedback: 'none', comments: false, mapping: 'tags' }
        }
      }
    );

    expect(config.properties['/tags']).toMatchObject({ mapping: 'tags', editMode: 'none' });
    expect(config.properties['/tags'].presentation).toBeUndefined();
  });

  it('keeps canonical tags object arrays non-editable when mapped as tags', () => {
    const config = normalizeFeedbackConfig(
      {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' }
              }
            }
          }
        }
      },
      {
        properties: {
          '/tags': { path: '/tags', target: 'Tags', tab: 'Main', feedback: 'none', comments: false, mapping: 'tags', editMode: 'inline' }
        }
      }
    );

    expect(config.properties['/tags']).toMatchObject({ mapping: 'tags' });
    expect(config.properties['/tags'].editMode).toBeUndefined();
    expect(config.properties['/tags/*']).toBeDefined();
  });

  it('drops canonical mappings from whole array item targets', () => {
    const config = normalizeFeedbackConfig(schema, {
      properties: {
        '/evidence': { path: '/evidence', target: 'Evidence', tab: 'Main', feedback: 'none', comments: false, mapping: 'evidence' },
        '/evidence/*': { path: '/evidence/*', target: 'Evidence > *', tab: 'inherit', feedback: 'none', comments: false, mapping: 'tags' },
        '/evidence/*/id': { path: '/evidence/*/id', target: 'Evidence > Id', tab: 'inherit', feedback: 'none', comments: false, mapping: 'facts' }
      }
    });

    expect(config.properties['/evidence'].mapping).toBe('evidence');
    expect(config.properties['/evidence/*'].mapping).toBeUndefined();
    expect(config.properties['/evidence/*/id'].mapping).toBe('facts');
  });

  it('writes logged edits for string arrays as arrays', () => {
    const record: Record<string, unknown> = {
      tags: []
    };
    mergeFeedbackEntries(
      record,
      { propertyPath: '/tags', editValue: 'intent:greetings\nsource:sme' },
      'alice@example.com',
      new Date('2026-06-01T15:00:00.000Z')
    );

    expect(record.tags).toEqual(['intent:greetings', 'source:sme']);
    expect(record._feedback_tags).toMatchObject([{ original: '[]' }, { edit: 'intent:greetings\nsource:sme', username: 'alice@example.com' }]);
  });

  it('validates USERNAME and creates attributed timestamped entries', () => {
    expect(getProjectUser({ USERNAME: 'alice@example.com' })).toEqual({ username: 'alice@example.com', valid: true });
    expect(getProjectUser({ USERNAME: 'alice example' })).toMatchObject({ valid: false });
    expect(createFeedbackEntry('good', 'alice@example.com', new Date('2026-06-01T14:32:15.000Z'))).toEqual({
      value: 'good',
      username: 'alice@example.com',
      timestamp: '2026-06-01T14:32:15.000Z'
    });
  });

  it('merges feedback arrays and strips feedback properties recursively from core data', () => {
    const record: Record<string, unknown> = {
      question: 'What?',
      answer: 'Answer',
      nested: { _feedback_answer: [{ feedback: 'bad', username: 'sme@example.com', timestamp: '2026-06-01T14:32:15.000Z' }] }
    };
    mergeFeedbackEntries(
      record,
      { propertyPath: '/answer', feedbackValue: 'good', commentValue: 'Useful', editValue: 'Better answer' },
      'alice@example.com',
      new Date('2026-06-01T15:00:00.000Z')
    );

    expect(record._feedback_answer).toMatchObject([
      { original: 'Answer' },
      { feedback: 'good', comment: 'Useful', edit: 'Better answer', username: 'alice@example.com' }
    ]);
    expect(stripFeedbackProperties(record)).toEqual({ question: 'What?', answer: 'Better answer', nested: {} });
    const history = extractFeedbackHistory(record, [{ path: '/answer', target: 'Answer', tab: 'Main', editMode: 'none' }]);
    expect(history['/answer'].original).toBe('Answer');
    expect(history['/answer'].feedback[0]).toMatchObject({ value: 'good', username: 'alice@example.com' });
    expect(history['/answer'].comments[0]).toMatchObject({ value: 'Useful', username: 'alice@example.com' });
    expect(history['/answer'].edits[0]).toMatchObject({ value: 'Better answer', username: 'alice@example.com' });

    mergeFeedbackEntries(
      record,
      { propertyPath: '/answer', editValue: 'Best answer' },
      'bob@example.com',
      new Date('2026-06-01T16:00:00.000Z')
    );
    expect(record.answer).toBe('Best answer');
    expect(record._feedback_answer).toMatchObject([
      { original: 'Answer' },
      { feedback: 'good', comment: 'Useful', edit: 'Better answer', username: 'alice@example.com' },
      { edit: 'Best answer', username: 'bob@example.com' }
    ]);
  });

  it('extracts feedback history for concrete array item paths from wildcard targets', () => {
    const record: Record<string, unknown> = {
      evidence: [{ id: 'doc-1' }],
      _feedback_evidence__0: [{ feedback: 'fair', comment: 'Partially relevant', username: 'alice@example.com', timestamp: '2026-06-01T14:00:00.000Z' }],
      _feedback_evidence__0__id: [{ feedback: 'good', comment: 'Relevant', username: 'alice@example.com', timestamp: '2026-06-01T15:00:00.000Z' }]
    };

    const history = extractFeedbackHistory(record, [
      { path: '/evidence/*', target: 'Evidence > *', tab: 'inherit', editMode: 'none' },
      { path: '/evidence/*/id', target: 'Evidence > Id', tab: 'inherit', editMode: 'none' }
    ]);
    expect(history['/evidence/0'].feedback[0]).toMatchObject({ value: 'fair', username: 'alice@example.com' });
    expect(history['/evidence/0'].comments[0]).toMatchObject({ value: 'Partially relevant', username: 'alice@example.com' });
    expect(history['/evidence/0/id'].feedback[0]).toMatchObject({ value: 'good', username: 'alice@example.com' });
    expect(history['/evidence/0/id'].comments[0]).toMatchObject({ value: 'Relevant', username: 'alice@example.com' });
  });

  it('reads consolidated feedback property with mixed entry types', () => {
    const record: Record<string, unknown> = {
      _feedback_answer: [
        { feedback: 'good', username: 'alice@example.com', timestamp: '2026-06-01T15:00:00.000Z' },
        { comment: 'Useful', username: 'alice@example.com', timestamp: '2026-06-01T15:01:00.000Z' },
        { edit: 'Better answer', username: 'alice@example.com', timestamp: '2026-06-01T15:02:00.000Z' }
      ]
    };

    const history = extractFeedbackHistory(record, [{ path: '/answer', target: 'Answer', tab: 'Main', editMode: 'none' }]);
    expect(history['/answer'].feedback[0]).toMatchObject({ value: 'good', username: 'alice@example.com' });
    expect(history['/answer'].comments[0]).toMatchObject({ value: 'Useful', username: 'alice@example.com' });
    expect(history['/answer'].edits[0]).toMatchObject({ value: 'Better answer', username: 'alice@example.com' });
  });
});
