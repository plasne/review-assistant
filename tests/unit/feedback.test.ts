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
    }
  }
};

describe('feedback helpers', () => {
  it('derives schema-backed feedback targets and ignores stale config entries', () => {
    expect(deriveFeedbackTargets(schema)).toEqual([
      { path: '/question', target: 'Question', tab: 'Main', supportsEdit: true },
      { path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true },
      { path: '/request', target: 'Request', tab: 'Main', supportsEdit: true },
      { path: '/request/original_query', target: 'Request > Original Query', tab: 'inherit', supportsEdit: true },
      { path: '/evidence', target: 'Evidence', tab: 'Main', supportsEdit: false },
      { path: '/evidence/~2/id', target: 'Evidence > Id', tab: 'inherit', supportsEdit: true },
      { path: '/evidence/~2/source', target: 'Evidence > Source', tab: 'inherit', supportsEdit: true }
    ]);

    expect(
      normalizeFeedbackConfig(schema, {
        properties: {
          '/answer': { path: '/answer', target: 'Answer', tab: 'Review', feedback: 'good_fair_bad', comments: true, editable: true },
          '/missing': { path: '/missing', target: 'Missing', tab: 'Main', feedback: 'stars_5', comments: true, editable: true }
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
          editable: true
        })
      })
    });
  });

  it('matches configured array item targets against concrete record paths', () => {
    const config = normalizeFeedbackConfig(schema, {
      properties: {
        '/evidence/~2/id': { path: '/evidence/~2/id', target: 'Evidence > Id', tab: 'Main', feedback: 'thumbs', comments: true, editable: false }
      }
    });

    expect(feedbackConfigEntryForPath(config, '/evidence/0/id')).toMatchObject({ path: '/evidence/~2/id', feedback: 'thumbs', comments: true });
    expect(feedbackConfigEntryForPath(config, '/evidence/not-a-number/id')).toBeUndefined();
  });

  it('does not allow array targets to be configured as editable', () => {
    const config = normalizeFeedbackConfig(schema, {
      properties: {
        '/evidence': { path: '/evidence', target: 'Evidence', tab: 'Main', feedback: 'none', comments: false, editable: true }
      }
    });

    expect(config.properties['/evidence']).toMatchObject({ supportsEdit: false, editable: false });
    expect(config.properties['/evidence/~2/id']).toMatchObject({ supportsEdit: true });
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
      nested: { answer_feedback: [{ feedback: 'bad', username: 'sme@example.com', timestamp: '2026-06-01T14:32:15.000Z' }] }
    };
    mergeFeedbackEntries(
      record,
      { propertyPath: '/answer', feedbackValue: 'good', commentValue: 'Useful', editValue: 'Better answer' },
      'alice@example.com',
      new Date('2026-06-01T15:00:00.000Z')
    );

    expect(record.answer_feedback).toMatchObject([
      { feedback: 'good', comment: 'Useful', edit: 'Better answer', username: 'alice@example.com' }
    ]);
    expect(record.answer_comments).toBeUndefined();
    expect(record.answer_edits).toBeUndefined();
    expect(stripFeedbackProperties(record)).toEqual({ question: 'What?', answer: 'Answer', nested: {} });
    const history = extractFeedbackHistory(record, [{ path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true }]);
    expect(history['/answer'].feedback[0]).toMatchObject({ value: 'good', username: 'alice@example.com' });
    expect(history['/answer'].comments[0]).toMatchObject({ value: 'Useful', username: 'alice@example.com' });
    expect(history['/answer'].edits[0]).toMatchObject({ value: 'Better answer', username: 'alice@example.com' });
  });

  it('extracts feedback history for concrete array item paths from wildcard targets', () => {
    const record: Record<string, unknown> = {
      evidence: [{ id: 'doc-1' }],
      evidence__0__id_feedback: [{ feedback: 'good', comment: 'Relevant', username: 'alice@example.com', timestamp: '2026-06-01T15:00:00.000Z' }]
    };

    const history = extractFeedbackHistory(record, [{ path: '/evidence/~2/id', target: 'Evidence > Id', tab: 'inherit', supportsEdit: true }]);
    expect(history['/evidence/0/id'].feedback[0]).toMatchObject({ value: 'good', username: 'alice@example.com' });
    expect(history['/evidence/0/id'].comments[0]).toMatchObject({ value: 'Relevant', username: 'alice@example.com' });
  });

  it('reads legacy split feedback properties', () => {
    const record: Record<string, unknown> = {
      answer_feedback: [{ value: 'good', username: 'alice@example.com', timestamp: '2026-06-01T15:00:00.000Z' }],
      answer_comments: [{ value: 'Useful', username: 'alice@example.com', timestamp: '2026-06-01T15:01:00.000Z' }],
      answer_edits: [{ value: 'Better answer', username: 'alice@example.com', timestamp: '2026-06-01T15:02:00.000Z' }]
    };

    const history = extractFeedbackHistory(record, [{ path: '/answer', target: 'Answer', tab: 'Main', supportsEdit: true }]);
    expect(history['/answer'].feedback[0]).toMatchObject({ value: 'good', username: 'alice@example.com' });
    expect(history['/answer'].comments[0]).toMatchObject({ value: 'Useful', username: 'alice@example.com' });
    expect(history['/answer'].edits[0]).toMatchObject({ value: 'Better answer', username: 'alice@example.com' });
  });
});
